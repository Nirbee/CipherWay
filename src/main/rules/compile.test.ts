import { describe, expect, it } from 'vitest'
import type { OutboundConfig, RoutingRule, RulesConfig } from '@shared/types'
import {
  domainOnly,
  escapeRegex,
  geoTag,
  groupsFor,
  layoutRules,
  normalizeCidr,
  planRules,
  portMatcher,
  processNameRegex,
  processPathRegex,
  ruleSkeleton,
  TELEGRAM_CIDRS,
  type HeadlessRule
} from './compile'

const outbounds: OutboundConfig[] = [
  { id: 'ob_a', name: 'Remnawave', protocol: 'vless', server: 'a.com', port: 443 },
  { id: 'ob_b', name: 'Backup', protocol: 'hysteria2', server: 'b.com', port: 8443 }
]

let n = 0
function rule(
  conditionType: RoutingRule['conditionType'],
  value: string,
  action: string
): RoutingRule {
  return { id: `r${++n}`, enabled: true, conditionType, value, action }
}
function cfg(
  rules: RoutingRule[],
  defaultBehavior: RulesConfig['defaultBehavior'] = 'proxy'
): RulesConfig {
  return { defaultBehavior, rules }
}

/** Go RE2 `(?i)…` → a JS RegExp with the i flag (same syntax for what we emit). */
function re2(src: string): RegExp {
  return src.startsWith('(?i)') ? new RegExp(src.slice(4), 'i') : new RegExp(src)
}

describe('process rules are case-insensitive (Koala: discord.exe, Windows: Discord.exe)', () => {
  it('PROCESS-NAME matches the last path component in any case', () => {
    const r = re2(processNameRegex('discord.exe'))
    expect(r.test('C:\\Users\\me\\AppData\\Local\\Discord\\app-1.0.9\\Discord.exe')).toBe(true)
    expect(r.test('DISCORD.EXE')).toBe(true)
    expect(r.test('C:/x/discord.exe')).toBe(true)
    expect(r.test('C:\\x\\notdiscord.exe')).toBe(false)
    expect(r.test('C:\\x\\discord.exe.bak')).toBe(false)
    expect(r.test('C:\\x\\discordXexe')).toBe(false) // the dot is escaped
  })

  it('PROCESS-PATH matches the whole path, any case, \\ or /', () => {
    const r = re2(processPathRegex('C:\\Games\\Game.exe'))
    expect(r.test('c:\\games\\GAME.EXE')).toBe(true)
    expect(r.test('C:/Games/Game.exe')).toBe(true)
    expect(r.test('D:\\C:\\Games\\Game.exe')).toBe(false)
    expect(r.test('C:\\Games\\Game.exe2')).toBe(false)
  })

  it('regex metacharacters in names are literal', () => {
    expect(escapeRegex('my(app)+[1].exe')).toBe('my\\(app\\)\\+\\[1\\]\\.exe')
    const r = re2(processNameRegex('my(app)+.exe'))
    expect(r.test('C:\\my(app)+.exe')).toBe(true)
    expect(r.test('C:\\myappp.exe')).toBe(false)
  })

  it('compiles to process_path_regex, the value stays as typed', () => {
    const r = rule('ProcessName', 'discord.exe', 'PROXY')
    const plan = planRules(cfg([r]), outbounds)
    expect(plan.runs[0].rules).toEqual([{ process_path_regex: [processNameRegex('discord.exe')] }])
    expect(plan.runs[0].label).toBe('программа discord.exe')
    expect(r.value).toBe('discord.exe')
  })
})

describe('planRules: runs of consecutive same-action rules', () => {
  it('maps condition types to headless matchers', () => {
    const plan = planRules(
      cfg([
        rule('Domain', 'x.com', 'DIRECT'),
        rule('DomainSuffix', 'y.com', 'DIRECT'),
        rule('DomainKeyword', 'z', 'DIRECT'),
        rule('DomainRegex', '^ads\\.', 'DIRECT'),
        rule('IPCIDR', '192.0.2.7', 'DIRECT'),
        rule('IPCIDR', '2001:db8::/32', 'DIRECT'),
        rule('DstPort', '443', 'DIRECT'),
        rule('DstPort', '6881-6889', 'DIRECT'),
        rule('DstPort', 'abc', 'DIRECT')
      ]),
      outbounds
    )
    expect(plan.runs).toHaveLength(1)
    expect(plan.runs[0].kind).toBe('direct')
    expect(plan.runs[0].rules).toEqual([
      { domain: ['x.com'] },
      { domain_suffix: ['y.com'] },
      { domain_keyword: ['z'] },
      { domain_regex: ['^ads\\.'] },
      { ip_cidr: ['192.0.2.7/32'] },
      { ip_cidr: ['2001:db8::/32'] },
      { port: [443] },
      { port_range: ['6881:6889'] }
    ])
    expect(plan.runs[0].label).toBe('домен x.com и ещё 7') // the bad port rule is dropped
  })

  it('PROXY / a server name / REJECT / DIRECT; an unknown server falls back to the selector', () => {
    const plan = planRules(
      cfg([
        rule('Domain', 'p.com', 'PROXY'),
        rule('Domain', 'n.com', 'Backup'),
        rule('Domain', 'g.com', 'Gone'),
        rule('Domain', 'r.com', 'REJECT'),
        rule('Domain', 'd.com', 'DIRECT')
      ]),
      outbounds
    )
    expect(plan.runs.map((r) => [r.kind, r.target])).toEqual([
      ['proxy', 'proxy'],
      ['proxy', 'ob_b'],
      ['proxy', 'proxy'],
      ['reject', ''],
      ['direct', 'direct']
    ])
  })

  it('geo sets are collected per run; GEOIP lan/private/telegram are built in', () => {
    const plan = planRules(
      cfg([
        rule('GeoSite', 'category-ads-all', 'REJECT'),
        rule('GeoIP', 'ru', 'DIRECT'),
        rule('GeoSite', 'yandex', 'DIRECT'),
        rule('GeoIP', 'LAN', 'DIRECT'),
        rule('GeoIP', 'telegram', 'PROXY')
      ]),
      outbounds
    )
    expect(plan.geo).toEqual(['geosite-category-ads-all', 'geoip-ru', 'geosite-yandex'])
    expect(plan.runs[1].geo).toEqual(['geoip-ru', 'geosite-yandex'])
    expect(plan.runs[1].rules[0].ip_cidr).toContain('192.168.0.0/16')
    expect(plan.runs[2].rules).toEqual([{ ip_cidr: TELEGRAM_CIDRS }])
    expect(TELEGRAM_CIDRS).toEqual(
      expect.arrayContaining(['149.154.160.0/20', '91.108.56.0/22', '91.105.192.0/23'])
    )
  })

  it('disabled rules are skipped; «Всё остальное» → final; «авто» = Russia direct at the end', () => {
    const off = { ...rule('Domain', 'x.com', 'DIRECT'), enabled: false }
    expect(planRules(cfg([off]), outbounds).runs).toEqual([])
    expect(planRules(cfg([], 'proxy'), outbounds).final).toBe('proxy')
    expect(planRules(cfg([], 'direct'), outbounds).final).toBe('direct')
    const auto = planRules(cfg([rule('Domain', 'x.com', 'DIRECT')], 'auto'), outbounds)
    expect(auto.final).toBe('proxy')
    // merges into the preceding DIRECT run, LAN is the built-in ip_is_private rule (configGen)
    expect(auto.runs).toHaveLength(1)
    expect(auto.runs[0].geo).toEqual(['geoip-ru', 'geosite-category-ru'])
  })

  it('geo names that could escape the cache folder are dropped', () => {
    expect(geoTag('geosite', '../../evil')).toBeNull()
    expect(geoTag('geosite', 'a..b')).toBeNull()
    expect(geoTag('geoip', 'RU')).toBe('geoip-ru')
    expect(geoTag('geosite', 'category-ads-all')).toBe('geosite-category-ads-all')
  })
})

describe('layoutRules: runs → slots D0 P0 X0 D1 …, first match wins', () => {
  const geo = new Map<string, HeadlessRule[]>([
    ['geoip-ru', [{ ip_cidr: ['5.0.0.0/8'] }]],
    ['geosite-yandex', [{ domain_suffix: ['ya.ru', 'yandex.ru'] }]]
  ])
  const files = (l: NonNullable<ReturnType<typeof layoutRules>>, tag: string) =>
    JSON.parse(l.files[`${tag}.json`]) as { version: number; rules: HeadlessRule[] }

  it('order of slots keeps the order of the runs', () => {
    const plan = planRules(
      cfg(
        [
          rule('ProcessName', 'Telegram.exe', 'PROXY'), // P0
          rule('GeoIP', 'ru', 'DIRECT'), // D1 (D0 is before P0)
          rule('GeoSite', 'yandex', 'DIRECT'), // same run
          rule('Domain', 'ads.com', 'REJECT'), // X1
          rule('Domain', 'b.com', 'Backup') // P2
        ],
        'direct'
      ),
      outbounds
    )
    const l = layoutRules(plan, 8, geo)!
    expect(files(l, 'cw-0-p').rules).toEqual([
      { process_path_regex: [processNameRegex('Telegram.exe')] }
    ])
    expect(files(l, 'cw-0-d').rules).toEqual([])
    expect(files(l, 'cw-1-d').rules).toEqual([
      { ip_cidr: ['5.0.0.0/8'] },
      { domain_suffix: ['ya.ru', 'yandex.ru'] }
    ])
    // DNS: only the domain part
    expect(files(l, 'cw-1-dn').rules).toEqual([{ domain_suffix: ['ya.ru', 'yandex.ru'] }])
    expect(files(l, 'cw-1-x').rules).toEqual([{ domain: ['ads.com'] }])
    expect(files(l, 'cw-2-p').rules).toEqual([{ domain: ['b.com'] }])
    expect(files(l, 'cw-2-pn').rules).toEqual([{ domain: ['b.com'] }])
    expect(l.selectors).toMatchObject({ 'cw-0': 'proxy', 'cw-2': 'ob_b', 'cw-1': 'proxy' })
    expect(l.selectors['cw-final']).toBe('direct')
    expect(l.selectors['cw-dns']).toBe('direct')
    expect(l.labels).toEqual({
      'cw-0-p': 'программа Telegram.exe',
      'cw-1-d': 'geoip:ru и ещё 1',
      'cw-1-x': 'домен ads.com',
      'cw-2-p': 'домен b.com'
    })
    // «Подключения» names the matched program of a run (0.4.5)
    expect(l.programs).toEqual({ 'cw-0-p': ['Telegram.exe'] })
    // every slot has its files (5 per group), every file is a rule-set the broker accepts
    expect(Object.keys(l.files)).toHaveLength(8 * 5)
    for (const t of Object.values(l.files)) expect(t.startsWith('{"version":3,')).toBe(true)
  })

  it('a missing geo set is reported and skipped (no empty slot used for it)', () => {
    const plan = planRules(
      cfg([rule('GeoSite', 'nope', 'PROXY'), rule('Domain', 'x.com', 'DIRECT')]),
      outbounds
    )
    const l = layoutRules(plan, 8, geo)!
    expect(l.missing).toEqual(['geosite-nope'])
    expect(files(l, 'cw-0-p').rules).toEqual([])
    expect(files(l, 'cw-0-d').rules).toEqual([{ domain: ['x.com'] }])
  })

  it('null when the runs do not fit (→ restart with more groups); groupsFor leaves room', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      rule('Domain', `${i}.com`, i % 2 ? 'DIRECT' : 'REJECT')
    )
    const plan = planRules(cfg(many), outbounds)
    expect(plan.runs).toHaveLength(6)
    // X0 D1 X1 D2 X2 D3 → needs 4 groups
    expect(layoutRules(plan, 3, geo)).toBeNull()
    expect(layoutRules(plan, 4, geo)).not.toBeNull()
    expect(groupsFor(plan)).toBe(10)
    expect(groupsFor(planRules(cfg([]), outbounds))).toBe(8)
  })

  it('the same input gives the same files (unchanged slots are not rewritten)', () => {
    const plan = planRules(cfg([rule('Domain', 'x.com', 'DIRECT')]), outbounds)
    expect(layoutRules(plan, 8, geo)).toEqual(layoutRules(plan, 8, geo))
  })

  it('domainOnly keeps only domain matchers', () => {
    expect(
      domainOnly([
        { domain: ['a'], port: [1] },
        { ip_cidr: ['1.1.1.1/32'] },
        { domain_regex: ['^x'] }
      ])
    ).toEqual([{ domain: ['a'] }, { domain_regex: ['^x'] }])
  })
})

describe('ruleSkeleton (the fixed part of the config)', () => {
  const sk = ruleSkeleton(2, 'C:\\run\\rules', ['ob_a', 'ob_b'], {
    'cw-1': 'ob_b',
    'cw-final': 'direct'
  })

  it('route rules: per group D → direct, P → its selector, X → reject', () => {
    expect(sk.routeRules).toEqual([
      { rule_set: ['cw-0-d'], action: 'route', outbound: 'direct' },
      { rule_set: ['cw-0-p'], action: 'route', outbound: 'cw-0' },
      { rule_set: ['cw-0-x'], action: 'reject' },
      { rule_set: ['cw-1-d'], action: 'route', outbound: 'direct' },
      { rule_set: ['cw-1-p'], action: 'route', outbound: 'cw-1' },
      { rule_set: ['cw-1-x'], action: 'reject' }
    ])
  })

  it('DNS rules in the same order: direct domains local, VPN domains remote', () => {
    expect(sk.dnsRules).toEqual([
      { rule_set: ['cw-0-dn'], server: 'local' },
      { rule_set: ['cw-0-pn'], server: 'remote' },
      { rule_set: ['cw-1-dn'], server: 'local' },
      { rule_set: ['cw-1-pn'], server: 'remote' }
    ])
  })

  it('local source rule-sets in the given folder; selectors start on the layout choice', () => {
    expect(sk.ruleSets[0]).toEqual({
      type: 'local',
      tag: 'cw-0-d',
      format: 'source',
      path: 'C:\\run\\rules\\cw-0-d.json'
    })
    expect(sk.ruleSets).toHaveLength(10)
    const byTag = Object.fromEntries(sk.outbounds.map((o) => [o.tag, o]))
    expect(byTag['cw-0']).toMatchObject({
      type: 'selector',
      outbounds: ['proxy', 'ob_a', 'ob_b'],
      default: 'proxy'
    })
    expect(byTag['cw-1'].default).toBe('ob_b')
    expect(byTag['cw-final']).toMatchObject({ outbounds: ['proxy', 'direct'], default: 'direct' })
    expect(byTag['cw-dns'].default).toBe('proxy')
  })
})

describe('helpers', () => {
  it('port and CIDR helpers', () => {
    expect(portMatcher('80/443')).toEqual({ port: [80, 443] })
    expect(portMatcher('1000-2000|53')).toEqual({ port: [53], port_range: ['1000:2000'] })
    expect(portMatcher('0')).toBeNull()
    expect(portMatcher('70000')).toBeNull()
    expect(portMatcher('9-1')).toBeNull()
    expect(normalizeCidr('::1')).toBe('::1/128')
    expect(normalizeCidr('10.0.0.0/8')).toBe('10.0.0.0/8')
  })
})
