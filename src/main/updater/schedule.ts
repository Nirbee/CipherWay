// ---------------------------------------------------------------------------
// When the app looks for updates by itself: once ~30 s after start (the
// subscription and the cores go first), then every 3 hours, and shortly after
// the computer wakes up if the last check is old. Timers only — what a check
// does is the caller's business (AppUpdater.checkInBackground).
// ---------------------------------------------------------------------------

export const UPDATE_FIRST_DELAY_MS = 30_000
export const UPDATE_INTERVAL_MS = 3 * 60 * 60_000
/** after sleep: give Wi-Fi / the VPN a moment to come back */
export const UPDATE_RESUME_DELAY_MS = 20_000
/** after sleep: no new check if the last one is fresher than this */
export const UPDATE_RESUME_MIN_GAP_MS = 30 * 60_000

export interface UpdateScheduleOpts {
  run: () => Promise<void>
  firstDelayMs?: number
  intervalMs?: number
  resumeDelayMs?: number
  resumeMinGapMs?: number
  /** tests */
  now?: () => number
}

export class UpdateSchedule {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private started = false
  private lastRunAt: number | null = null

  private readonly firstDelayMs: number
  private readonly intervalMs: number
  private readonly resumeDelayMs: number
  private readonly resumeMinGapMs: number
  private readonly now: () => number

  constructor(private o: UpdateScheduleOpts) {
    this.firstDelayMs = o.firstDelayMs ?? UPDATE_FIRST_DELAY_MS
    this.intervalMs = o.intervalMs ?? UPDATE_INTERVAL_MS
    this.resumeDelayMs = o.resumeDelayMs ?? UPDATE_RESUME_DELAY_MS
    this.resumeMinGapMs = o.resumeMinGapMs ?? UPDATE_RESUME_MIN_GAP_MS
    this.now = o.now ?? Date.now
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.arm(this.firstDelayMs)
  }

  stop(): void {
    this.started = false
    this.clear()
  }

  /** the computer woke up */
  onResume(): void {
    if (!this.started) return
    const last = this.lastRunAt
    if (last !== null && this.now() - last < this.resumeMinGapMs) return
    this.arm(this.resumeDelayMs)
  }

  /** a check happened outside the schedule (the user pressed the button) */
  noteCheck(): void {
    this.lastRunAt = this.now()
    if (this.started && !this.running) this.arm(this.intervalMs)
  }

  /** a check is planned (tests / diagnostics) */
  get armed(): boolean {
    return this.timer !== null
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private arm(ms: number): void {
    this.clear()
    const t = setTimeout(() => void this.fire(), ms)
    // never keeps the process alive on its own
    ;(t as { unref?: () => void }).unref?.()
    this.timer = t
  }

  private async fire(): Promise<void> {
    this.timer = null
    if (!this.started || this.running) return
    this.running = true
    try {
      await this.o.run()
    } catch {
      /* the caller logs; the schedule goes on */
    } finally {
      this.running = false
      this.lastRunAt = this.now()
      if (this.started) this.arm(this.intervalMs)
    }
  }
}
