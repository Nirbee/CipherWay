import { describe, expect, it } from 'vitest'
import type { OutboundConfig, RulesConfig } from '@shared/types'
import { compileRules, normalizeCidr, portMatcher } from './compile'

const outbounds: OutboundConfig[] = [
  { id: 'ob_a', name: 'Remnawave', protocol: 'vless', server: 'a.com', port: 443 },
  { id: 'ob_b', name: 'Backup', protocol: 'hysteria2', server: 'b.com', port: 8443 }
]

function cfg(partial: Partial<RulesConfig>): RulesConfig {
  return { defaultBehavior: 'proxy', rules: [], ...partial }
}

describe('compileRules (sing-box)', () => {
  it('maps domain condition types to sing-box matchers', () => {
    const { rules } = compileRules(
      cfg({
        rules: [
          { id: '1', enabled: true, conditionType: 'Domain', value: 'x.com', action: 'DIRECT' },
          { id: '2', enabled: true, conditionType: 'DomainSuffix', value: 'y.com', action: 'DIRECT' },
          { id: '3', enabled: true, conditionType: 'DomainKeyword', value: 'z', action: 'DIRECT' }
        ]
      }),
      outbounds
    )
    expect(rules[0]).toMatchObject({ domain: ['x.com'], action: 'route', outbound: 'direct' })
    expect(rules[1].domain_suffix).toEqual(['y.com'])
    expect(rules[2].domain_keyword).toEqual(['z'])
  })

  it('supports process rules natively', () => {
    const { rules } = compileRules(
      cfg({
        rules: [
          { id: '1', enabled: true, conditionType: 'ProcessName', value: 'firefox.exe', action: 'PROXY' },
          { id: '2', enabled: true, conditionType: 'ProcessPath', value: 'C:\\app.exe', action: 'DIRECT' }
        ]
      }),
      outbounds
    )
    expect(rules[0]).toMatchObject({ process_name: ['firefox.exe'], outbound: 'proxy' })
    expect(rules[1]).toMatchObject({ process_path: ['C:\\app.exe'], outbound: 'direct' })
  })

  it('emits rule-sets for geosite/geoip', () => {
    const { rules, ruleSets } = compileRules(
      cfg({
        rules: [
          { id: '1', enabled: true, conditionType: 'GeoSite', value: 'yandex', action: 'DIRECT' },
          { id: '2', enabled: true, conditionType: 'GeoIP', value: 'ru', action: 'DIRECT' }
        ]
      }),
      outbounds
    )
    expect(rules[0].rule_set).toEqual(['geosite-yandex'])
    expect(rules[1].rule_set).toEqual(['geoip-ru'])
    expect(ruleSets.map((r) => r.tag).sort()).toEqual(['geoip-ru', 'geosite-yandex'])
    expect(ruleSets[0].format).toBe('binary')
  })

  it('resolves PROXY/named/REJECT actions', () => {
    const { rules } = compileRules(
      cfg({
        rules: [
          { id: '1', enabled: true, conditionType: 'Domain', value: 'p.com', action: 'PROXY' },
          { id: '2', enabled: true, conditionType: 'Domain', value: 'n.com', action: 'Backup' },
          { id: '3', enabled: true, conditionType: 'Domain', value: 'r.com', action: 'REJECT' }
        ]
      }),
      outbounds
    )
    expect(rules[0].outbound).toBe('proxy')
    expect(rules[1].outbound).toBe('ob_b')
    expect(rules[2]).toMatchObject({ action: 'reject' })
    expect(rules[2].outbound).toBeUndefined()
  })

  it('skips disabled rules and sets default final tag', () => {
    const proxy = compileRules(cfg({ defaultBehavior: 'proxy' }), outbounds)
    expect(proxy.final).toBe('proxy')
    const direct = compileRules(cfg({ defaultBehavior: 'direct' }), outbounds)
    expect(direct.final).toBe('direct')

    const auto = compileRules(cfg({ defaultBehavior: 'auto' }), outbounds)
    expect(auto.final).toBe('proxy')
    expect(auto.ruleSets.some((r) => r.tag === 'geoip-ru')).toBe(true)
    // no geoip-private rule-set (doesn't exist upstream); LAN via ip_is_private
    expect(auto.ruleSets.some((r) => r.tag === 'geoip-private')).toBe(false)
    expect(auto.rules).toContainEqual({ ip_is_private: true, action: 'route', outbound: 'direct' })
    expect(auto.rules.some((r) => r.rule_set?.includes('geoip-ru') && r.outbound === 'direct')).toBe(
      true
    )
  })

  it('unknown server names fall back to the proxy selector', () => {
    const { rules } = compileRules(
      cfg({
        rules: [{ id: '1', enabled: true, conditionType: 'Domain', value: 'x.com', action: 'Gone' }]
      }),
      outbounds
    )
    expect(rules[0].outbound).toBe('proxy')
  })

  it('compiles DOMAIN-REGEX, DST-PORT and IP-CIDR6 rules', () => {
    const { rules } = compileRules(
      cfg({
        rules: [
          { id: '1', enabled: true, conditionType: 'DomainRegex', value: '^ads\\.', action: 'REJECT' },
          { id: '2', enabled: true, conditionType: 'DstPort', value: '443', action: 'PROXY' },
          { id: '3', enabled: true, conditionType: 'DstPort', value: '6881-6889', action: 'DIRECT' },
          { id: '4', enabled: true, conditionType: 'IPCIDR', value: '2001:db8::/32', action: 'DIRECT' },
          { id: '5', enabled: true, conditionType: 'IPCIDR', value: '192.0.2.7', action: 'DIRECT' },
          { id: '6', enabled: true, conditionType: 'DstPort', value: 'abc', action: 'DIRECT' },
          { id: '7', enabled: true, conditionType: 'GeoIP', value: 'LAN', action: 'DIRECT' }
        ]
      }),
      outbounds
    )
    expect(rules[0]).toEqual({ domain_regex: ['^ads\\.'], action: 'reject' })
    expect(rules[1]).toEqual({ port: [443], action: 'route', outbound: 'proxy' })
    expect(rules[2]).toEqual({ port_range: ['6881:6889'], action: 'route', outbound: 'direct' })
    expect(rules[3].ip_cidr).toEqual(['2001:db8::/32'])
    expect(rules[4].ip_cidr).toEqual(['192.0.2.7/32'])
    // invalid port rule is dropped, GEOIP,LAN = built-in private matcher
    expect(rules).toHaveLength(6)
    expect(rules[5]).toMatchObject({ ip_is_private: true, outbound: 'direct' })
  })

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
