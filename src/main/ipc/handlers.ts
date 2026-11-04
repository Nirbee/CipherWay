import { writeFile, readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type {
  AppSettings,
  ConnSnapshot,
  RoutingMode,
  RulesConfig,
  ServerPing,
  StatusUpdate,
  SubscriptionData,
  SubscriptionView
} from '@shared/types'
import { DEFAULT_SETTINGS, getSettings, store } from '../store'
import { listProcesses } from '../system/processes'
import { remnawave } from '../remnawave/RemnawaveClient'
import { toSubscriptionView } from '../remnawave/view'
import { getSubscriptionUrl } from '../secrets'
import { createMasker, type Masker } from '../mask'
import { SidecarManager } from '../core/SidecarManager'
import { toConnItems } from '../core/connections'
import { AppUpdater } from '../updater/AppUpdater'

/** Set once handlers are registered; used for graceful shutdown / startup. */
export let activeManager: SidecarManager | null = null
export let appUpdater: AppUpdater | null = null

type GetWindow = () => BrowserWindow | null

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
    subscriptionRefreshHours: z.number().int().min(1).max(168)
  })
  .partial()

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
    settings: getSettings()
  }
}

let connectImpl: ((outboundId?: string) => Promise<StatusUpdate>) | null = null
let disconnectImpl: (() => Promise<StatusUpdate>) | null = null
let routingModeImpl: ((mode: RoutingMode) => Promise<AppSettings>) | null = null

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

export function registerIpcHandlers(getWindow: GetWindow): void {
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  status = { state: 'disconnected', activeOutboundId: store.get('activeOutboundId') ?? undefined }
  const publish = (next: StatusUpdate): void => {
    status = next
    send(IPC.evtStatus, status)
    for (const cb of statusListeners) cb(status)
  }
  const publishSettings = (s: AppSettings): void => {
    send(IPC.evtSettings, s)
    for (const cb of settingsListeners) cb(s)
  }

  // node addresses / credentials / the subscription link never reach the UI log
  let mask: Masker = (t) => t
  const rebuildMask = (data: SubscriptionData | null): void => {
    mask = createMasker({
      outbounds: data?.outbounds ?? [],
      subscriptionUrl: getSubscriptionUrl()
    })
  }
  rebuildMask(remnawave.getCached())
  const view = (data: SubscriptionData | null): SubscriptionView | null =>
    toSubscriptionView(data, getSubscriptionUrl())
  remnawave.onUpdate((d) => {
    rebuildMask(d)
    send(IPC.evtSubscription, view(remnawave.getCached()))
  })

  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())
  ipcMain.handle(IPC.openExternal, async (_e, url: unknown) => {
    await shell.openExternal(externalUrlSchema.parse(url))
  })

  let autoSelectedId: string | undefined
  const manager = new SidecarManager(
    (entry) => send(IPC.evtLog, { ...entry, message: mask(entry.message) }),
    (state, message) => {
      publish({
        state,
        activeOutboundId: store.get('activeOutboundId') ?? undefined,
        autoSelectedId: state === 'connected' ? autoSelectedId : undefined,
        message: message ? mask(message) : undefined
      })
    },
    (traffic) => send(IPC.evtTraffic, traffic),
    (nodeId) => {
      autoSelectedId = nodeId
      if (status.state === 'connected') publish({ ...status, autoSelectedId: nodeId })
    }
  )

  // expose so app shutdown can stop cores gracefully
  activeManager = manager

  // ---- connection --------------------------------------------------------
  connectImpl = async (outboundId?: string): Promise<StatusUpdate> => {
    if (outboundId) store.set('activeOutboundId', z.string().max(100).parse(outboundId))
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
    await manager.stop()
    return status
  }
  routingModeImpl = async (mode: RoutingMode): Promise<AppSettings> => {
    const next = { ...getSettings(), routingMode: mode }
    store.set('settings', next)
    publishSettings(next)
    if (manager.isRunning) {
      const ok = await manager.setRoutingMode(mode)
      // the Clash API refused (shouldn't happen) — fall back to a restart
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
    const data = await remnawave.fetchSubscription(parsed)
    remnawave.startAutoRefresh(getSettings().subscriptionRefreshHours)
    return view(data)
  })

  ipcMain.handle(IPC.subscriptionRefresh, async () => view(await remnawave.refreshSubscription()))

  ipcMain.handle(IPC.subscriptionGet, async () => view(remnawave.getCached()))

  // ---- servers -----------------------------------------------------------
  ipcMain.handle(IPC.serversPing, async (): Promise<ServerPing[]> => {
    const outbounds = remnawave.getCached()?.outbounds ?? []
    return manager.testLatency(outbounds)
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
    snapshot.items = toConnItems(raw, {
      outbounds: remnawave.getCached()?.outbounds ?? [],
      prev: prevConn,
      now
    })
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
  ipcMain.handle(IPC.rulesGet, async (): Promise<RulesConfig> => store.get('rules'))

  ipcMain.handle(IPC.rulesSet, async (_e, config: unknown) => {
    const parsed = rulesConfigSchema.parse(config)
    store.set('rules', parsed)
    // hot-reload the running cores so routing changes apply immediately
    if (manager.isRunning) await manager.reload(buildStartParams()).catch(() => undefined)
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
    if (manager.isRunning) await manager.reload(buildStartParams()).catch(() => undefined)
    return parsed
  })

  ipcMain.handle(IPC.rulesOpenText, async (): Promise<string | null> => {
    const win = getWindow()
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Открыть файл правил',
      properties: ['openFile'],
      filters: [
        { name: 'Правила (YAML, JSON, текст)', extensions: ['yaml', 'yml', 'json', 'txt', 'list', 'conf'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) return null
    const st = await stat(filePaths[0])
    if (st.size > 4 * 1024 * 1024) throw new Error('Файл слишком большой (больше 4 МБ)')
    return readFile(filePaths[0], 'utf8')
  })

  ipcMain.handle(IPC.rulesSaveText, async (_e, text: unknown): Promise<string | null> => {
    const body = z.string().max(4 * 1024 * 1024).parse(text)
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
    return next
  })

  // ---- updater -----------------------------------------------------------
  const updater = new AppUpdater((e) => send(IPC.evtUpdater, e))
  appUpdater = updater

  ipcMain.handle(IPC.updaterCheck, async () => updater.check())
  ipcMain.handle(IPC.updaterDownload, async () => updater.download())
  ipcMain.on(IPC.updaterInstall, () => updater.install())
}
