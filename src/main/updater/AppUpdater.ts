import {
  INITIAL_UPDATER_STATE,
  reduceUpdater,
  type UpdaterAction,
  type UpdaterState
} from '@shared/updater'
import { UpdateSchedule } from './schedule'

// ---------------------------------------------------------------------------
// App updates (GitHub Releases through electron-updater):
//  * checks by itself — 30 s after start, every 3 h, after waking from sleep;
//    background checks are silent (failures only go to the journal);
//  * a found update is downloaded in the background right away;
//  * installed on «Перезапустить и обновить» (cores stopped first, so the
//    installer can replace cipherway-core.exe / cipherway-xray.exe) or, quietly,
//    when the user quits the app (autoInstallOnAppQuit; not on Windows shutdown).
// The state lives here only; the UI and the tray draw from it.
// ---------------------------------------------------------------------------

/** What AppUpdater needs from electron-updater (see electronBackend.ts). */
export interface UpdaterBackend {
  /** the newer version, null — none */
  check(): Promise<string | null>
  download(): Promise<void>
  /** spawns the installer and quits the app; failures come through onError */
  quitAndInstall(): void
  setInstallOnQuit(on: boolean): void
  onProgress(cb: (percent: number) => void): void
  onDownloaded(cb: (version: string) => void): void
  onError(cb: (err: unknown) => void): void
}

export interface AppUpdaterOpts {
  backend: UpdaterBackend
  /** false in dev / unpacked builds: no feed there */
  enabled: boolean
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  onState: (s: UpdaterState) => void
  /** the update is on disk (once per run and version) */
  onReady?: (version: string) => void
  /** stops the cores; awaited before the installer starts */
  beforeInstall: () => Promise<void>
  /** download as soon as an update is found (default true) */
  autoDownload?: boolean
  now?: () => number
  /** tests: own timings */
  schedule?: { firstDelayMs?: number; intervalMs?: number }
}

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : err == null ? 'unknown' : String(err)

export class AppUpdater {
  private s: UpdaterState = INITIAL_UPDATER_STATE
  private checking: Promise<void> | null = null
  private checkManual = false
  private downloading: Promise<void> | null = null
  private downloadManual = false
  private installing = false
  private readyNotified: string | null = null
  private readonly now: () => number
  readonly schedule: UpdateSchedule

  constructor(private o: AppUpdaterOpts) {
    this.now = o.now ?? Date.now
    this.schedule = new UpdateSchedule({
      run: () => this.checkInBackground(),
      now: this.now,
      ...o.schedule
    })
    const b = o.backend
    b.setInstallOnQuit(true)
    b.onProgress((p) => this.dispatch({ type: 'progress', percent: p }))
    b.onDownloaded((v) => this.dispatch({ type: 'downloaded', version: v }))
    b.onError((err) => {
      // check / download failures are handled where they are awaited
      if (!this.installing) return
      this.installing = false
      this.o.log('error', `Обновление: установщик не запустился (${errText(err)})`)
      this.dispatch({ type: 'failed', manual: true, message: 'Не удалось запустить установку' })
    })
  }

  get state(): UpdaterState {
    return this.s
  }

  /** an update is on disk and will be installed */
  get readyToInstall(): boolean {
    return this.s.phase === 'downloaded' || this.s.phase === 'installing'
  }

  /** starts the background schedule (no-op when updates are off) */
  start(): void {
    if (this.o.enabled) this.schedule.start()
  }

  stop(): void {
    this.schedule.stop()
  }

  onResume(): void {
    this.schedule.onResume()
  }

  /** Windows is shutting down: don't start an installer that would be killed midway. */
  setInstallOnQuit(on: boolean): void {
    this.o.backend.setInstallOnQuit(on)
  }

  private dispatch(a: UpdaterAction): void {
    const next = reduceUpdater(this.s, a)
    if (next === this.s) return
    this.s = next
    this.o.onState(next)
    if (next.phase === 'downloaded' && next.version && this.readyNotified !== next.version) {
      this.readyNotified = next.version
      this.o.log('info', `Обновление ${next.version} загружено`)
      this.o.onReady?.(next.version)
    }
  }

  private get busy(): boolean {
    const p = this.s.phase
    return p === 'downloading' || p === 'downloaded' || p === 'installing'
  }

  /** The schedule's check: silent, skipped while an update is in hand. */
  checkInBackground(): Promise<void> {
    if (!this.o.enabled || this.busy) return Promise.resolve()
    return this.run(false)
  }

  /** «Проверить обновления»: result in the state; a failure becomes phase 'error'. */
  async check(): Promise<UpdaterState> {
    if (!this.o.enabled) {
      this.dispatch({ type: 'not-available', at: this.now() })
      return this.s
    }
    if (this.busy) return this.s
    this.schedule.noteCheck()
    await this.run(true)
    return this.s
  }

  private run(manual: boolean): Promise<void> {
    if (manual) this.checkManual = true
    this.dispatch({ type: 'check-start', manual })
    if (this.checking) return this.checking
    this.checking = (async () => {
      try {
        const version = await this.o.backend.check()
        if (version) {
          this.dispatch({ type: 'available', version, at: this.now() })
          this.o.log('info', `Доступно обновление ${version}`)
          if (this.o.autoDownload ?? true) void this.download(this.checkManual)
        } else {
          this.dispatch({ type: 'not-available', at: this.now() })
        }
      } catch (err) {
        const manualNow = this.checkManual
        this.o.log(
          manualNow ? 'error' : 'warn',
          `Не удалось проверить обновления${manualNow ? '' : ' (фоновая проверка)'}: ${errText(err)}`
        )
        this.dispatch({
          type: 'failed',
          manual: manualNow,
          message: 'Не удалось проверить обновления — нет связи с сервером'
        })
      } finally {
        this.checking = null
        this.checkManual = false
      }
    })()
    return this.checking
  }

  /** Downloads the found update (the button, or right after a check). */
  async download(manual = true): Promise<UpdaterState> {
    if (!this.o.enabled || this.s.phase === 'downloaded' || this.s.phase === 'installing') {
      return this.s
    }
    if (manual) this.downloadManual = true
    if (!this.downloading) {
      this.dispatch({ type: 'download-start' })
      this.downloading = (async () => {
        try {
          await this.o.backend.download()
          // normally 'update-downloaded' came first
          if (this.s.phase === 'downloading' && this.s.version) {
            this.dispatch({ type: 'downloaded', version: this.s.version })
          }
        } catch (err) {
          const manualNow = this.downloadManual
          this.o.log(manualNow ? 'error' : 'warn', `Не удалось скачать обновление: ${errText(err)}`)
          this.dispatch({
            type: 'failed',
            manual: manualNow,
            message: 'Не удалось скачать обновление — попробуйте ещё раз'
          })
        } finally {
          this.downloading = null
          this.downloadManual = false
        }
      })()
    }
    await this.downloading
    return this.s
  }

  /** «Перезапустить и обновить»: stop the cores, then hand over to the installer. */
  async install(): Promise<void> {
    if (!this.o.enabled || this.s.phase !== 'downloaded' || this.installing) return
    this.installing = true
    this.dispatch({ type: 'install-start' })
    this.schedule.stop()
    this.o.log('info', `Установка обновления ${this.s.version ?? ''}: остановка ядер`)
    try {
      await this.o.beforeInstall()
    } catch (err) {
      this.o.log('warn', `Ядра остановлены не полностью: ${errText(err)}`)
    }
    try {
      this.o.backend.quitAndInstall()
    } catch (err) {
      this.installing = false
      this.o.log('error', `Обновление: установщик не запустился (${errText(err)})`)
      this.dispatch({ type: 'failed', manual: true, message: 'Не удалось запустить установку' })
    }
  }
}
