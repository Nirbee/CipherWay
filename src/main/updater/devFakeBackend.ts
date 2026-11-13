import type { UpdaterBackend } from './AppUpdater'

/**
 * Dev / unpacked builds only (CIPHERWAY_DEV_FAKE_UPDATE=0.4.99): pretends the
 * feed has that version, «downloads» it in ~6 s and, on install, just quits
 * (after the cores were stopped like for a real update). Lets the update
 * button, the notification and the tray item be tried without a release.
 * `CIPHERWAY_DEV_FAKE_UPDATE=fail` makes every check fail;
 * `…=0.4.99:flaky` — the first (background) download fails, so the button
 * stays at «Доступно обновление» until pressed.
 */
export function devFakeBackend(spec: string, quit: () => void): UpdaterBackend {
  const [version, mode] = spec.split(':')
  let failDownload = mode === 'flaky'
  let progress: (p: number) => void = () => undefined
  let downloaded: (v: string) => void = () => undefined
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  return {
    async check() {
      await sleep(800)
      if (version === 'fail') throw new Error('dev: net::ERR_INTERNET_DISCONNECTED')
      return version
    },
    async download() {
      if (failDownload) {
        failDownload = false
        await sleep(1500)
        throw new Error('dev: download interrupted')
      }
      for (let p = 0; p <= 100; p += 7) {
        progress(p)
        await sleep(400)
      }
      downloaded(version)
    },
    quitAndInstall: () => quit(),
    setInstallOnQuit: () => undefined,
    onProgress: (cb) => {
      progress = cb
    },
    onDownloaded: (cb) => {
      downloaded = cb
    },
    onError: () => undefined
  }
}
