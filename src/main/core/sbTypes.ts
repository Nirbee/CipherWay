// Structural types for the subset of the sing-box config we generate.
// Targeting sing-box 1.11.x schema (modern rule "action" form, rule-sets for
// geosite/geoip). The pinned version lives in scripts/download-cores.ts.

export type SbAction = 'route' | 'reject' | 'sniff' | 'hijack-dns'

export interface SbRouteRule {
  // matchers (any combination)
  domain?: string[]
  domain_suffix?: string[]
  domain_keyword?: string[]
  ip_cidr?: string[]
  process_name?: string[]
  process_path?: string[]
  rule_set?: string[]
  inbound?: string[]
  protocol?: string[]
  // action
  action?: SbAction
  outbound?: string // when action === 'route'
}

export interface SbRuleSet {
  type: 'remote'
  tag: string
  format: 'binary'
  url: string
  download_detour: string
}

export interface SbOutbound {
  type: string
  tag: string
  [key: string]: unknown
}

export interface SbInbound {
  type: string
  tag: string
  [key: string]: unknown
}

export interface SbConfig {
  log: { level: string; output?: string; timestamp: boolean }
  dns?: Record<string, unknown>
  experimental?: {
    clash_api?: { external_controller: string; default_mode?: string }
    cache_file?: { enabled: boolean; path?: string }
  }
  inbounds: SbInbound[]
  outbounds: SbOutbound[]
  route: {
    rules: SbRouteRule[]
    rule_set?: SbRuleSet[]
    final?: string
    auto_detect_interface?: boolean
    default_mark?: number
    default_domain_resolver?: { server: string }
  }
}

export const TAG_DIRECT = 'direct'
export const TAG_PROXY_GROUP = 'proxy' // selector over all subscription nodes

// rule-set source repos (SagerNet official, .srs binary format)
const GEOSITE_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set'
const GEOIP_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set'

export function geositeRuleSet(category: string): SbRuleSet {
  const slug = category.toLowerCase()
  return {
    type: 'remote',
    tag: `geosite-${slug}`,
    format: 'binary',
    url: `${GEOSITE_BASE}/geosite-${slug}.srs`,
    download_detour: TAG_DIRECT
  }
}

export function geoipRuleSet(code: string): SbRuleSet {
  const slug = code.toLowerCase()
  return {
    type: 'remote',
    tag: `geoip-${slug}`,
    format: 'binary',
    url: `${GEOIP_BASE}/geoip-${slug}.srs`,
    download_detour: TAG_DIRECT
  }
}
