import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdaterEvent } from '@shared/ipc'

const { autoUpdater } = electronUpdater

type EmitFn = (e: UpdaterEvent) => void

/**
 * Thin wrapper over electron-updater. Per the spec:
 *  - silent check on startup,
 *  - download only on explicit user action (autoDownload = false),
 *  - install only on user click (quitAndInstall).
 */
export class AppUpdater {
  private wired = false

  constructor(private emit: EmitFn) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = null
  }

  private wire(): void {
    if (this.wired) return
    this.wired = true
    autoUpdater.on('checking-for-update', () => this.emit({ type: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.emit({ type: 'available', version: info.version })
    )
    autoUpdater.on('update-not-available', () => this.emit({ type: 'not-available' }))
    autoUpdater.on('download-progress', (p) =>
      this.emit({ type: 'progress', percent: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.emit({ type: 'downloaded', version: info.version })
    )
    autoUpdater.on('error', (err) =>
      this.emit({ type: 'error', message: err == null ? 'unknown' : (err.message ?? String(err)) })
    )
  }

  /** Quiet background check (called on startup). No-op in dev/unpackaged. */
  async checkSilently(): Promise<void> {
    if (!app.isPackaged) return
    this.wire()
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      /* offline / no feed — stay silent on startup */
    }
  }

  /** User-triggered check (surfaces errors to the UI). */
  async check(): Promise<void> {
    if (!app.isPackaged) {
      this.emit({ type: 'not-available' })
      return
    }
    this.wire()
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async download(): Promise<void> {
    if (!app.isPackaged) return
    this.wire()
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  install(): void {
    if (!app.isPackaged) return
    // isSilent=false (show installer), forceRunAfter=true
    autoUpdater.quitAndInstall(false, true)
  }
}
