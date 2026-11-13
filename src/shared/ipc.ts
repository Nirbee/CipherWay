// Canonical IPC channel names + the shape of the API exposed on window.api.
// Keeping these in /shared guarantees main, preload and renderer stay in sync.

import type {
  AppNotice,
  AppSettings,
  ConnSnapshot,
  ImportRequest,
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
    windowMaximized: (cb: (maximized: boolean) => void) => () => void
    importRequest: (cb: () => void) => () => void
    settings: (cb: (s: AppSettings) => void) => () => void
    subscription: (cb: (s: SubscriptionView | null) => void) => () => void
    notice: (cb: (n: AppNotice) => void) => () => void
  }
}

export type { RoutingRule }
