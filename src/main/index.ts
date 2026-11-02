import { join, resolve } from 'node:path'
import {
  app,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  Tray
} from 'electron'
import { IPC } from '@shared/ipc'
import type { ImportRequest, StatusUpdate } from '@shared/types'
import {
  activeManager,
  appUpdater,
  connectVpn,
  disconnectVpn,
  getVpnStatus,
  onVpnStatus,
  registerIpcHandlers
} from './ipc/handlers'
import { remnawave } from './remnawave/RemnawaveClient'
import { store } from './store'
import { findDeepLinkArg, parseDeepLink, PROTOCOL } from './deeplink'

const APP_ID = 'com.cipherway.vpn' // = appId in electron-builder.yml (toast notifications)

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** true once the user really wants to exit (tray «Выход», OS shutdown, update) */
let isQuitting = false
/** validated cipherway:// import waiting for the renderer to pick it up */
let pendingImport: ImportRequest | null = null

const resourcePath = (...p: string[]): string =>
  app.isPackaged ? join(process.resourcesPath, ...p) : join(process.cwd(), 'resources', ...p)
const appIconPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(process.cwd(), 'build', 'icon.ico')

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false, // custom titlebar — see renderer TitleBar component
    transparent: true, // rounded window corners via CSS on the app shell
    backgroundColor: '#00000000',
    title: 'CipherWay VPN',
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, // node APIs needed in preload bridge; isolation still on
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // notify renderer about maximize state so it can square off the corners
  const sendMaxState = (v: boolean): void => mainWindow?.webContents.send(IPC.evtWindowMaximized, v)
  mainWindow.on('maximize', () => sendMaxState(true))
  mainWindow.on('unmaximize', () => sendMaxState(false))

  // the close button hides to the tray; the VPN keeps running
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    mainWindow?.hide()
    showTrayHintOnce()
  })
  // Windows log-off / shutdown: let the window close and clean up the cores
  mainWindow.on('session-end', () => {
    isQuitting = true
    void activeManager?.stop()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // open external links in the system browser, never in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Window-control IPC (custom titlebar) — registered once, not per window. */
function registerWindowIpc(): void {
  ipcMain.on(IPC.windowMinimize, () => mainWindow?.minimize())
  ipcMain.on(IPC.windowMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(IPC.windowClose, () => mainWindow?.close())
  ipcMain.handle(IPC.windowIsMaximized, () => mainWindow?.isMaximized() ?? false)
  ipcMain.handle(IPC.deeplinkTakePending, (): ImportRequest | null => {
    const req = pendingImport
    pendingImport = null
    return req
  })
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

function trayIcon(connected: boolean): Electron.NativeImage {
  const img = nativeImage.createFromPath(
    resourcePath('tray', connected ? 'tray-on.ico' : 'tray-off.ico')
  )
  return img.isEmpty() ? nativeImage.createFromPath(appIconPath()) : img
}

const STATE_LABEL: Record<StatusUpdate['state'], string> = {
  connected: 'подключено',
  connecting: 'подключение…',
  disconnected: 'отключено',
  error: 'ошибка'
}

function updateTray(s: StatusUpdate): void {
  if (!tray) return
  const connected = s.state === 'connected'
  const busy = s.state === 'connecting'
  tray.setImage(trayIcon(connected))
  tray.setToolTip(`CipherWay VPN — ${STATE_LABEL[s.state]}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть', click: showWindow },
      { type: 'separator' },
      { label: `Состояние: ${STATE_LABEL[s.state]}`, enabled: false },
      {
        label: connected || busy ? 'Отключить' : 'Подключить',
        click: () => {
          if (connected || busy) {
            void disconnectVpn()
          } else {
            void connectVpn().then((r) => {
              if (r.state === 'error') showWindow() // let the user see why
            })
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => {
          isQuitting = true
          app.quit() // before-quit stops the cores and reverts the system proxy
        }
      }
    ])
  )
}

function createTray(): void {
  tray = new Tray(trayIcon(false))
  tray.on('double-click', showWindow)
  updateTray(getVpnStatus())
  onVpnStatus(updateTray)
}

function showTrayHintOnce(): void {
  if (store.get('trayHintShown')) return
  store.set('trayHintShown', true)
  if (!Notification.isSupported()) return
  new Notification({
    title: 'CipherWay VPN',
    body: 'CipherWay работает в трее. Открыть окно или выйти — через значок у часов.',
    icon: resourcePath('tray', 'tray-on.ico')
  }).show()
}

// ---------------------------------------------------------------------------
// cipherway:// deep links
// ---------------------------------------------------------------------------

function registerProtocol(): void {
  // In dev the scheme would point at the bare electron.exe; opt in explicitly.
  if (!app.isPackaged && !process.env.CIPHERWAY_DEV_PROTOCOL) return
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }
}

function handleDeepLink(raw: string | null, focus = true): void {
  if (!raw) return
  const req = parseDeepLink(raw)
  if (focus) showWindow()
  if (!req) {
    void dialog.showMessageBox({
      type: 'warning',
      title: 'CipherWay VPN',
      message: 'Ссылка не распознана',
      detail:
        'Поддерживаются только ссылки вида cipherway://import?url=https://… с адресом подписки по HTTPS.'
    })
    return
  }
  // never connect from a link: the renderer asks for confirmation first
  pendingImport = req
  mainWindow?.webContents.send(IPC.evtImportRequest)
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // a copy is already running: it receives our argv via 'second-instance'
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    showWindow()
    handleDeepLink(findDeepLinkArg(argv))
  })

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID)
    registerProtocol()
    registerIpcHandlers(() => mainWindow)
    registerWindowIpc()
    createWindow()
    createTray()

    // launched via a cipherway:// link
    handleDeepLink(findDeepLinkArg(process.argv), false)

    // resume periodic subscription refresh if one was configured previously
    remnawave.prefetchDevice()
    remnawave.startAutoRefresh(store.get('settings').subscriptionRefreshHours)

    // quiet update check in the background (no-op in dev / unpackaged)
    void appUpdater?.checkSilently()

    app.on('activate', showWindow)
  })

  let cleanupDone = false
  app.on('before-quit', (e) => {
    isQuitting = true
    if (cleanupDone || !activeManager) return
    // ensure cores are killed and the system proxy is reverted before exit
    e.preventDefault()
    cleanupDone = true
    void activeManager.stop().finally(() => app.quit())
  })

  // closing the window only hides it; the app lives in the tray until «Выход»
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  })
}
