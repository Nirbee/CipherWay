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

/** Result of «Обновить подписку». */
export interface SubscriptionRefreshResult {
  view: SubscriptionView | null
  /** the list or a server's connection parameters really changed */
  changed: boolean
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
  /** «Подробный журнал (для поддержки)»: cores log every connection (info) */
  verboseLog: boolean
  /** in-app support API (cabinet), https only */
  apiBase: string
  /**
   * TUN through the «Служба TUN» task (one UAC prompt to set up, then none).
   * false = the user removed it: a UAC prompt on every TUN connect.
   */
  tunService: boolean
  /** «Пинг» → what the server list measures (0.5.2) */
  pingMode: PingMode
  /** «Пинг» → seconds a server gets to answer (PING_TIMEOUT_MIN_S…MAX_S) */
  pingTimeoutSec: number
}

/**
 * How the server list measures latency (Settings → «Пинг», 0.5.2):
 *  - keepalive: two HTTPS requests to the test page through the server over ONE
 *    connection; the second one counts — the pure round trip through the tunnel
 *    (no TCP / TLS / REALITY handshake). What Happ calls «via Proxy, Keepalive».
 *  - connect: the whole first request, handshakes included (sing-box url-test —
 *    what the app showed up to 0.5.1).
 *  - tcp: TCP connect straight to the server's address, outside the VPN — says
 *    nothing about whether the VPN works there.
 */
export type PingMode = 'keepalive' | 'connect' | 'tcp'
export const PING_MODES: readonly PingMode[] = ['keepalive', 'connect', 'tcp']
export const DEFAULT_PING_MODE: PingMode = 'keepalive'
export const PING_TIMEOUT_MIN_S = 5
export const PING_TIMEOUT_MAX_S = 15
export const DEFAULT_PING_TIMEOUT_S = 7

/** «Служба TUN» (Task Scheduler) as seen by the app. */
export interface TunServiceInfo {
  state: 'ok' | 'missing' | 'outdated'
  /** the LAN task of the service is installed (it may be older than the app) */
  lan?: boolean
  /** the zapret task of the service is installed (0.7.0; it may be older than the app) */
  dpi?: boolean
  /** zapret can't be set up from this build (its files differ from the pinned release) */
  dpiError?: string
  detail?: string
}

export const DEFAULT_API_BASE = 'https://cabinet.cipherway.net.ru'

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
  /** last measured latency of autoSelectedId; null = no answer */
  autoDelayMs?: number | null
  /** the first server check after connecting is still running */
  autoChecking?: boolean
  /** the check finished and no server answered */
  autoDead?: boolean
  message?: string
  /** node id → a hint for its row in the server list (REALITY keeps failing) */
  serverHints?: Record<string, string>
}

export type NoticeTone = 'info' | 'success' | 'error'

/** A message the main process wants shown as a toast. */
export interface AppNotice {
  text: string
  tone: NoticeTone
}

/** What the urltest group is doing right now (main-process internal → StatusUpdate). */
export interface AutoInfo {
  nodeId?: string
  delayMs?: number | null
  checking: boolean
  dead: boolean
}

export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error' | 'debug'
  source: 'app' | 'singbox' | 'xray' | 'lan'
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
  /** direct, nothing received yet and several seconds old — likely blocked */
  stalled?: boolean
  upload: number
  download: number
  /** bytes/s since the previous snapshot */
  uploadSpeed: number
  downloadSpeed: number
  /** ms timestamp */
  start: number
}

/**
 * A destination the core could not reach DIRECTLY (dial timeout) — in Russia
 * that usually means it is blocked and needs a «через VPN» rule.
 */
export interface FailedDirect {
  /** IP or host name */
  host: string
  port: string
  /** exe name, if a live connection to it was seen with a known process */
  process?: string
  count: number
  /** ms timestamp of the last failure */
  last: number
  /** the address belongs to Telegram (suggest GEOIP,telegram) */
  telegram?: boolean
}

export interface ConnSnapshot {
  /** false = VPN not connected, list is empty */
  running: boolean
  proxyMode: ProxyMode
  items: ConnItem[]
  /** direct connections that timed out recently (newest first) */
  failed?: FailedDirect[]
}

// ---------------------------------------------------------------------------
// In-app support chat (cabinet API /api/app/v1/support)
// ---------------------------------------------------------------------------

export interface SupportMessage {
  /** stable key for React lists (index + time) */
  key: string
  from: 'you' | 'support'
  text: string
  /** absolute image URL on the support server; load via support.image() */
  image?: string
  /** ISO date */
  at: string
}

export interface SupportThread {
  ticketId: number | null
  status: string | null
  messages: SupportMessage[]
}

export interface SupportMe {
  username: string | null
  hasTelegram: boolean
}

export interface SupportView {
  /** false = no subscription yet, support needs one to log in */
  available: boolean
  thread: SupportThread | null
  me: SupportMe | null
  /** support messages newer than the last time the page was open */
  unread: number
  /** readable error of the last request (Russian), null = OK */
  error: string | null
  /** ms timestamp of the last successful fetch */
  updatedAt: number | null
}

export interface SupportSendResult {
  ticketId: number
  aiOutcome: string | null
  aiReply: string | null
}

export type SupportImageMime = 'image/jpeg' | 'image/png' | 'image/webp'

export interface SupportPhoto {
  data: Uint8Array
  mime: SupportImageMime
  caption: string
}

// ---------------------------------------------------------------------------
// «LAN» — virtual LAN for games (bot API /api/app/v1/lan/*, daemon status)
// ---------------------------------------------------------------------------

export interface LanLimits {
  maxRoomMembers: number
  maxRoomsOwned: number
  /** rooms one may be a member of (own ones included) */
  maxRoomsJoined: number
  maxDevices: number
}

export interface LanMemberDevice {
  name: string
  /** LAN IP (100.64.0.0/10), null if the device has none yet */
  ip: string | null
  online: boolean
}

export interface LanMember {
  memberId: string
  /** display name from the bot (never an e-mail / Telegram id) */
  label: string
  devices: LanMemberDevice[]
  isSelf: boolean
}

export interface LanRoom {
  id: string
  /** only the owner gets it (null for the other members) */
  code: string | null
  name: string
  isOwner: boolean
  members: LanMember[]
}

/** A device of this subscription (a Headscale node). */
export interface LanDevice {
  nodeId: string
  name: string
  ip: string | null
  online: boolean
  /** ISO time, null if unknown */
  lastSeen: string | null
  /** expired on the server (doesn't count towards the device limit) */
  expired?: boolean
  /** this computer */
  isThis?: boolean
}

/** How the daemon reaches a peer right now. */
export interface LanPeerLink {
  ip: string
  online: boolean
  /** direct = peer-to-peer UDP; relay = through the CipherWay relay server */
  path: 'direct' | 'relay' | 'unknown'
  /** the last ping, ms; null = no answer / not measured yet */
  latencyMs: number | null
}

export type LanErrorKind =
  | 'nosub'
  | 'inactive'
  | 'disabled'
  | 'device_limit'
  | 'tailscale_running'
  | 'lan_busy'
  | 'in_use'
  | 'unsafe_address'
  | 'service'
  | 'uac'
  | 'missing'
  | 'daemon'
  | 'login'
  | 'auth'
  | 'rate'
  | 'network'
  | 'server'

export interface LanView {
  /** this build ships the LAN daemon */
  available: boolean
  hasSubscription: boolean
  /** the user's switch (remembered across restarts) */
  enabled: boolean
  phase: 'off' | 'starting' | 'on' | 'error'
  /** what is going on while starting */
  message: string | null
  error: { kind: LanErrorKind; text: string } | null
  /** this computer in the LAN */
  selfIp: string | null
  selfName: string | null
  rooms: LanRoom[]
  /** the last rooms request failed (Russian) */
  roomsError: string | null
  /** by LAN IP */
  links: Record<string, LanPeerLink>
  /** loaded on demand (device limit, «Мои устройства») */
  devices: LanDevice[] | null
  limits: LanLimits | null
}
