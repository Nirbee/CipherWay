// Shared TypeScript types used by both the Electron main process and the renderer.

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export type ProxyMode = 'system' | 'tun'

/**
 * Traffic routing mode, switched on the fly through the Clash API:
 *  - rule   — the user's rules (Правила)
 *  - global — everything through the VPN except LAN (Весь трафик через VPN)
 *  - direct — everything bypasses the VPN (Напрямую)
 */
export type RoutingMode = 'rule' | 'global' | 'direct'

/** Pseudo server id: sing-box urltest over all nodes («Лучший сервер (авто)»). */
export const AUTO_OUTBOUND_ID = 'auto'

export type Protocol = 'vless' | 'hysteria2' | 'vmess'

/** A single proxy outbound parsed from a Remnawave subscription. */
export interface OutboundConfig {
  id: string
  name: string
  protocol: Protocol
  server: string
  port: number
  // VLESS / REALITY
  uuid?: string
  flow?: string
  /** VLESS `encryption` param (usually "none") */
  encryption?: string
  security?: 'reality' | 'tls' | 'none'
  publicKey?: string
  shortId?: string
  serverName?: string
  fingerprint?: string
  spiderX?: string
  network?: 'tcp' | 'ws' | 'grpc'
  path?: string
  host?: string
  // Hysteria2
  password?: string
  sni?: string
  obfs?: string
  obfsPassword?: string
  insecure?: boolean
  // raw original URI for debugging / re-parse
  raw?: string
}

export interface SubscriptionData {
  url: string
  fetchedAt: number
  outbounds: OutboundConfig[]
  // headers Remnawave/standard subscriptions expose
  userInfo?: SubscriptionUserInfo
  rawTitle?: string
  /** `support-url` response header */
  supportUrl?: string
  /** `profile-web-page-url` response header (renewal / personal page) */
  webPageUrl?: string
  /** `announce` response header (plain or base64:) */
  announce?: string
  /** `profile-update-interval` response header, hours */
  updateIntervalHours?: number
}

export interface SubscriptionUserInfo {
  upload?: number
  download?: number
  /** 0 / missing = unlimited */
  total?: number
  /** unix seconds; 0 / missing = no expiry */
  expire?: number
}

/** A server as the renderer sees it: no addresses, ports or credentials. */
export interface ServerInfo {
  id: string
  name: string
  protocol: Protocol
}

/** What the renderer gets instead of SubscriptionData (see remnawave/view.ts). */
export interface SubscriptionView {
  fetchedAt: number
  servers: ServerInfo[]
  userInfo?: SubscriptionUserInfo
  title?: string
  supportUrl?: string
  webPageUrl?: string
  announce?: string
  /** subscription link with everything after the first characters hidden */
  urlMasked: string
}

// ---------------------------------------------------------------------------
// Routing rules engine
// ---------------------------------------------------------------------------

export type RuleConditionType =
  | 'ProcessName'
  | 'ProcessPath'
  | 'Domain'
  | 'DomainSuffix'
  | 'DomainKeyword'
  | 'DomainRegex'
  | 'GeoSite'
  | 'GeoIP'
  | 'IPCIDR'
  | 'DstPort'

/** Special built-in outbound targets plus any subscription profile id/name. */
export type RuleActionType = 'PROXY' | 'DIRECT' | 'REJECT' | string

export interface RoutingRule {
  id: string
  enabled: boolean
  conditionType: RuleConditionType
  value: string
  /** 'PROXY' | 'DIRECT' | 'REJECT' or an outbound id/name */
  action: RuleActionType
}

export type DefaultBehavior = 'proxy' | 'direct' | 'auto'

export interface RulesConfig {
  rules: RoutingRule[]
  defaultBehavior: DefaultBehavior
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type Language = 'ru' | 'en'

export interface AppSettings {
  proxyMode: ProxyMode
  routingMode: RoutingMode
  /** fallback «Поддержка» link when the subscription has no support-url */
  supportUrl: string
  autoLaunch: boolean
  autoConnect: boolean
  language: Language
  socksPort: number
  httpPort: number
  subscriptionRefreshHours: number
}

// ---------------------------------------------------------------------------
// Runtime status / telemetry pushed from main -> renderer
// ---------------------------------------------------------------------------

export interface TrafficStats {
  uploadSpeed: number // bytes/sec
  downloadSpeed: number // bytes/sec
  totalUpload: number // bytes
  totalDownload: number // bytes
}

export interface StatusUpdate {
  state: ConnectionState
  activeOutboundId?: string
  /** node currently picked by «Лучший сервер (авто)» (urltest `now`) */
  autoSelectedId?: string
  message?: string
}

export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error' | 'debug'
  source: 'app' | 'singbox' | 'xray'
  message: string
}

/** A validated cipherway:// subscription import, awaiting user confirmation. */
export interface ImportRequest {
  url: string
  host: string
}

export interface ServerPing {
  outboundId: string
  latencyMs: number | null // null = no response through the node
}

// ---------------------------------------------------------------------------
// Live connections (Clash API /connections), already stripped of node addresses
// ---------------------------------------------------------------------------

export type ConnRouteKind = 'proxy' | 'direct' | 'reject'

export interface ConnItem {
  id: string
  /** exe file name, if the core could identify the owning process */
  process?: string
  processPath?: string
  /** destination host name, or IP if there is no host */
  host: string
  port: string
  network: string
  /** human-readable rule that matched */
  rule: string
  route: ConnRouteKind
  /** server name when route === 'proxy' */
  serverName?: string
  upload: number
  download: number
  /** bytes/s since the previous snapshot */
  uploadSpeed: number
  downloadSpeed: number
  /** ms timestamp */
  start: number
}

export interface ConnSnapshot {
  /** false = VPN not connected, list is empty */
  running: boolean
  proxyMode: ProxyMode
  items: ConnItem[]
}
