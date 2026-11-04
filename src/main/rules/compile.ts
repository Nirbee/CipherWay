import type { OutboundConfig, RoutingRule, RulesConfig } from '@shared/types'
import { parsePortSpec } from '@shared/rulesText'
import {
  geoipRuleSet,
  geositeRuleSet,
  TAG_DIRECT,
  TAG_PROXY_GROUP,
  type SbRouteRule,
  type SbRuleSet
} from '../core/sbTypes'

export interface CompileResult {
  rules: SbRouteRule[]
  ruleSets: SbRuleSet[]
  /** route.final — default outbound tag for unmatched traffic */
  final: string
}

/**
 * Maps a rule action to a sing-box outbound tag (or signals reject).
 * PROXY = the `proxy` selector (current server or «Лучший сервер (авто)»),
 * a server name = that node, anything unknown falls back to the selector.
 */
function resolveAction(
  action: string,
  outboundsByName: Map<string, string>
): { reject: true } | { reject: false; outbound: string } {
  if (action === 'REJECT' || action === 'BLOCK') return { reject: true }
  if (action === 'DIRECT') return { reject: false, outbound: TAG_DIRECT }
  if (action === 'PROXY') return { reject: false, outbound: TAG_PROXY_GROUP }
  return { reject: false, outbound: outboundsByName.get(action) ?? TAG_PROXY_GROUP }
}

/** `443` → port, `8000-9000` → port_range; lists split by `/`, `|` or `,`. */
export function portMatcher(value: string): SbRouteRule | null {
  const spec = parsePortSpec(value)
  if (!spec) return null
  return {
    ...(spec.ports.length ? { port: spec.ports } : {}),
    ...(spec.ranges.length ? { port_range: spec.ranges } : {})
  }
}

/** Plain IPs become single-host prefixes (sing-box wants CIDR). */
export function normalizeCidr(value: string): string {
  const v = value.trim()
  if (v.includes('/')) return v
  return v.includes(':') ? `${v}/128` : `${v}/32`
}

/** Builds the matcher portion of a route rule for a single condition. */
function matcher(rule: RoutingRule, ruleSets: Map<string, SbRuleSet>): SbRouteRule | null {
  const value = rule.value.trim()
  if (!value) return null
  switch (rule.conditionType) {
    case 'Domain':
      return { domain: [value] }
    case 'DomainSuffix':
      return { domain_suffix: [value] }
    case 'DomainKeyword':
      return { domain_keyword: [value] }
    case 'DomainRegex':
      return { domain_regex: [value] }
    case 'IPCIDR':
      return { ip_cidr: [normalizeCidr(value)] }
    case 'DstPort':
      return portMatcher(value)
    case 'ProcessName':
      return { process_name: [value] }
    case 'ProcessPath':
      return { process_path: [value] }
    case 'GeoSite': {
      const rs = geositeRuleSet(value)
      ruleSets.set(rs.tag, rs)
      return { rule_set: [rs.tag] }
    }
    case 'GeoIP': {
      // no upstream geoip-private set; sing-box has a built-in matcher
      const v = value.toLowerCase()
      if (v === 'private' || v === 'lan') return { ip_is_private: true }
      const rs = geoipRuleSet(v)
      ruleSets.set(rs.tag, rs)
      return { rule_set: [rs.tag] }
    }
    default:
      return null
  }
}

/**
 * Compiles the user's RulesConfig into sing-box route rules.
 * First-match-wins (Clash semantics). These rules only apply in the «Правила»
 * routing mode — «Весь трафик» / «Напрямую» are clash_mode rules placed
 * before them (see configGen.ts).
 */
export function compileRules(config: RulesConfig, outbounds: OutboundConfig[]): CompileResult {
  const byName = new Map(outbounds.map((o) => [o.name, o.id]))
  const ruleSets = new Map<string, SbRuleSet>()
  const rules: SbRouteRule[] = []

  for (const rule of config.rules) {
    if (!rule.enabled) continue
    const m = matcher(rule, ruleSets)
    if (!m) continue
    const act = resolveAction(rule.action, byName)
    if (act.reject) rules.push({ ...m, action: 'reject' })
    else rules.push({ ...m, action: 'route', outbound: act.outbound })
  }

  // default behavior
  let final = TAG_PROXY_GROUP
  if (config.defaultBehavior === 'direct') {
    final = TAG_DIRECT
  } else if (config.defaultBehavior === 'auto') {
    // LAN + Russian IPs/sites direct, everything else through the proxy.
    // (SagerNet/sing-geoip has no "private" set — a 404 there stops sing-box
    // at startup — so LAN uses the built-in ip_is_private matcher.)
    const ruRs = geoipRuleSet('ru')
    const siteRs = geositeRuleSet('category-ru')
    ruleSets.set(ruRs.tag, ruRs)
    ruleSets.set(siteRs.tag, siteRs)
    rules.push({ ip_is_private: true, action: 'route', outbound: TAG_DIRECT })
    rules.push({ rule_set: [ruRs.tag], action: 'route', outbound: TAG_DIRECT })
    rules.push({ rule_set: [siteRs.tag], action: 'route', outbound: TAG_DIRECT })
  }

  return { rules, ruleSets: [...ruleSets.values()], final }
}
