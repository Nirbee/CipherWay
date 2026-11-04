import { describe, expect, it } from 'vitest'
import type { RoutingRule, RulesConfig } from './types'
import {
  applyImport,
  isValidCidr,
  parseClashLine,
  parsePortSpec,
  parseRulesText,
  toClashLines
} from './rulesText'

const rule = (r: Partial<RoutingRule>) => ({ enabled: true, action: 'PROXY', ...r })

describe('parseClashLine', () => {
  it('maps every supported Clash type', () => {
    const cases: [string, Partial<RoutingRule>][] = [
      ['DOMAIN,api.example.com,DIRECT', { conditionType: 'Domain', value: 'api.example.com', action: 'DIRECT' }],
      ['DOMAIN-SUFFIX,example.com,Proxy', { conditionType: 'DomainSuffix', value: 'example.com' }],
      ['DOMAIN-KEYWORD,google,🚀 Proxy', { conditionType: 'DomainKeyword', value: 'google' }],
      ['DOMAIN-REGEX,^ads[0-9]{1,3}\\.example\\.com$,REJECT', { conditionType: 'DomainRegex', value: '^ads[0-9]{1,3}\\.example\\.com$', action: 'REJECT' }],
      ['GEOSITE,YouTube,PROXY', { conditionType: 'GeoSite', value: 'youtube' }],
      ['GEOIP,RU,DIRECT,no-resolve', { conditionType: 'GeoIP', value: 'ru', action: 'DIRECT' }],
      ['GEOIP,LAN,DIRECT', { conditionType: 'GeoIP', value: 'private', action: 'DIRECT' }],
      ['IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', { conditionType: 'IPCIDR', value: '10.0.0.0/8', action: 'DIRECT' }],
      ['IP-CIDR6,2001:db8::/32,DIRECT', { conditionType: 'IPCIDR', value: '2001:db8::/32', action: 'DIRECT' }],
      ['PROCESS-NAME,Telegram.exe,PROXY', { conditionType: 'ProcessName', value: 'Telegram.exe' }],
      ['PROCESS-PATH,C:\\Games\\game.exe,DIRECT', { conditionType: 'ProcessPath', value: 'C:\\Games\\game.exe', action: 'DIRECT' }],
      ['DST-PORT,6881-6889,DIRECT', { conditionType: 'DstPort', value: '6881-6889', action: 'DIRECT' }],
      ['DOMAIN-SUFFIX,ads.example.com,REJECT-DROP', { conditionType: 'DomainSuffix', value: 'ads.example.com', action: 'REJECT' }]
    ]
    for (const [line, expected] of cases) {
      expect(parseClashLine(line), line).toEqual({ kind: 'rule', rule: rule(expected) })
    }
  })

  it('MATCH sets the default, comments are ignored', () => {
    expect(parseClashLine('MATCH,DIRECT')).toEqual({ kind: 'match', behavior: 'direct' })
    expect(parseClashLine('MATCH,Proxy')).toEqual({ kind: 'match', behavior: 'proxy' })
    expect(parseClashLine('# DOMAIN,x.com,DIRECT')).toEqual({ kind: 'comment' })
    expect(parseClashLine('   ')).toEqual({ kind: 'comment' })
  })

  it('explains what it cannot use', () => {
    const reason = (l: string) => {
      const r = parseClashLine(l)
      return r.kind === 'skip' ? r.reason : null
    }
    expect(reason('RULE-SET,reject,REJECT')).toBe('тип RULE-SET не поддерживается')
    expect(reason('AND,((DOMAIN,a.com),(NETWORK,UDP)),REJECT')).toBe('тип AND не поддерживается')
    expect(reason('DOMAIN,example.com')).toMatch(/не указано действие/)
    expect(reason('IP-CIDR,999.1.1.1/8,DIRECT')).toBe('неверный IP/подсеть')
    expect(reason('DST-PORT,99999,DIRECT')).toMatch(/неверный порт/)
    expect(reason('DOMAIN-REGEX,(,DIRECT')).toBe('неверное регулярное выражение')
    expect(reason('GEOSITE,google@cn,DIRECT')).toMatch(/атрибуты/)
    expect(reason('hello world')).toBe('не похоже на правило Clash')
  })
})

describe('parseRulesText — plain Clash lines', () => {
  const text = [
    '# мои правила',
    'DOMAIN-SUFFIX,example.com,DIRECT',
    'PROCESS-NAME,Discord.exe,Proxy',
    'SRC-IP-CIDR,192.168.1.2/32,DIRECT',
    'GEOIP,CN,DIRECT,no-resolve',
    'MATCH,Proxy',
    ''
  ].join('\n')
  const res = parseRulesText(text)

  it('keeps order, line numbers and the MATCH default', () => {
    expect(res.format).toBe('clash')
    expect(res.items.map((i) => [i.line, i.rule.conditionType])).toEqual([
      [2, 'DomainSuffix'],
      [3, 'ProcessName'],
      [5, 'GeoIP']
    ])
    expect(res.defaultBehavior).toBe('proxy')
  })

  it('lists skipped lines with their numbers', () => {
    expect(res.skipped).toEqual([
      { line: 4, text: 'SRC-IP-CIDR,192.168.1.2/32,DIRECT', reason: 'тип SRC-IP-CIDR не поддерживается' }
    ])
  })
})

describe('parseRulesText — Koala / Clash Verge YAML', () => {
  const yaml = `# Clash Verge «Rules» enhancement
prepend:
  - 'DOMAIN-SUFFIX,chatgpt.com,🇺🇸 США'
  - "PROCESS-NAME,Telegram.exe,PROXY"
  - DOMAIN-KEYWORD,torrent,DIRECT # торренты мимо
  - RULE-SET,applications,DIRECT
append:
  - MATCH,DIRECT
delete: ['GEOSITE,category-ads-all,REJECT']
`

  it('reads prepend / append / delete lists with quotes and comments', () => {
    const res = parseRulesText(yaml)
    expect(res.format).toBe('yaml')
    expect(res.items).toEqual([
      { line: 3, section: 'prepend', rule: rule({ conditionType: 'DomainSuffix', value: 'chatgpt.com' }) },
      { line: 4, section: 'prepend', rule: rule({ conditionType: 'ProcessName', value: 'Telegram.exe' }) },
      { line: 5, section: 'prepend', rule: rule({ conditionType: 'DomainKeyword', value: 'torrent', action: 'DIRECT' }) }
    ])
    expect(res.defaultBehavior).toBe('direct')
    expect(res.deletions).toEqual([
      rule({ conditionType: 'GeoSite', value: 'category-ads-all', action: 'REJECT' })
    ])
    expect(res.skipped).toEqual([
      { line: 6, text: 'RULE-SET,applications,DIRECT', reason: 'тип RULE-SET не поддерживается' }
    ])
  })

  it('reads the rules: block of a full config and ignores proxies', () => {
    const full = `mixed-port: 7890
proxies:
  - name: node
    type: vless
    server: node.example.com
rules:
  - DOMAIN,example.org,DIRECT
  - GEOIP,RU,DIRECT
  - MATCH,🚀 Proxy
`
    const res = parseRulesText(full)
    expect(res.items.map((i) => [i.section, i.rule.value])).toEqual([
      ['main', 'example.org'],
      ['main', 'ru']
    ])
    expect(res.defaultBehavior).toBe('proxy')
    expect(res.skipped).toEqual([])
  })

  it('flags nested mappings inside a rules list', () => {
    const res = parseRulesText('rules:\n  - DOMAIN,a.com,DIRECT\n  foo: bar\n')
    expect(res.items).toHaveLength(1)
    expect(res.skipped[0]).toMatchObject({ line: 3, reason: 'не строка правила' })
  })
})

describe('parseRulesText — our JSON export', () => {
  it('round-trips the export format', () => {
    const cfg: RulesConfig = {
      defaultBehavior: 'auto',
      rules: [
        { id: 'r1', enabled: true, conditionType: 'GeoSite', value: 'category-ads-all', action: 'REJECT' },
        { id: 'r2', enabled: false, conditionType: 'ProcessName', value: 'firefox.exe', action: 'Германия' }
      ]
    }
    const res = parseRulesText(JSON.stringify(cfg, null, 2))
    expect(res.format).toBe('json')
    expect(res.defaultBehavior).toBe('auto')
    expect(res.items.map((i) => i.rule)).toEqual(cfg.rules.map(({ id: _id, ...r }) => r))
  })

  it('reports broken JSON and unknown entries', () => {
    expect(parseRulesText('{ "rules": [').skipped[0].reason).toMatch(/ошибка JSON/)
    const res = parseRulesText('{"rules":[{"conditionType":"Bogus","value":"x"}, "DOMAIN,a.com,DIRECT"]}')
    expect(res.items).toHaveLength(1)
    expect(res.skipped[0]).toMatchObject({ line: 1, reason: 'неизвестный тип правила' })
  })
})

describe('applyImport', () => {
  const existing: RoutingRule[] = [
    { id: 'e1', enabled: true, conditionType: 'GeoSite', value: 'category-ads-all', action: 'REJECT' },
    { id: 'e2', enabled: true, conditionType: 'Domain', value: 'keep.example', action: 'DIRECT' }
  ]
  let n = 0
  const newId = () => `n${++n}`

  it('start / end / replace, with prepend/append pinned and deletions applied', () => {
    const parsed = parseRulesText(
      'prepend:\n  - DOMAIN,pre.example,DIRECT\nrules:\n  - DOMAIN,main.example,PROXY\nappend:\n  - DOMAIN,post.example,DIRECT\ndelete:\n  - GEOSITE,category-ads-all,REJECT\n'
    )
    const values = (pos: 'start' | 'end' | 'replace') =>
      applyImport(existing, parsed, pos, newId).map((r) => r.value)
    expect(values('start')).toEqual(['pre.example', 'main.example', 'keep.example', 'post.example'])
    expect(values('end')).toEqual(['pre.example', 'keep.example', 'main.example', 'post.example'])
    expect(values('replace')).toEqual(['pre.example', 'main.example', 'post.example'])
  })

  it('gives every new rule a fresh id', () => {
    const out = applyImport([], parseRulesText('DOMAIN,a.com,DIRECT\nDOMAIN,b.com,DIRECT'), 'end', newId)
    expect(new Set(out.map((r) => r.id)).size).toBe(2)
  })
})

describe('toClashLines (export)', () => {
  it('writes Clash lines that import back to the same rules', () => {
    const cfg: RulesConfig = {
      defaultBehavior: 'direct',
      rules: [
        { id: '1', enabled: true, conditionType: 'GeoIP', value: 'private', action: 'DIRECT' },
        { id: '2', enabled: true, conditionType: 'IPCIDR', value: '2001:db8::/32', action: 'DIRECT' },
        { id: '3', enabled: false, conditionType: 'DomainSuffix', value: 'x.example', action: 'PROXY' },
        { id: '4', enabled: true, conditionType: 'DstPort', value: '443', action: 'REJECT' }
      ]
    }
    const text = toClashLines(cfg)
    expect(text).toContain('GEOIP,LAN,DIRECT')
    expect(text).toContain('IP-CIDR6,2001:db8::/32,DIRECT')
    expect(text).toContain('# DOMAIN-SUFFIX,x.example,PROXY')
    expect(text).toContain('DST-PORT,443,REJECT')
    expect(text.trim().endsWith('MATCH,DIRECT')).toBe(true)

    const back = parseRulesText(text)
    expect(back.defaultBehavior).toBe('direct')
    expect(back.items.map((i) => i.rule.value)).toEqual(['private', '2001:db8::/32', '443'])
    expect(back.skipped).toEqual([])
  })

  it('«Авто» becomes explicit LAN/RU rules + MATCH,PROXY', () => {
    const text = toClashLines({ defaultBehavior: 'auto', rules: [] })
    expect(text).toContain('GEOIP,RU,DIRECT')
    expect(text.trim().endsWith('MATCH,PROXY')).toBe(true)
  })
})

describe('validators', () => {
  it('ports', () => {
    expect(parsePortSpec('443')).toEqual({ ports: [443], ranges: [] })
    expect(parsePortSpec('80/443|1000-2000')).toEqual({ ports: [80, 443], ranges: ['1000:2000'] })
    expect(parsePortSpec('')).toBeNull()
    expect(parsePortSpec('0')).toBeNull()
  })

  it('CIDR', () => {
    expect(isValidCidr('192.0.2.0/24')).toBe(true)
    expect(isValidCidr('192.0.2.1')).toBe(true)
    expect(isValidCidr('192.0.2.0/33')).toBe(false)
    expect(isValidCidr('::1/128')).toBe(true)
    expect(isValidCidr('2001:db8::1::2')).toBe(false)
    expect(isValidCidr('example.com')).toBe(false)
  })
})
