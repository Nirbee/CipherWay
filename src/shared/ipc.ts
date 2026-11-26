// Canonical IPC channel names + the shape of the API exposed on window.api.
// Keeping these in /shared guarantees main, preload and renderer stay in sync.

import type {
  AppNotice,
  AppSettings,
  ConnSnapshot,
  ImportRequest,
  LanView,
  LogEntry,
  RoutingMode,
  RoutingRule,
  RulesConfig,
  ServerPing,
  StatusUpdate,
  SubscriptionRefreshResult,
  SubscriptionView,
  SupportPhoto,
  SupportSendResult,
  SupportView,
  TrafficStats,
  TunServiceInfo
} from './types'
import type { UpdaterState } from './updater'
import type { ZapretServiceId, ZapretView } from './zapret'
import type { ChangelogEntry } from './changelog'
import type {
  DevConsentAccept,
  DevDisableResult,
  DevGameCandidate,
  DevStatsView,
  DevStatus
} from './devversion'

export const IPC = {
  // app
  appGetVersion: 'app:getVersion',

  // window controls
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:isMaximized',
  evtWindowMaximized: 'evt:windowMaximized',

  // connection
  connect: 'vpn:connect',
  disconnect: 'vpn:disconnect',
  getStatus: 'vpn:getStatus',
  /** switch Правила / Весь трафик / Напрямую (hot, via the Clash API) */
  setRoutingMode: 'vpn:setRoutingMode',

  // live connections (Clash API)
  connectionsList: 'conn:list',
  connectionsClose: 'conn:close',
  connectionsCloseAll: 'conn:closeAll',
  processIcon: 'conn:processIcon',

  // subscription
  subscriptionFetch: 'sub:fetch',
  subscriptionRefresh: 'sub:refresh',
  subscriptionGet: 'sub:get',

  // servers
  /** real latency through the cores (url-test), not a TCP ping */
  serversPing: 'servers:ping',
  serverSelect: 'servers:select',

  // rules
  rulesGet: 'rules:get',
  rulesSet: 'rules:set',
  rulesExport: 'rules:export',
  rulesImport: 'rules:import',
  rulesOpenText: 'rules:openText',
  rulesSaveText: 'rules:saveText',
  processList: 'rules:processList',
  pickExecutable: 'rules:pickExecutable',

  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  // «Служба TUN»: Task Scheduler task for TUN without a UAC prompt per connect
  tunServiceStatus: 'tun:serviceStatus',
  /** one UAC prompt; also turns the service mode back on */
  tunServiceInstall: 'tun:serviceInstall',
  /** one UAC prompt; TUN asks for admin rights on every connect afterwards */
  tunServiceRemove: 'tun:serviceRemove',

  // cipherway:// deep links (import a subscription)
  deeplinkTakePending: 'deeplink:takePending',

  // open an https:// / tg:// link from the subscription in the system browser
  openExternal: 'app:openExternal',

  // in-app support chat (requests are made by main; the token stays there)
  supportGet: 'support:get',
  supportRefresh: 'support:refresh',
  supportSend: 'support:send',
  supportSendPhoto: 'support:sendPhoto',
  /** support-server image → data: URL (CSP allows only those) */
  supportImage: 'support:image',
  /** «Поддержка» is on screen → poll every 10 s, replies count as read */
  supportSetActive: 'support:setActive',
  supportMarkRead: 'support:markRead',

  // «LAN» (requests to the bot and the daemon are made by main)
  lanGet: 'lan:get',
  /** the switch; on may set up the service (one UAC prompt) */
  lanSetEnabled: 'lan:setEnabled',
  /** «LAN» is on screen → poll often, ping the peers */
  lanSetActive: 'lan:setActive',
  lanRefresh: 'lan:refresh',
  lanCreateRoom: 'lan:createRoom',
  lanJoinRoom: 'lan:joinRoom',
  lanLeaveRoom: 'lan:leaveRoom',
  lanKick: 'lan:kick',
  lanRegenerateCode: 'lan:regenerateCode',
  lanDevices: 'lan:devices',
  lanDeleteDevice: 'lan:deleteDevice',

  // «Ускорение без VPN (zapret)» (src/shared/zapret.ts; main/zapret)
  zapretGet: 'zapret:get',
  /** on: may set up the service (one UAC prompt); `accepted` = the one-time warning */
  zapretSetEnabled: 'zapret:setEnabled',
  zapretSetServices: 'zapret:setServices',
  zapretAddDomain: 'zapret:addDomain',
  zapretRemoveDomain: 'zapret:removeDomain',
  /** «Подобрать заново» */
  zapretRepick: 'zapret:repick',

  // «Что нового» after an update (src/shared/changelog.ts)
  /** the entries to show now ([] = nothing) */
  whatsNewGet: 'whatsNew:get',
  /** the user closed the card with × or «Подробнее»: remember the current version */
  whatsNewSeen: 'whatsNew:seen',

  // «DevVersion» (src/shared/devversion.ts; collector + upload in main/devversion)
  /** cheap status (Settings, sidebar, theme) */
  devGet: 'dev:get',
  /** status + summaries — polled by «Статистика» only while it is on screen */
  devStats: 'dev:stats',
  /** {accepted: true, consentVersion} from the consent dialog */
  devEnable: 'dev:enable',
  /** deleteRemote: boolean — also DELETE the reports on the server */
  devDisable: 'dev:disable',
  devDeleteRemote: 'dev:deleteRemote',
  devSendNow: 'dev:sendNow',
  /** save dialog → the current report (masked) as JSON */
  devSaveReport: 'dev:saveReport',
  devGameCandidates: 'dev:gameCandidates',
  devGameStart: 'dev:gameStart',
  devGameStop: 'dev:gameStop',

  // updater (state: src/shared/updater.ts)
  updaterGetState: 'updater:getState',
  updaterCheck: 'updater:check',
  updaterDownload: 'updater:download',
  updaterInstall: 'updater:install',

  // events (main -> renderer)
  evtStatus: 'evt:status',
  evtTraffic: 'evt:traffic',
  /** batches of log entries (LogEntry[]) */
  evtLog: 'evt:log',
  /** latencies measured by the running core (startup check of «auto») */
  evtPings: 'evt:pings',
  evtSupport: 'evt:support',
  /** main asks the renderer to open a page (notification click) */
  evtNavigate: 'evt:navigate',
  /** the whole UpdaterState on every change */
  evtUpdater: 'evt:updater',
  /** the whole LanView on every change */
  evtLan: 'evt:lan',
  /** the whole ZapretView on every change */
  evtZapret: 'evt:zapret',
  /** settings changed outside the renderer (tray mode switch) */
  evtSettings: 'evt:settings',
  /** subscription data changed (background refresh) */
  evtSubscription: 'evt:subscription',
  /** a toast from main («Ядро перезапущено», two VPNs at once…) */
  evtNotice: 'evt:notice',
  /** payload-less ping: a deep-link import is pending, call deeplink.takePending() */
  evtImportRequest: 'evt:importRequest'
} as const

/** The typed surface bridged into the renderer via contextBridge. */
export interface ExposedApi {
  app: {
    getVersion: () => Promise<string>
    openExternal: (url: string) => Promise<void>
  }
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
  }
  vpn: {
    connect: (outboundId?: string) => Promise<StatusUpdate>
    disconnect: () => Promise<StatusUpdate>
    getStatus: () => Promise<StatusUpdate>
    setRoutingMode: (mode: RoutingMode) => Promise<AppSettings>
  }
  subscription: {
    fetch: (url: string) => Promise<SubscriptionView>
    refresh: () => Promise<SubscriptionRefreshResult>
    get: () => Promise<SubscriptionView | null>
  }
  connections: {
    list: () => Promise<ConnSnapshot>
    close: (id: string) => Promise<void>
    closeAll: () => Promise<void>
    /** data: URL of the exe icon, null if unavailable */
    icon: (exePath: string) => Promise<string | null>
  }
  servers: {
    ping: () => Promise<ServerPing[]>
    select: (outboundId: string) => Promise<void>
  }
  rules: {
    get: () => Promise<RulesConfig>
    set: (config: RulesConfig) => Promise<void>
    export: () => Promise<string | null>
    import: () => Promise<RulesConfig | null>
    /** read a rules file chosen by the user as text (for the text editor) */
    openText: () => Promise<string | null>
    /** save Clash rule lines to a file chosen by the user */
    saveText: (text: string) => Promise<string | null>
    processList: () => Promise<{ name: string; path: string; pid: number }[]>
    pickExecutable: () => Promise<{ name: string; path: string } | null>
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>
  }
  tunService: {
    status: () => Promise<TunServiceInfo>
    install: () => Promise<TunServiceInfo>
    remove: () => Promise<TunServiceInfo>
  }
  deeplink: {
    /** returns (and clears) the pending cipherway:// import, if any */
    takePending: () => Promise<ImportRequest | null>
  }
  support: {
    /** last known state, no request */
    get: () => Promise<SupportView>
    /** fetch the thread now */
    refresh: () => Promise<SupportView>
    send: (text: string) => Promise<SupportSendResult>
    sendPhoto: (photo: SupportPhoto) => Promise<SupportSendResult>
    image: (url: string) => Promise<string>
    setActive: (active: boolean) => void
    markRead: () => void
  }
  lan: {
    get: () => Promise<LanView>
    setEnabled: (on: boolean) => Promise<LanView>
    setActive: (active: boolean) => void
    /** rooms from the bot now */
    refresh: () => Promise<LanView>
    createRoom: (name: string) => Promise<LanView>
    joinRoom: (code: string) => Promise<LanView>
    leaveRoom: (roomId: string) => Promise<LanView>
    kick: (roomId: string, memberId: string) => Promise<LanView>
    regenerateCode: (roomId: string) => Promise<LanView>
    /** this subscription's LAN devices (view.devices) */
    devices: () => Promise<LanView>
    deleteDevice: (nodeId: string) => Promise<LanView>
  }
  zapret: {
    get: () => Promise<ZapretView>
    setEnabled: (on: boolean, accepted?: boolean) => Promise<ZapretView>
    setServices: (ids: ZapretServiceId[]) => Promise<ZapretView>
    /** throws with a readable reason when the domain is not accepted */
    addDomain: (domain: string) => Promise<ZapretView>
    removeDomain: (domain: string) => Promise<ZapretView>
    repick: () => Promise<ZapretView>
  }
  whatsNew: {
    get: () => Promise<ChangelogEntry[]>
    seen: () => void
  }
  dev: {
    get: () => Promise<DevStatus>
    stats: () => Promise<DevStatsView>
    enable: (accept: DevConsentAccept) => Promise<DevStatus>
    disable: (deleteRemote: boolean) => Promise<DevDisableResult>
    /** reports deleted on the server */
    deleteRemote: () => Promise<number>
    sendNow: () => Promise<DevStatus>
    /** the saved file's path, null = cancelled */
    saveReport: () => Promise<string | null>
    gameCandidates: () => Promise<DevGameCandidate[]>
    gameStart: (process: string) => Promise<DevStatsView>
    gameStop: () => Promise<DevStatsView>
  }
  updater: {
    getState: () => Promise<UpdaterState>
    /** manual check; failures come back as phase 'error' */
    check: () => Promise<UpdaterState>
    download: () => Promise<UpdaterState>
    /** stops the cores, then quits into the installer */
    install: () => void
  }
  on: {
    status: (cb: (s: StatusUpdate) => void) => () => void
    traffic: (cb: (s: TrafficStats) => void) => () => void
    log: (cb: (batch: LogEntry[]) => void) => () => void
    pings: (cb: (pings: ServerPing[]) => void) => () => void
    support: (cb: (v: SupportView) => void) => () => void
    navigate: (cb: (page: string) => void) => () => void
    updater: (cb: (s: UpdaterState) => void) => () => void
    lan: (cb: (v: LanView) => void) => () => void
    zapret: (cb: (v: ZapretView) => void) => () => void
    windowMaximized: (cb: (maximized: boolean) => void) => () => void
    importRequest: (cb: () => void) => () => void
    settings: (cb: (s: AppSettings) => void) => () => void
    subscription: (cb: (s: SubscriptionView | null) => void) => () => void
    notice: (cb: (n: AppNotice) => void) => () => void
  }
}

export type { RoutingRule }
