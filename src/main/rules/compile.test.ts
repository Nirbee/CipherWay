import { describe, expect, it } from 'vitest'
import type { OutboundConfig, RulesConfig } from '@shared/types'
import { compileRules } from './compile'

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
      outbounds,
      'ob_a'
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
      outbounds,
      'ob_a'
    )
    expect(rules[0]).toMatchObject({ process_name: ['firefox.exe'], outbound: 'ob_a' })
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
      outbounds,
      'ob_a'
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
      outbounds,
      'ob_a'
    )
    expect(rules[0].outbound).toBe('ob_a')
    expect(rules[1].outbound).toBe('ob_b')
    expect(rules[2]).toMatchObject({ action: 'reject' })
    expect(rules[2].outbound).toBeUndefined()
  })

  it('skips disabled rules and sets default final tag', () => {
    const proxy = compileRules(cfg({ defaultBehavior: 'proxy' }), outbounds, 'ob_a')
    expect(proxy.final).toBe('ob_a')
    const direct = compileRules(cfg({ defaultBehavior: 'direct' }), outbounds, 'ob_a')
    expect(direct.final).toBe('direct')

    const auto = compileRules(cfg({ defaultBehavior: 'auto' }), outbounds, 'ob_a')
    expect(auto.final).toBe('ob_a')
    expect(auto.ruleSets.some((r) => r.tag === 'geoip-ru')).toBe(true)
    expect(auto.rules.some((r) => r.rule_set?.includes('geoip-ru') && r.outbound === 'direct')).toBe(
      true
    )
  })
})
