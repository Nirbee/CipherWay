import electronUpdater from 'electron-updater'
import type { UpdaterBackend } from './AppUpdater'

const { autoUpdater } = electronUpdater

/** The real feed: GitHub Releases of Nirbee/CipherWay (electron-builder.yml → publish). */
export function electronUpdaterBackend(): UpdaterBackend {
  // the download is started by AppUpdater itself (it knows manual vs background)
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  return {
    async check() {
      const r = await autoUpdater.checkForUpdates()
      return r?.isUpdateAvailable ? r.updateInfo.version : null
    },
    async download() {
      await autoUpdater.downloadUpdate()
    },
    // isSilent=false: the installer window shows its progress (pages are skipped
    // on update); isForceRunAfter=true: the new version starts afterwards
    quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
    setInstallOnQuit: (on) => {
      autoUpdater.autoInstallOnAppQuit = on
    },
    onProgress: (cb) => {
      autoUpdater.on('download-progress', (p) => cb(p.percent))
    },
    onDownloaded: (cb) => {
      autoUpdater.on('update-downloaded', (info) => cb(info.version))
    },
    // an 'error' without a listener would throw inside electron-updater
    onError: (cb) => {
      autoUpdater.on('error', (err) => cb(err))
    }
  }
}
