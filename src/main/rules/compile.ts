import type { OutboundConfig, RoutingRule, RulesConfig } from '@shared/types'
import {
  geoipRuleSet,
  geositeRuleSet,
  TAG_DIRECT,
  type SbRouteRule,
  type SbRuleSet
} from '../core/sbTypes'

export interface CompileResult {
  rules: SbRouteRule[]
  ruleSets: SbRuleSet[]
  /** route.final — default outbound tag for unmatched traffic */
  final: string
}

/** Maps a rule action to a sing-box outbound tag (or signals reject). */
function resolveAction(
  action: string,
  activeOutboundId: string | undefined,
  outboundsByName: Map<string, string>
): { reject: true } | { reject: false; outbound: string } {
  if (action === 'REJECT' || action === 'BLOCK') return { reject: true }
  if (action === 'DIRECT') return { reject: false, outbound: TAG_DIRECT }
  if (action === 'PROXY') return { reject: false, outbound: activeOutboundId ?? TAG_DIRECT }
  const id = outboundsByName.get(action)
  return { reject: false, outbound: id ?? activeOutboundId ?? TAG_DIRECT }
}

/** Builds the matcher portion of a route rule for a single condition. */
function matcher(rule: RoutingRule, ruleSets: Map<string, SbRuleSet>): SbRouteRule | null {
  switch (rule.conditionType) {
    case 'Domain':
      return { domain: [rule.value] }
    case 'DomainSuffix':
      return { domain_suffix: [rule.value] }
    case 'DomainKeyword':
      return { domain_keyword: [rule.value] }
    case 'IPCIDR':
      return { ip_cidr: [rule.value] }
    case 'ProcessName':
      return { process_name: [rule.value] }
    case 'ProcessPath':
      return { process_path: [rule.value] }
    case 'GeoSite': {
      const rs = geositeRuleSet(rule.value)
      ruleSets.set(rs.tag, rs)
      return { rule_set: [rs.tag] }
    }
    case 'GeoIP': {
      const rs = geoipRuleSet(rule.value)
      ruleSets.set(rs.tag, rs)
      return { rule_set: [rs.tag] }
    }
    default:
      return null
  }
}

/**
 * Compiles the user's RulesConfig into sing-box route rules.
 * First-match-wins (Clash semantics). Process rules are fully supported.
 */
export function compileRules(
  config: RulesConfig,
  outbounds: OutboundConfig[],
  activeOutboundId: string | undefined
): CompileResult {
  const byName = new Map(outbounds.map((o) => [o.name, o.id]))
  const ruleSets = new Map<string, SbRuleSet>()
  const rules: SbRouteRule[] = []

  for (const rule of config.rules) {
    if (!rule.enabled) continue
    const m = matcher(rule, ruleSets)
    if (!m) continue
    const act = resolveAction(rule.action, activeOutboundId, byName)
    if (act.reject) rules.push({ ...m, action: 'reject' })
    else rules.push({ ...m, action: 'route', outbound: act.outbound })
  }

  // default behavior
  const proxyTag = activeOutboundId ?? TAG_DIRECT
  let final = proxyTag
  if (config.defaultBehavior === 'direct') {
    final = TAG_DIRECT
  } else if (config.defaultBehavior === 'auto') {
    // Russian IPs/sites direct, everything else through the proxy
    const ruRs = geoipRuleSet('ru')
    const privRs = geoipRuleSet('private')
    const siteRs = geositeRuleSet('category-ru')
    ruleSets.set(ruRs.tag, ruRs)
    ruleSets.set(privRs.tag, privRs)
    ruleSets.set(siteRs.tag, siteRs)
    rules.push({ rule_set: [privRs.tag, ruRs.tag], action: 'route', outbound: TAG_DIRECT })
    rules.push({ rule_set: [siteRs.tag], action: 'route', outbound: TAG_DIRECT })
    final = proxyTag
  }

  return { rules, ruleSets: [...ruleSets.values()], final }
}
