// Canonical IPC channel names + the shape of the API exposed on window.api.
// Keeping these in /shared guarantees main, preload and renderer stay in sync.

import type {
  AppSettings,
  LogEntry,
  RoutingRule,
  RulesConfig,
  ServerPing,
  StatusUpdate,
  SubscriptionData,
  TrafficStats
} from './types'

export const IPC = {
  // window controls
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:isMaximized',

  // connection
  connect: 'vpn:connect',
  disconnect: 'vpn:disconnect',
  getStatus: 'vpn:getStatus',

  // subscription
  subscriptionFetch: 'sub:fetch',
  subscriptionRefresh: 'sub:refresh',
  subscriptionGet: 'sub:get',

  // servers
  serversPing: 'servers:ping',
  serverSelect: 'servers:select',

  // rules
  rulesGet: 'rules:get',
  rulesSet: 'rules:set',
  rulesExport: 'rules:export',
  rulesImport: 'rules:import',
  processList: 'rules:processList',
  pickExecutable: 'rules:pickExecutable',

  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  // updater
  updaterCheck: 'updater:check',
  updaterDownload: 'updater:download',
  updaterInstall: 'updater:install',

  // events (main -> renderer)
  evtStatus: 'evt:status',
  evtTraffic: 'evt:traffic',
  evtLog: 'evt:log',
  evtUpdater: 'evt:updater'
} as const

export interface UpdaterEvent {
  type: 'checking' | 'available' | 'not-available' | 'progress' | 'downloaded' | 'error'
  version?: string
  percent?: number
  message?: string
}

/** The typed surface bridged into the renderer via contextBridge. */
export interface ExposedApi {
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
  }
  subscription: {
    fetch: (url: string) => Promise<SubscriptionData>
    refresh: () => Promise<SubscriptionData>
    get: () => Promise<SubscriptionData | null>
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
    processList: () => Promise<{ name: string; path: string; pid: number }[]>
    pickExecutable: () => Promise<{ name: string; path: string } | null>
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>
  }
  updater: {
    check: () => Promise<void>
    download: () => Promise<void>
    install: () => void
  }
  on: {
    status: (cb: (s: StatusUpdate) => void) => () => void
    traffic: (cb: (s: TrafficStats) => void) => () => void
    log: (cb: (e: LogEntry) => void) => () => void
    updater: (cb: (e: UpdaterEvent) => void) => () => void
  }
}

export type { RoutingRule }
