import { join } from 'node:path'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { activeManager, appUpdater, registerIpcHandlers } from './ipc/handlers'
import { remnawave } from './remnawave/RemnawaveClient'
import { store } from './store'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false, // custom titlebar — see renderer TitleBar component
    backgroundColor: '#0a0f1c',
    title: 'CipherWay VPN',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, // node APIs needed in preload bridge; isolation still on
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // open external links in the system browser, never in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // window control IPC (custom titlebar)
  ipcMain.on(IPC.windowMinimize, () => mainWindow?.minimize())
  ipcMain.on(IPC.windowMaximize, () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on(IPC.windowClose, () => mainWindow?.close())
  ipcMain.handle(IPC.windowIsMaximized, () => mainWindow?.isMaximized() ?? false)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers(() => mainWindow)
  createWindow()

  // resume periodic subscription refresh if one was configured previously
  remnawave.startAutoRefresh(store.get('settings').subscriptionRefreshHours)

  // quiet update check in the background (no-op in dev / unpackaged)
  void appUpdater?.checkSilently()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let cleanupDone = false
app.on('before-quit', (e) => {
  if (cleanupDone || !activeManager) return
  // ensure cores are killed and the system proxy is reverted before exit
  e.preventDefault()
  cleanupDone = true
  void activeManager.stop().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
