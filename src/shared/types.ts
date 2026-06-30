// Shared TypeScript types used by both the Electron main process and the renderer.

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export type ProxyMode = 'system' | 'tun'

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
  userInfo?: {
    upload?: number
    download?: number
    total?: number
    expire?: number // unix seconds
  }
  rawTitle?: string
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
  | 'GeoSite'
  | 'GeoIP'
  | 'IPCIDR'

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
  message?: string
}

export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error' | 'debug'
  source: 'app' | 'singbox'
  message: string
}

export interface ServerPing {
  outboundId: string
  latencyMs: number | null // null = timeout / unreachable
}
