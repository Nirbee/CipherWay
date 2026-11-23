import { writeFile, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, ipcMain, dialog, shell, Notification, powerMonitor } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import { PING_TIMEOUT_MAX_S, PING_TIMEOUT_MIN_S } from '@shared/types'
import type {
  AppNotice,
  AppSettings,
  AutoInfo,
  ConnSnapshot,
  LogEntry,
  RoutingMode,
  RulesConfig,
  ServerPing,
  StatusUpdate,
  SubscriptionData,
  SubscriptionRefreshResult,
  SubscriptionView,
  SupportView,
  TunServiceInfo,
  LanView
} from '@shared/types'
import { LogBatcher } from '@shared/logBuffer'
import { DEFAULT_SETTINGS, getSettings, store } from '../store'
import {
  findOtherVpnClients,
  listProcesses,
  runningProcessNames,
  waitProcessesGone
} from '../system/processes'
import { remnawave } from '../remnawave/RemnawaveClient'
import { SubscriptionSync } from '../remnawave/SubscriptionSync'
import { toSubscriptionView } from '../remnawave/view'
import { getSubscriptionUrl } from '../secrets'
import { createMasker, type Masker } from '../mask'
import { SidecarManager } from '../core/SidecarManager'
import { AdapterGate } from '../core/adapterGate'
import { nodeAddressSet, toConnItems } from '../core/connections'
import { AppUpdater } from '../updater/AppUpdater'
import { electronUpdaterBackend } from '../updater/electronBackend'
import { devFakeBackend } from '../updater/devFakeBackend'
import type { UpdaterState } from '@shared/updater'
import { CORE_EXE, LAN_EXE, XRAY_EXE } from '../core/coreNames'
import {
  SUPPORT_CAPTION_MAX,
  SUPPORT_IMAGE_MAX_BYTES,
  SUPPORT_IMAGE_MIMES,
  SUPPORT_TEXT_MAX,
  SupportClient,
  subscriptionToken
} from '../support/client'
import { SupportService } from '../support/SupportService'
import { createLanService } from '../lan'
import type { LanService } from '../lan/LanService'
import { LanLogFolder } from '../lan/logLines'
import { whatsNew, type ChangelogEntry } from '@shared/changelog'
import { DEV_STATUS_OFF } from '@shared/devversion'
import { devAcceptSchema, devProcessSchema } from '../devversion/consent'
import { DevVersionService } from '../devversion/DevVersionService'
import { TelemetryApi } from '../devversion/api'

/** Set once handlers are registered; used for graceful shutdown / startup. */
export let activeManager: SidecarManager | null = null
export let appUpdater: AppUpdater | null = null
export let supportService: SupportService | null = null
export let lanService: LanService | null = null
export let devService: DevVersionService | null = null

type GetWindow = () => BrowserWindow | null

export interface HandlerHooks {
  /** bring the main window to the front (notification click) */
  showWindow: () => void
  /** icon for Windows notifications */
  notificationIcon?: string
}

/** rules are applied to the running core this long after the last edit */
const RULES_DEBOUNCE_MS = 700

// --- zod validation schemas for inbound IPC payloads ----------------------

export const CONDITION_TYPES = [
  'ProcessName',
  'ProcessPath',
  'Domain',
  'DomainSuffix',
  'DomainKeyword',
  'DomainRegex',
  'GeoSite',
  'GeoIP',
  'IPCIDR',
  'DstPort'
] as const

const ruleSchema = z.object({
  id: z.string().max(100),
  enabled: z.boolean(),
  conditionType: z.enum(CONDITION_TYPES),
  value: z.string().max(2000),
  action: z.string().max(200)
})

const rulesConfigSchema = z.object({
  defaultBehavior: z.enum(['proxy', 'direct', 'auto']),
  rules: z.array(ruleSchema).max(20_000)
})

const routingModeSchema = z.enum(['rule', 'global', 'direct'])

/** https:// or tg:// only — these links come from the subscription / settings */
const externalUrlSchema = z
  .string()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v)
      return u.protocol === 'https:' || u.protocol === 'tg:'
    } catch {
      return false
    }
  }, 'unsupported link')

/** support API base: https only, no credentials / query in it */
const apiBaseSchema = z
  .string()
  .max(300)
  .refine((v) => {
    try {
      const u = new URL(v)
      return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
    } catch {
      return false
    }
  }, 'нужен адрес https://')

const settingsPatchSchema = z
  .object({
    proxyMode: z.enum(['system', 'tun']),
    routingMode: routingModeSchema,
    supportUrl: z.union([z.literal(''), externalUrlSchema]),
    autoLaunch: z.boolean(),
    autoConnect: z.boolean(),
    language: z.enum(['ru', 'en']),
    socksPort: z.number().int().min(1).max(65535),
    httpPort: z.number().int().min(1).max(65535),
    subscriptionRefreshHours: z.number().int().min(1).max(168),
    verboseLog: z.boolean(),
    apiBase: apiBaseSchema,
    pingMode: z.enum(['keepalive', 'connect', 'tcp']),
    pingTimeoutSec: z.number().int().min(PING_TIMEOUT_MIN_S).max(PING_TIMEOUT_MAX_S)
  })
  .partial()

const supportPhotoSchema = z.object({
  data: z
    .instanceof(Uint8Array)
    .refine(
      (d) => d.byteLength > 0 && d.byteLength <= SUPPORT_IMAGE_MAX_BYTES,
      'Картинка больше 10 МБ'
    ),
  mime: z.enum(SUPPORT_IMAGE_MIMES as [string, ...string[]]),
  caption: z.string().max(SUPPORT_CAPTION_MAX)
})

// «LAN»: ids from the bot, a room name, a room code
const lanIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w-]+$/, 'bad id')
const lanRoomNameSchema = z
  .string()
  .trim()
  .min(1, 'Назовите комнату')
  .max(40, 'Не длиннее 40 символов')
const lanCodeSchema = z.string().max(20)

const exePathSchema = z
  .string()
  .max(1024)
  .refine((p) => isAbsolute(p) && /\.exe$/i.test(p), 'not an exe path')

// runtime connection status, owned by the SidecarManager callbacks
let status: StatusUpdate = { state: 'disconnected' }
const statusListeners = new Set<(s: StatusUpdate) => void>()
const settingsListeners = new Set<(s: AppSettings) => void>()

/** Subscribe to connection status changes (used by the tray). */
export function onVpnStatus(cb: (s: StatusUpdate) => void): () => void {
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
}

/** Subscribe to settings changes from any source (renderer, tray). */
export function onSettingsChange(cb: (s: AppSettings) => void): () => void {
  settingsListeners.add(cb)
  return () => settingsListeners.delete(cb)
}

export function getVpnStatus(): StatusUpdate {
  return status
}

function buildStartParams() {
  const sub = remnawave.getCached()
  return {
    outbounds: sub?.outbounds ?? [],
    activeOutboundId: store.get('activeOutboundId') ?? undefined,
    rules: store.get('rules'),
    settings: getSettings(),
    latencies: store.get('latencyCache') ?? {},
    // its refresh must work while the tunnel is broken (a stale REALITY key);
    // DevVersion: the bot's host too — the server tells the provider by the IP
    directHosts: [...new Set([...subscriptionHosts(), ...devApiHosts()])],
    // LAN on: its daemon (the service's copy) and its login server bypass the VPN
    ...(lanWanted() ? { lan: { exePath: lanExePath, loginHost: lanLoginHost() } } : {})
  }
}

function lanWanted(): boolean {
  return store.get('lanEnabled') === true && !!lanExePath
}

/** <ProgramData>/CipherWay/bin/cipherway-lan.exe — known once the handlers are up */
let lanExePath = ''

/** Host of the LAN login server the bot gave last (undefined = the default). */
function lanLoginHost(): string | undefined {
  const url = store.get('lanLoginServer')
  if (!url) return undefined
  try {
    return new URL(url).hostname || undefined
  } catch {
    return undefined
  }
}

/** Host of the subscription link (empty if none / unparsable). */
function subscriptionHosts(): string[] {
  const url = getSubscriptionUrl()
  if (!url) return []
  try {
    const host = new URL(url).hostname
    return host ? [host] : []
  } catch {
    return []
  }
}

/** DevVersion on: the bot API's host (its reports must not go through the VPN). */
function devApiHosts(): string[] {
  if (store.get('devVersion')?.enabled !== true) return []
  const host = TelemetryApi.host(getSettings().apiBase)
  return host ? [host] : []
}

/** Remembers latencies across runs (orders «Лучший сервер (авто)» next time). */
function saveLatencies(pings: ServerPing[], known: Set<string>): void {
  const next: Record<string, number | null> = {}
  const prev = store.get('latencyCache') ?? {}
  for (const [id, v] of Object.entries(prev)) if (known.has(id)) next[id] = v
  for (const p of pings) next[p.outboundId] = p.latencyMs
  store.set('latencyCache', next)
}

let connectImpl: ((outboundId?: string) => Promise<StatusUpdate>) | null = null
let disconnectImpl: (() => Promise<StatusUpdate>) | null = null
let routingModeImpl: ((mode: RoutingMode) => Promise<AppSettings>) | null = null
let subscriptionSync: SubscriptionSync | null = null

/** At app start: fetch the subscription + keep it fresh from now on. */
export function startSubscriptionSync(): void {
  subscriptionSync?.start()
}

/** Connect / disconnect from outside the renderer (tray menu). */
export function connectVpn(outboundId?: string): Promise<StatusUpdate> {
  return connectImpl ? connectImpl(outboundId) : Promise.resolve(status)
}
export function disconnectVpn(): Promise<StatusUpdate> {
  return disconnectImpl ? disconnectImpl() : Promise.resolve(status)
}
/** Правила / Весь трафик / Напрямую from the tray. */
export function setRoutingMode(mode: RoutingMode): Promise<AppSettings> {
  return routingModeImpl ? routingModeImpl(mode) : Promise.resolve(getSettings())
}

export function registerIpcHandlers(getWindow: GetWindow, hooks?: HandlerHooks): void {
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  status = { state: 'disconnected', activeOutboundId: store.get('activeOutboundId') ?? undefined }
  let serverHints: Record<string, string> = {}
  const publish = (next: StatusUpdate): void => {
    devService?.onVpnStatus(next.state)
    status = { ...next, serverHints }
    send(IPC.evtStatus, status)
    for (const cb of statusListeners) cb(status)
  }
  const publishSettings = (s: AppSettings): void => {
    send(IPC.evtSettings, s)
    for (const cb of settingsListeners) cb(s)
  }

  // node addresses / credentials / the subscription link never reach the UI log
  let mask: Masker = (t) => t
  let serverIps: string[] = []
  const rebuildMask = (data: SubscriptionData | null): void => {
    mask = createMasker({
      outbounds: data?.outbounds ?? [],
      subscriptionUrl: getSubscriptionUrl(),
      extraHosts: serverIps
    })
  }
  rebuildMask(remnawave.getCached())
  const view = (data: SubscriptionData | null): SubscriptionView | null =>
    toSubscriptionView(data, getSubscriptionUrl())
  let supportToken = subscriptionToken(getSubscriptionUrl())
  remnawave.onUpdate((d) => {
    rebuildMask(d)
    send(IPC.evtSubscription, view(remnawave.getCached()))
    // another subscription = another support account
    const token = subscriptionToken(getSubscriptionUrl())
    if (token !== supportToken) {
      supportToken = token
      supportService?.reset()
    }
  })

  // the cores can print thousands of lines a minute: one IPC message per batch
  const logBatcher = new LogBatcher((batch: LogEntry[]) => send(IPC.evtLog, batch))
  const notify = (notice: AppNotice): void => send(IPC.evtNotice, notice)
  const appLog = (level: LogEntry['level'], message: string): void =>
    logBatcher.push({ ts: Date.now(), level, source: 'app', message: mask(message) })

  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())
  ipcMain.handle(IPC.openExternal, async (_e, url: unknown) => {
    await shell.openExternal(externalUrlSchema.parse(url))
  })

  let auto: AutoInfo = { checking: false, dead: false }
  const autoFields = (connected: boolean): Partial<StatusUpdate> =>
    connected
      ? {
          autoSelectedId: auto.nodeId,
          autoDelayMs: auto.delayMs,
          autoChecking: auto.checking,
          autoDead: auto.dead
        }
      : {}
  const knownIds = (): Set<string> =>
    new Set((remnawave.getCached()?.outbounds ?? []).map((o) => o.id))
  // the TUN core and the LAN daemon create their wintun adapters one at a time
  const adapterGate = new AdapterGate()
  const manager = new SidecarManager(
    (entry) => logBatcher.push({ ...entry, message: mask(entry.message) }),
    (state, message) => {
      publish({
        state,
        activeOutboundId: store.get('activeOutboundId') ?? undefined,
        ...autoFields(state === 'connected'),
        message: message ? mask(message) : undefined
      })
    },
    (traffic) => send(IPC.evtTraffic, traffic),
    (info) => {
      auto = info
      if (status.state === 'connected') publish({ ...status, ...autoFields(true) })
    },
    (pings) => {
      saveLatencies(pings, knownIds())
      send(IPC.evtPings, pings)
    },
    (ips) => {
      serverIps = ips
      rebuildMask(remnawave.getCached())
    },
    {
      onNotice: notify,
      adapterGate,
      // the store, not the snapshot a queued start / reload was built with
      routingMode: () => getSettings().routingMode,
      pingMode: () => getSettings().pingMode,
      onRealityHeal: (ids) => void sync.heal(ids).finally(() => manager.realityHealDone()),
      onServerHints: (hints) => {
        serverHints = hints
        publish(status)
      },
      // DevVersion: the snapshots / log lines the manager sees anyway
      onConnections: (raw) => devService?.onConnections(raw),
      onCoreLine: (source, line, nodeId) => devService?.onCoreLine(source, line, nodeId)
    }
  )

  const sync = new SubscriptionSync({
    url: getSubscriptionUrl,
    fetch: (url, timeoutMs) => remnawave.fetchSubscription(url, timeoutMs),
    cached: () => remnawave.getCached(),
    getActive: () => store.get('activeOutboundId'),
    setActive: (id) => store.set('activeOutboundId', id),
    getLatencies: () => store.get('latencyCache') ?? {},
    setLatencies: (v) => store.set('latencyCache', v),
    settingHours: () => getSettings().subscriptionRefreshHours,
    running: () => manager.runningOutbounds,
    applyToCore: async () => {
      if (manager.reloadNeedsPrompt) {
        // TUN without the service: a restart would ask for admin rights out of the blue
        notify({ text: 'Подписка обновилась — переподключитесь, чтобы применить', tone: 'info' })
        return
      }
      if (manager.isRunning) notify({ text: 'Серверы обновились — применяем', tone: 'info' })
      // queued: also covers a start that is running right now; no-op while disconnected
      await manager.reload(buildStartParams())
    },
    activeChanged: (id) => publish({ ...status, activeOutboundId: id }),
    log: appLog,
    notify: (text, tone) => notify({ text, tone })
  })
  subscriptionSync = sync
  // an old cache may hold a selection that is hidden now («⚡ Автовыбор»)
  sync.migrateActive()
  status = { state: 'disconnected', activeOutboundId: store.get('activeOutboundId') ?? undefined }

  // expose so app shutdown can stop cores gracefully
  activeManager = manager

  // ---- connection --------------------------------------------------------
  /** Two VPNs at once: a word of warning, nothing is blocked. */
  const warnOtherVpn = async (): Promise<void> => {
    const others = findOtherVpnClients(await runningProcessNames())
    if (others.length === 0) return
    const text = `Запущен ${others.join(', ')}. Два VPN одновременно могут мешать друг другу.`
    appLog('warn', text)
    notify({ text, tone: 'info' })
  }

  /** bumped by every connect / disconnect: a connect still fetching the subscription gives up */
  let connectGen = 0
  connectImpl = async (outboundId?: string): Promise<StatusUpdate> => {
    if (outboundId) store.set('activeOutboundId', z.string().max(100).parse(outboundId))
    // already connected: just switch the server (start() would be a no-op)
    if (manager.isRunning) {
      if (outboundId && !(await manager.selectServer(outboundId))) {
        await manager.reload(buildStartParams()).catch(() => undefined)
      }
      return status
    }
    const gen = ++connectGen
    publish({
      state: 'connecting',
      activeOutboundId: store.get('activeOutboundId') ?? undefined,
      message: 'Обновляем подписку…'
    })
    if (getSettings().proxyMode === 'tun') void warnOtherVpn().catch(() => undefined)
    await sync.beforeConnect()
    // «Отмена» while the subscription was loading: stop() has already reported it
    if (gen !== connectGen) return status
    try {
      await manager.start(buildStartParams())
    } catch (err) {
      // keep a more specific message the manager may already have published
      if (status.state !== 'error') {
        publish({
          state: 'error',
          message: mask(err instanceof Error ? err.message : String(err))
        })
      }
    }
    return status
  }
  disconnectImpl = async (): Promise<StatusUpdate> => {
    connectGen++
    await manager.stop()
    return status
  }
  routingModeImpl = async (mode: RoutingMode): Promise<AppSettings> => {
    const next = { ...getSettings(), routingMode: mode }
    store.set('settings', next)
    publishSettings(next)
    if (manager.isRunning) {
      const ok = await manager.setRoutingMode(mode)
      // the core didn't take the mode (GET /configs shows another one) — a new
      // config with the mode as its default_mode
      if (!ok) await manager.reload(buildStartParams()).catch(() => undefined)
    }
    return next
  }

  ipcMain.handle(IPC.connect, async (_e, outboundId?: unknown) =>
    connectImpl!(
      z
        .string()
        .max(100)
        .optional()
        .parse(outboundId ?? undefined)
    )
  )

  ipcMain.handle(IPC.disconnect, async () => disconnectImpl!())

  ipcMain.handle(IPC.getStatus, async () => status)

  ipcMain.handle(IPC.setRoutingMode, async (_e, mode: unknown) =>
    routingModeImpl!(routingModeSchema.parse(mode))
  )

  // ---- subscription ------------------------------------------------------
  ipcMain.handle(IPC.subscriptionFetch, async (_e, url: unknown) => {
    const parsed = z.string().url().max(2000).parse(url)
    const res = await sync.fetchUrl(parsed)
    return view(res.data)
  })

  ipcMain.handle(IPC.subscriptionRefresh, async (): Promise<SubscriptionRefreshResult> => {
    const res = await sync.refresh()
    return { view: view(res.data), changed: res.changed }
  })

  ipcMain.handle(IPC.subscriptionGet, async () => view(remnawave.getCached()))

  // ---- servers -----------------------------------------------------------
  ipcMain.handle(IPC.serversPing, async (): Promise<ServerPing[]> => {
    const outbounds = remnawave.getCached()?.outbounds ?? []
    const { pingMode, pingTimeoutSec } = getSettings()
    const res = await manager.testLatency(outbounds, {
      mode: pingMode,
      timeoutMs: pingTimeoutSec * 1000
    })
    // a «nothing answered» probe (e.g. offline) must not reorder the group; a TCP
    // ping says nothing about the tunnel — it never orders «Лучший сервер»
    if (pingMode !== 'tcp' && res.some((r) => r.latencyMs !== null)) {
      saveLatencies(res, knownIds())
    }
    return res
  })

  ipcMain.handle(IPC.serverSelect, async (_e, outboundId: unknown) => {
    const id = z.string().max(100).parse(outboundId)
    store.set('activeOutboundId', id)
    if (manager.isRunning) {
      const ok = await manager.selectServer(id)
      if (!ok) await manager.reload(buildStartParams()).catch(() => undefined)
    }
    publish({ ...status, activeOutboundId: id })
  })

  // ---- live connections --------------------------------------------------
  const prevConn = new Map<string, { upload: number; download: number; ts: number }>()
  const iconCache = new Map<string, string | null>()

  ipcMain.handle(IPC.connectionsList, async (): Promise<ConnSnapshot> => {
    const api = manager.clash
    const snapshot: ConnSnapshot = { running: !!api, proxyMode: manager.proxyMode, items: [] }
    if (!api) {
      prevConn.clear()
      return snapshot
    }
    const raw = await api.connections()
    if (!raw) return snapshot
    const now = Date.now()
    const outbounds = remnawave.getCached()?.outbounds ?? []
    snapshot.items = toConnItems(raw, {
      outbounds,
      prev: prevConn,
      now,
      labels: manager.labels,
      programs: manager.programs
    })
    manager.failures.noteConnections(snapshot.items, now)
    snapshot.failed = manager.failures.list(
      new Set([...nodeAddressSet(outbounds), ...serverIps]),
      now
    )
    prevConn.clear()
    for (const c of snapshot.items) {
      prevConn.set(c.id, { upload: c.upload, download: c.download, ts: now })
    }
    return snapshot
  })

  ipcMain.handle(IPC.connectionsClose, async (_e, id: unknown) => {
    await manager.clash?.closeConnection(z.string().max(100).parse(id))
  })

  ipcMain.handle(IPC.connectionsCloseAll, async () => {
    await manager.clash?.closeAll()
  })

  ipcMain.handle(IPC.processIcon, async (_e, p: unknown): Promise<string | null> => {
    const path = exePathSchema.parse(p)
    const key = path.toLowerCase()
    if (iconCache.has(key)) return iconCache.get(key) ?? null
    let url: string | null = null
    try {
      const img = await app.getFileIcon(path, { size: 'normal' })
      url = img.isEmpty() ? null : img.toDataURL()
    } catch {
      url = null
    }
    if (iconCache.size > 500) iconCache.clear()
    iconCache.set(key, url)
    return url
  })

  // ---- rules -------------------------------------------------------------
  // Saved at once; applied to the running core ~0.7 s after the last change
  // (one application for a burst of edits / drag & drop), without a restart.
  let rulesTimer: NodeJS.Timeout | null = null
  const scheduleRulesApply = (): void => {
    if (rulesTimer) clearTimeout(rulesTimer)
    rulesTimer = setTimeout(() => {
      rulesTimer = null
      if (manager.isRunning) void manager.applyRules(buildStartParams()).catch(() => undefined)
    }, RULES_DEBOUNCE_MS)
  }

  ipcMain.handle(IPC.rulesGet, async (): Promise<RulesConfig> => store.get('rules'))

  ipcMain.handle(IPC.rulesSet, async (_e, config: unknown) => {
    const parsed = rulesConfigSchema.parse(config)
    store.set('rules', parsed)
    scheduleRulesApply()
  })

  ipcMain.handle(IPC.rulesExport, async (): Promise<string | null> => {
    const win = getWindow()
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Экспорт правил',
      defaultPath: 'cipherway-rules.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, JSON.stringify(store.get('rules'), null, 2), 'utf8')
    return filePath
  })

  ipcMain.handle(IPC.rulesImport, async (): Promise<RulesConfig | null> => {
    const win = getWindow()
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Импорт правил',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || filePaths.length === 0) return null
    const raw = await readFile(filePaths[0], 'utf8')
    const parsed = rulesConfigSchema.parse(JSON.parse(raw))
    store.set('rules', parsed)
    scheduleRulesApply()
    return parsed
  })

  ipcMain.handle(IPC.rulesOpenText, async (): Promise<string | null> => {
    const win = getWindow()
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Открыть файл правил',
      properties: ['openFile'],
      filters: [
        {
          name: 'Правила (YAML, JSON, текст)',
          extensions: ['yaml', 'yml', 'json', 'txt', 'list', 'conf']
        },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) return null
    const st = await stat(filePaths[0])
    if (st.size > 4 * 1024 * 1024) throw new Error('Файл слишком большой (больше 4 МБ)')
    return readFile(filePaths[0], 'utf8')
  })

  ipcMain.handle(IPC.rulesSaveText, async (_e, text: unknown): Promise<string | null> => {
    const body = z
      .string()
      .max(4 * 1024 * 1024)
      .parse(text)
    const win = getWindow()
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Сохранить правила',
      defaultPath: 'cipherway-rules.txt',
      filters: [
        { name: 'Текст', extensions: ['txt'] },
        { name: 'YAML', extensions: ['yaml'] }
      ]
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, body, 'utf8')
    return filePath
  })

  ipcMain.handle(IPC.processList, async () => listProcesses())

  ipcMain.handle(IPC.pickExecutable, async (): Promise<{ name: string; path: string } | null> => {
    const win = getWindow()
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Выбрать исполняемый файл',
      properties: ['openFile'],
      filters: [{ name: 'Программы', extensions: ['exe'] }]
    })
    if (canceled || filePaths.length === 0) return null
    const path = filePaths[0]
    return { name: path.split(/[\\/]/).pop() ?? path, path }
  })

  // ---- settings ----------------------------------------------------------
  ipcMain.handle(IPC.settingsGet, async (): Promise<AppSettings> => getSettings())

  ipcMain.handle(IPC.settingsSet, async (_e, patch: unknown): Promise<AppSettings> => {
    const parsed = settingsPatchSchema.parse(patch)
    const prev = getSettings()
    if (parsed.routingMode && parsed.routingMode !== prev.routingMode) {
      await routingModeImpl!(parsed.routingMode)
    }
    const next = { ...DEFAULT_SETTINGS, ...getSettings(), ...parsed }
    store.set('settings', next)
    if ('autoLaunch' in parsed) {
      app.setLoginItemSettings({ openAtLogin: next.autoLaunch })
    }
    publishSettings(next)
    // TUN <-> system proxy needs a new core (TUN asks for UAC again)
    if (parsed.proxyMode && parsed.proxyMode !== prev.proxyMode && manager.isRunning) {
      void manager.reload(buildStartParams()).catch(() => undefined)
    }
    if (parsed.apiBase && parsed.apiBase !== prev.apiBase) {
      support.reset()
      void syncDirectHosts()
    }
    return next
  })

  // ---- «Служба TUN» (Task Scheduler) --------------------------------------
  const setTunService = (on: boolean): void => {
    const next = { ...getSettings(), tunService: on }
    store.set('settings', next)
    publishSettings(next)
  }
  ipcMain.handle(IPC.tunServiceStatus, async (): Promise<TunServiceInfo> =>
    manager.tunServiceStatus()
  )
  ipcMain.handle(IPC.tunServiceInstall, async (): Promise<TunServiceInfo> => {
    const res = await manager.installTunService()
    if (res === 'cancelled') throw new Error('Запрос прав администратора отклонён')
    if (res === 'failed') throw new Error('Не удалось установить службу — подробности в «Журнале»')
    setTunService(true)
    return manager.tunServiceStatus()
  })
  ipcMain.handle(IPC.tunServiceRemove, async (): Promise<TunServiceInfo> => {
    // the LAN task goes with the service: LAN off first
    if (store.get('lanEnabled')) await lan.setEnabled(false)
    const res = await manager.removeTunService()
    if (res === 'cancelled') throw new Error('Запрос прав администратора отклонён')
    if (res === 'failed') throw new Error('Не удалось удалить службу')
    // from now on TUN asks for admin rights on every connect, until reinstalled
    setTunService(false)
    return manager.tunServiceStatus()
  })

  // ---- support chat ------------------------------------------------------
  const client = new SupportClient(async () => ({
    apiBase: getSettings().apiBase,
    subscriptionUrl: getSubscriptionUrl(),
    deviceHeaders: await remnawave.deviceHeaders()
  }))
  const support = new SupportService({
    client,
    hasSubscription: () => !!subscriptionToken(getSubscriptionUrl()),
    getReadAt: () => store.get('supportReadAt') ?? null,
    setReadAt: (v) => store.set('supportReadAt', v),
    getNotifiedAt: () => store.get('supportNotifiedAt') ?? null,
    setNotifiedAt: (v) => store.set('supportNotifiedAt', v),
    publish: (v: SupportView) => send(IPC.evtSupport, v),
    notify: (text) => {
      if (!Notification.isSupported()) return
      const n = new Notification({
        title: 'Ответ поддержки CipherWay',
        body: text,
        ...(hooks?.notificationIcon ? { icon: hooks.notificationIcon } : {})
      })
      n.on('click', () => {
        hooks?.showWindow()
        send(IPC.evtNavigate, 'support')
      })
      n.show()
    },
    isWindowFocused: () => {
      const win = getWindow()
      return !!win && !win.isDestroyed() && win.isVisible() && win.isFocused()
    }
  })
  supportService = support
  support.start()

  ipcMain.handle(IPC.supportGet, async (): Promise<SupportView> => support.view())
  ipcMain.handle(IPC.supportRefresh, async (): Promise<SupportView> => support.refresh())
  ipcMain.handle(IPC.supportSend, async (_e, text: unknown) => {
    const body = z
      .string()
      .min(1)
      .max(SUPPORT_TEXT_MAX * 2)
      .parse(text)
    // node addresses / the subscription link never leave the machine
    return support.send(mask(body).slice(0, SUPPORT_TEXT_MAX))
  })
  ipcMain.handle(IPC.supportSendPhoto, async (_e, photo: unknown) => {
    const p = supportPhotoSchema.parse(photo)
    return support.sendPhoto({
      data: p.data,
      mime: p.mime as (typeof SUPPORT_IMAGE_MIMES)[number],
      caption: mask(p.caption)
    })
  })
  ipcMain.handle(IPC.supportImage, async (_e, url: unknown) =>
    support.image(z.string().url().max(2000).parse(url))
  )
  ipcMain.on(IPC.supportSetActive, (_e, active: unknown) => {
    support.setActive(z.boolean().parse(active))
  })
  ipcMain.on(IPC.supportMarkRead, () => support.markRead())

  // ---- «LAN» ---------------------------------------------------------------
  const lanLog = (level: LogEntry['level'], message: string): void =>
    logBatcher.push({ ts: Date.now(), level, source: 'lan', message: mask(message) })
  lanExePath = join(manager.tunService.root, 'bin', LAN_EXE)
  /** the LAN bypass in the running core = what the switch says (hot reload) */
  const syncLanBypass = async (): Promise<void> => {
    if (!manager.isRunning || manager.lanBypass === lanWanted()) return
    if (manager.reloadNeedsPrompt) {
      // TUN without the service: a restart would ask for admin rights out of the blue
      notify({
        text: 'LAN переключён — переподключите VPN, чтобы они не мешали друг другу',
        tone: 'info'
      })
      return
    }
    await manager.reload(buildStartParams()).catch(() => undefined)
  }
  // the daemon's chatter on network changes is folded (lan/logLines.ts)
  const lanFolder = new LanLogFolder()
  const pushLan = (entries: LogEntry[]): void => {
    for (const e of entries) logBatcher.push({ ...e, message: mask(e.message) })
  }
  setInterval(() => pushLan(lanFolder.tick()), 30_000).unref()
  const lan = createLanService({
    onBypassChange: syncLanBypass,
    adapterGate,
    binDir: manager.binDir,
    runDir: manager.runDir,
    service: manager.tunService,
    install: () => manager.installTunService(),
    apiContext: async () => ({
      apiBase: getSettings().apiBase,
      subscriptionUrl: getSubscriptionUrl(),
      deviceHeaders: await remnawave.deviceHeaders()
    }),
    hasSubscription: () => !!subscriptionToken(getSubscriptionUrl()),
    getEnabled: () => store.get('lanEnabled') === true,
    setEnabled: (on) => store.set('lanEnabled', on),
    getLoginServer: () => store.get('lanLoginServer') ?? null,
    getHostname: () => store.get('lanHostname') ?? null,
    setHostname: (name) => store.set('lanHostname', name),
    setLoginServer: (url) => {
      const prev = lanLoginHost()
      store.set('lanLoginServer', url)
      // a new Headscale host: the running VPN must let it through directly
      if (lanLoginHost() !== prev && manager.isRunning && !manager.reloadNeedsPrompt) {
        void manager.reload(buildStartParams()).catch(() => undefined)
      }
    },
    publish: (v: LanView) => send(IPC.evtLan, v),
    log: lanLog,
    daemonLog: (lines) => pushLan(lanFolder.push(lines, getSettings().verboseLog))
  })
  lanService = lan
  lan.init()

  ipcMain.handle(IPC.lanGet, async (): Promise<LanView> => lan.view())
  ipcMain.handle(IPC.lanSetEnabled, async (_e, on: unknown) =>
    lan.setEnabled(z.boolean().parse(on))
  )
  ipcMain.on(IPC.lanSetActive, (_e, active: unknown) => lan.setActive(z.boolean().parse(active)))
  ipcMain.handle(IPC.lanRefresh, async () => lan.refreshRooms())
  ipcMain.handle(IPC.lanCreateRoom, async (_e, name: unknown) =>
    lan.createRoom(lanRoomNameSchema.parse(name))
  )
  ipcMain.handle(IPC.lanJoinRoom, async (_e, code: unknown) =>
    lan.joinRoom(lanCodeSchema.parse(code))
  )
  ipcMain.handle(IPC.lanLeaveRoom, async (_e, id: unknown) => lan.leaveRoom(lanIdSchema.parse(id)))
  ipcMain.handle(IPC.lanKick, async (_e, id: unknown, memberId: unknown) =>
    lan.kick(lanIdSchema.parse(id), lanIdSchema.parse(memberId))
  )
  ipcMain.handle(IPC.lanRegenerateCode, async (_e, id: unknown) =>
    lan.regenerateCode(lanIdSchema.parse(id))
  )
  ipcMain.handle(IPC.lanDevices, async () => lan.loadDevices())
  ipcMain.handle(IPC.lanDeleteDevice, async (_e, nodeId: unknown) =>
    lan.deleteDevice(lanIdSchema.parse(nodeId))
  )

  // ---- «DevVersion» ---------------------------------------------------------
  /** the running core's direct hosts = what buildStartParams wants (the bot's host) */
  const syncDirectHosts = async (): Promise<void> => {
    if (!manager.isRunning) return
    const want = [...(buildStartParams().directHosts ?? [])].sort().join(' ')
    const have = [...manager.directHosts].sort().join(' ')
    if (want === have) return
    if (manager.proxyMode !== 'tun') return // Node's own requests skip the system proxy anyway
    if (manager.reloadNeedsPrompt) {
      notify({
        text: 'DevVersion: переподключите VPN, чтобы отчёты уходили напрямую, мимо VPN',
        tone: 'info'
      })
      return
    }
    await manager.reload(buildStartParams()).catch(() => undefined)
  }
  const dev = new DevVersionService({
    dir: join(app.getPath('userData'), 'devversion'),
    appVersion: app.getVersion(),
    getConsent: () => store.get('devVersion') ?? null,
    setConsent: (c) => store.set('devVersion', c),
    getLastUpload: () => store.get('devVersionLastUpload') ?? null,
    setLastUpload: (u) => store.set('devVersionLastUpload', u),
    api: new TelemetryApi(async () => ({
      apiBase: getSettings().apiBase,
      subscriptionUrl: getSubscriptionUrl(),
      deviceHeaders: await remnawave.deviceHeaders()
    })),
    apiHost: () => TelemetryApi.host(getSettings().apiBase),
    manager,
    outbounds: () => remnawave.getCached()?.outbounds ?? [],
    hidden: () =>
      new Set([
        ...nodeAddressSet(remnawave.getCached()?.outbounds ?? []),
        ...serverIps.map((ip) => ip.toLowerCase())
      ]),
    mask: () => mask,
    proxyMode: () => getSettings().proxyMode,
    coreExe: join(manager.binDir, CORE_EXE),
    xrayExe: join(manager.binDir, XRAY_EXE),
    log: (level, msg) => appLog(level, msg),
    onDirectHostsChange: syncDirectHosts
  })
  devService = dev
  dev.init()

  ipcMain.handle(IPC.devGet, async () => dev.status())
  ipcMain.handle(IPC.devStats, async () => dev.stats())
  ipcMain.handle(IPC.devEnable, async (_e, accept: unknown) => {
    const a = devAcceptSchema.parse(accept)
    return dev.enable(a.consentVersion)
  })
  ipcMain.handle(IPC.devDisable, async (_e, deleteRemote: unknown) => {
    const res = await dev.disable(z.boolean().parse(deleteRemote))
    return { status: { ...DEV_STATUS_OFF }, ...res }
  })
  ipcMain.handle(IPC.devDeleteRemote, async () => dev.deleteRemote())
  ipcMain.handle(IPC.devSendNow, async () => dev.sendNow())
  ipcMain.handle(IPC.devSaveReport, async (): Promise<string | null> => {
    const text = await dev.reportText()
    const win = getWindow()
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Сохранить отчёт DevVersion',
      defaultPath: `cipherway-devversion-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, text, 'utf8')
    return filePath
  })
  ipcMain.handle(IPC.devGameCandidates, async () => dev.gameCandidates())
  ipcMain.handle(IPC.devGameStart, async (_e, name: unknown) =>
    dev.gameStart(devProcessSchema.parse(name))
  )
  ipcMain.handle(IPC.devGameStop, async () => dev.gameStop())

  // ---- «Что нового» -------------------------------------------------------
  // decided once per start; a fresh install only records its version
  const current = app.getVersion()
  const hadEarlierVersion =
    store.get('subscriptionUrlEnc') !== null ||
    store.get('subscriptionCache') !== null ||
    store.get('trayHintShown') === true ||
    store.get('updateNotifiedVersion') !== null ||
    store.get('supportReadAt') !== null
  const news = whatsNew(store.get('whatsNewSeenVersion') ?? null, current, hadEarlierVersion)
  if (news.recordNow) store.set('whatsNewSeenVersion', current)
  let pendingNews: ChangelogEntry[] = news.entries
  ipcMain.handle(IPC.whatsNewGet, async (): Promise<ChangelogEntry[]> => pendingNews)
  ipcMain.on(IPC.whatsNewSeen, () => {
    pendingNews = []
    store.set('whatsNewSeenVersion', current)
  })

  // ---- updater -----------------------------------------------------------
  // dev / unpacked: no feed, unless CIPHERWAY_DEV_FAKE_UPDATE simulates one
  const fakeUpdate = app.isPackaged ? '' : (process.env.CIPHERWAY_DEV_FAKE_UPDATE ?? '')
  const updater = new AppUpdater({
    backend: fakeUpdate ? devFakeBackend(fakeUpdate, () => app.quit()) : electronUpdaterBackend(),
    enabled: app.isPackaged || !!fakeUpdate,
    log: appLog,
    onState: (s) => {
      send(IPC.evtUpdater, s)
      for (const cb of updaterListeners) cb(s)
    },
    onReady: (version) => {
      // one Windows notification per version, ever
      if (store.get('updateNotifiedVersion') === version) return
      store.set('updateNotifiedVersion', version)
      if (!Notification.isSupported()) return
      const n = new Notification({
        title: `Доступна версия ${version}`,
        body: 'Обновление CipherWay VPN загружено. Нажмите «Перезапустить и обновить» в меню слева — или оно установится при выходе из приложения.',
        ...(hooks?.notificationIcon ? { icon: hooks.notificationIcon } : {})
      })
      n.on('click', () => hooks?.showWindow())
      n.show()
    },
    beforeInstall: async () => {
      await disconnectVpn()
      if (!(await waitProcessesGone([CORE_EXE, XRAY_EXE], 10_000))) {
        appLog('warn', 'Ядро ещё работает — установщик может не заменить его файлы')
      }
    }
  })
  appUpdater = updater
  updater.start()
  powerMonitor.on('resume', () => updater.onResume())

  ipcMain.handle(IPC.updaterGetState, (): UpdaterState => updater.state)
  ipcMain.handle(IPC.updaterCheck, async (): Promise<UpdaterState> => updater.check())
  ipcMain.handle(IPC.updaterDownload, async (): Promise<UpdaterState> => updater.download())
  ipcMain.on(IPC.updaterInstall, () => void updater.install())
}

const updaterListeners = new Set<(s: UpdaterState) => void>()

/** Update state changes (used by the tray). */
export function onUpdaterState(cb: (s: UpdaterState) => void): () => void {
  updaterListeners.add(cb)
  return () => updaterListeners.delete(cb)
}
