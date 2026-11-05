// Structural types for the subset of the sing-box config we generate.
// Targeting sing-box 1.13.x (modern rule "action" form, local source
// rule-sets for the user's rules). Checked with `sing-box check` 1.13.14.

export type SbAction = 'route' | 'reject' | 'sniff' | 'hijack-dns'

export interface SbRouteRule {
  // matchers (any combination)
  domain?: string[]
  domain_suffix?: string[]
  domain_keyword?: string[]
  domain_regex?: string[]
  ip_cidr?: string[]
  port?: number[]
  port_range?: string[]
  ip_is_private?: boolean
  process_name?: string[]
  process_path?: string[]
  process_path_regex?: string[]
  rule_set?: string[]
  inbound?: string[]
  protocol?: string[]
  /** Clash API mode this rule is active in (Rule / Global / Direct) */
  clash_mode?: string
  // action
  action?: SbAction
  outbound?: string // when action === 'route'
}

/** Local rule-set in our own directory; sing-box re-reads it when the file changes. */
export interface SbRuleSet {
  type: 'local'
  tag: string
  format: 'source'
  path: string
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
    clash_api?: { external_controller: string; default_mode?: string; secret?: string }
  }
  inbounds: SbInbound[]
  outbounds: SbOutbound[]
  route: {
    rules: SbRouteRule[]
    rule_set?: SbRuleSet[]
    final?: string
    auto_detect_interface?: boolean
    find_process?: boolean
    default_mark?: number
    default_domain_resolver?: { server: string }
  }
}

export const TAG_DIRECT = 'direct'
/** selector over «auto» + every node; PROXY rules and route.final point here */
export const TAG_PROXY_GROUP = 'proxy'
/** urltest over every node («Лучший сервер (авто)») — same id as AUTO_OUTBOUND_ID */
export const TAG_AUTO = 'auto'

/** probe target for url-test and the «Проверить» button */
export const LATENCY_URL = 'https://www.gstatic.com/generate_204'
export const LATENCY_TIMEOUT_MS = 5000

/** Clash API mode names (sing-box compares them case-insensitively) */
export const CLASH_MODE = { rule: 'Rule', global: 'Global', direct: 'Direct' } as const

// geo rule-set source repos (SagerNet official, .srs binary format) — the app
// downloads and decompiles them itself (rules/geo.ts)
const GEOSITE_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set'
const GEOIP_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set'

/** Download URL of a `geosite-x` / `geoip-x` tag. */
export function geoUrl(tag: string): string {
  return `${tag.startsWith('geoip-') ? GEOIP_BASE : GEOSITE_BASE}/${tag}.srs`
}
