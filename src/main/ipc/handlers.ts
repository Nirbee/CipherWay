import { writeFile, readFile } from 'node:fs/promises'
import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type { AppSettings, RulesConfig, ServerPing, StatusUpdate } from '@shared/types'
import { DEFAULT_SETTINGS, store } from '../store'
import { listProcesses } from '../system/processes'
import { tcpPing } from '../system/ping'
import { remnawave } from '../remnawave/RemnawaveClient'
import { SidecarManager } from '../core/SidecarManager'
import { AppUpdater } from '../updater/AppUpdater'

/** Set once handlers are registered; used for graceful shutdown / startup. */
export let activeManager: SidecarManager | null = null
export let appUpdater: AppUpdater | null = null

type GetWindow = () => BrowserWindow | null

// --- zod validation schemas for inbound IPC payloads ----------------------

const ruleSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  conditionType: z.enum([
    'ProcessName',
    'ProcessPath',
    'Domain',
    'DomainSuffix',
    'DomainKeyword',
    'GeoSite',
    'GeoIP',
    'IPCIDR'
  ]),
  value: z.string(),
  action: z.string()
})

const rulesConfigSchema = z.object({
  defaultBehavior: z.enum(['proxy', 'direct', 'auto']),
  rules: z.array(ruleSchema)
})

const settingsPatchSchema = z
  .object({
    proxyMode: z.enum(['system', 'tun']),
    autoLaunch: z.boolean(),
    autoConnect: z.boolean(),
    language: z.enum(['ru', 'en']),
    socksPort: z.number().int().min(1).max(65535),
    httpPort: z.number().int().min(1).max(65535),
    subscriptionRefreshHours: z.number().int().min(1).max(168)
  })
  .partial()

// runtime connection status, owned by the SidecarManager callbacks
let status: StatusUpdate = { state: 'disconnected' }

function buildStartParams() {
  const sub = remnawave.getCached()
  return {
    outbounds: sub?.outbounds ?? [],
    activeOutboundId: store.get('activeOutboundId') ?? undefined,
    rules: store.get('rules'),
    settings: store.get('settings')
  }
}

export function registerIpcHandlers(getWindow: GetWindow): void {
  const send = (channel: string, payload: unknown): void =>
    getWindow()?.webContents.send(channel, payload)

  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())

  const manager = new SidecarManager(
    (entry) => send(IPC.evtLog, entry),
    (state, message) => {
      status = { state, activeOutboundId: store.get('activeOutboundId') ?? undefined, message }
      send(IPC.evtStatus, status)
    },
    (traffic) => send(IPC.evtTraffic, traffic)
  )

  // expose so app shutdown can stop cores gracefully
  activeManager = manager

  // ---- connection --------------------------------------------------------
  ipcMain.handle(IPC.connect, async (_e, outboundId?: string): Promise<StatusUpdate> => {
    if (outboundId) store.set('activeOutboundId', z.string().parse(outboundId))
    try {
      await manager.start(buildStartParams())
    } catch (err) {
      status = { state: 'error', message: err instanceof Error ? err.message : String(err) }
      send(IPC.evtStatus, status)
    }
    return status
  })

  ipcMain.handle(IPC.disconnect, async (): Promise<StatusUpdate> => {
    await manager.stop()
    return status
  })

  ipcMain.handle(IPC.getStatus, async () => status)

  // ---- subscription ------------------------------------------------------
  ipcMain.handle(IPC.subscriptionFetch, async (_e, url: unknown) => {
    const parsed = z.string().url().parse(url)
    const data = await remnawave.fetchSubscription(parsed)
    remnawave.startAutoRefresh(store.get('settings').subscriptionRefreshHours)
    return data
  })

  ipcMain.handle(IPC.subscriptionRefresh, async () => remnawave.refreshSubscription())

  ipcMain.handle(IPC.subscriptionGet, async () => remnawave.getCached())

  // ---- servers -----------------------------------------------------------
  ipcMain.handle(IPC.serversPing, async (): Promise<ServerPing[]> => {
    const outbounds = remnawave.getCached()?.outbounds ?? []
    return Promise.all(
      outbounds.map(async (o) => ({ outboundId: o.id, latencyMs: await tcpPing(o.server, o.port) }))
    )
  })

  ipcMain.handle(IPC.serverSelect, async (_e, outboundId: string) => {
    store.set('activeOutboundId', z.string().parse(outboundId))
    if (status.state === 'connected') await manager.reload(buildStartParams())
  })

  // ---- rules -------------------------------------------------------------
  ipcMain.handle(IPC.rulesGet, async (): Promise<RulesConfig> => store.get('rules'))

  ipcMain.handle(IPC.rulesSet, async (_e, config: unknown) => {
    const parsed = rulesConfigSchema.parse(config)
    store.set('rules', parsed)
    // hot-reload the running cores so routing changes apply immediately
    if (status.state === 'connected') await manager.reload(buildStartParams())
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
    return parsed
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
  ipcMain.handle(IPC.settingsGet, async (): Promise<AppSettings> => store.get('settings'))

  ipcMain.handle(IPC.settingsSet, async (_e, patch: unknown): Promise<AppSettings> => {
    const parsed = settingsPatchSchema.parse(patch)
    const next = { ...DEFAULT_SETTINGS, ...store.get('settings'), ...parsed }
    store.set('settings', next)
    if ('autoLaunch' in parsed) {
      app.setLoginItemSettings({ openAtLogin: next.autoLaunch })
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
