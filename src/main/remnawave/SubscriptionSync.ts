import {
  AUTO_OUTBOUND_ID,
  type LogEntry,
  type OutboundConfig,
  type SubscriptionData
} from '@shared/types'
import {
  describeDiff,
  describeFieldChanges,
  diffOutbounds,
  fieldChanges,
  runningChanges,
  reconcileActive,
  refreshIntervalMs,
  remapLatencies,
  type OutboundsDiff
} from './subscriptionDiff'

// ---------------------------------------------------------------------------
// When the subscription is fetched and what happens with the answer. The panel
// can change a node's key or address at any moment, and a client that keeps an
// old copy just shows «нет ответа»:
//  - by hand (the «Обновить» buttons);
//  - before every connect (short timeout, on failure — the saved copy);
//  - on the panel's `profile-update-interval` (else the setting) and at start;
//  - after a REALITY error (see core/realityWatch.ts).
// A change while connected is applied through the manager's queue; the selected
// server follows its name. The request is ordinary app traffic: while the VPN is
// on it goes through the tunnel like everything else, so it can fail if the
// tunnel itself is broken — then the saved copy stays and it is tried again.
// Everything external is injected — unit tested in SubscriptionSync.test.ts.
// ---------------------------------------------------------------------------

/** «перед каждым подключением»: the user is waiting */
export const CONNECT_REFRESH_TIMEOUT_MS = 5000
/** reaction to a REALITY error: the connection is broken anyway */
export const HEAL_REFRESH_TIMEOUT_MS = 15_000
/** after a failed background attempt */
export const RETRY_MS = 15 * 60_000
export const TICK_MS = 60_000

export interface SyncDeps {
  url: () => string | null
  fetch: (url: string, timeoutMs?: number) => Promise<SubscriptionData>
  cached: () => SubscriptionData | null
  getActive: () => string | null
  setActive: (id: string) => void
  getLatencies: () => Record<string, number | null>
  setLatencies: (v: Record<string, number | null>) => void
  /** subscriptionRefreshHours */
  settingHours: () => number
  /** the core must pick the new list up (through its queue; no-op while disconnected) */
  applyToCore: () => void | Promise<void>
  /**
   * the servers the running core was started with (null = disconnected) — a
   * soft change is stored at once but reaches the core only with its next start
   */
  running?: () => OutboundConfig[] | null
  /** the selected server changed */
  activeChanged: (id: string) => void
  log: (level: LogEntry['level'], message: string) => void
  notify: (text: string, tone: 'info' | 'success' | 'error') => void
  now?: () => number
}

export interface RefreshOutcome {
  data: SubscriptionData
  /** the server list or a server's connection parameters changed */
  changed: boolean
  diff: OutboundsDiff
}

export class SubscriptionSync {
  private inflight: Promise<RefreshOutcome> | null = null
  private forceApply = false
  /** heal(): ids of the servers REALITY failed on ([] = unknown → all) */
  private healIds: string[] = []
  private lastAttempt = Number.NEGATIVE_INFINITY
  private timer: NodeJS.Timeout | null = null

  constructor(private d: SyncDeps) {}

  private get now(): number {
    return this.d.now?.() ?? Date.now()
  }

  /** The cached choice is no longer in the (filtered) list → «Лучший сервер». */
  migrateActive(): void {
    const list = this.d.cached()?.outbounds
    if (!list) return
    this.applyChoice(list, list)
  }

  private applyChoice(
    prev: SubscriptionData['outbounds'],
    next: SubscriptionData['outbounds']
  ): void {
    const res = reconcileActive(this.d.getActive(), prev, next)
    if (!res.changed) return
    this.d.setActive(res.id)
    this.d.activeChanged(res.id)
    if (res.lost) {
      this.d.log('warn', `Сервера «${res.lost}» больше нет в подписке — выбран «Лучший сервер»`)
      this.d.notify(`Сервера «${res.lost}» больше нет — выбран «Лучший сервер»`, 'info')
    } else if (res.id === 'auto') {
      this.d.log('info', 'Выбранного сервера нет в списке — выбран «Лучший сервер»')
    }
  }

  /** A new link pasted by the user: same handling of the answer. */
  fetchUrl(url: string): Promise<RefreshOutcome> {
    return this.run(url, undefined)
  }

  /** Fetch now; requests made while one is running share its answer. */
  refresh(opts: { timeoutMs?: number; force?: boolean } = {}): Promise<RefreshOutcome> {
    if (opts.force) this.forceApply = true
    if (this.inflight) return this.inflight
    const url = this.d.url()
    if (!url) return Promise.reject(new Error('Подписка не настроена'))
    return this.run(url, opts.timeoutMs)
  }

  private run(url: string, timeoutMs: number | undefined): Promise<RefreshOutcome> {
    const job = this.fetchAndApply(url, timeoutMs).finally(() => {
      if (this.inflight === job) this.inflight = null
    })
    this.inflight = job
    return job
  }

  private async fetchAndApply(
    url: string,
    timeoutMs: number | undefined
  ): Promise<RefreshOutcome> {
    const prev = this.d.cached()?.outbounds ?? []
    this.lastAttempt = this.now
    const data = await this.d.fetch(url, timeoutMs)
    const next = data.outbounds
    const diff = diffOutbounds(prev, next)
    const force = this.forceApply
    const healIds = this.healIds
    this.forceApply = false
    this.healIds = []
    // after a REALITY error: what the core RUNS, not the stored copy — a soft
    // change (fingerprint, shortId) stored by an earlier refresh never reached it
    // (0.5.2: «Финляндия» stayed on fingerprint qq until a manual reconnect)
    const running = force ? (this.d.running?.() ?? null) : null
    const stale = running ? runningChanges(running, next, healIds) : []

    this.d.setLatencies(remapLatencies(this.d.getLatencies(), prev, next))
    this.applyChoice(prev, next)
    if (!force) this.noteSelectedSoft(prev, next, diff.softOnly)

    const restart =
      prev.length > 0 &&
      (diff.restartNeeded || stale.length > 0 || (force && !running && diff.softOnly.length > 0))
    if (restart) {
      const what = describeDiff(diff) || `обновились параметры: ${diff.softOnly.join(', ')}`
      if (stale.length) {
        for (const c of stale) this.d.log('info', describeFieldChanges(c.name, c.changes))
        this.d.log(
          'info',
          `Ядро работает со старыми параметрами (${stale.map((c) => c.name).join(', ')}) — перезапускаем`
        )
      }
      if (diff.restartNeeded || !stale.length) this.d.log('info', `Подписка изменилась (${what})`)
      void Promise.resolve(this.d.applyToCore()).catch(() => undefined)
    }
    return { data, changed: diff.restartNeeded || stale.length > 0, diff }
  }

  /**
   * Soft fields of the SELECTED server changed: stored, applied at the next
   * start — not now (the panel varies shortId / fingerprint from one request to
   * the next; a restart each time would cut every connection). Logged, so it is
   * clear why the core still uses the old ones.
   */
  private noteSelectedSoft(
    prev: OutboundConfig[],
    next: OutboundConfig[],
    softOnly: string[]
  ): void {
    const id = this.d.getActive()
    if (!id || id === AUTO_OUTBOUND_ID || !softOnly.length) return
    const b = next.find((o) => o.id === id)
    const a = b && prev.find((o) => o.name === b.name)
    if (!a || !b || !softOnly.includes(b.name)) return
    this.d.log(
      'info',
      `${describeFieldChanges(b.name, fieldChanges(a, b))} — применится при следующем подключении`
    )
  }

  /** Before a connect: never holds it up longer than the short timeout. */
  async beforeConnect(): Promise<void> {
    if (!this.d.url()) return
    const job = this.refresh({ timeoutMs: CONNECT_REFRESH_TIMEOUT_MS })
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<'late'>((res) => {
      timer = setTimeout(() => res('late'), CONNECT_REFRESH_TIMEOUT_MS + 200)
    })
    try {
      const res = await Promise.race([job, late])
      if (res === 'late') {
        job.catch(() => undefined) // its answer is still applied when it comes
        this.d.log('warn', 'Подписка не обновилась за 5 с — подключаемся по сохранённой копии')
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      this.d.log('warn', `Подписка не обновилась (${why}) — подключаемся по сохранённой копии`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Reaction to a REALITY error: the fresh subscription is compared with what
   * the core runs; any difference of the failing server(s) — soft fields
   * included — means a restart (the manager's REALITY cooldown limits how often).
   * @param nodeIds servers the error was seen on ([] = not known: all of them)
   */
  async heal(nodeIds: string[] = []): Promise<void> {
    if (!this.d.url()) return
    this.d.log('info', 'Сервер ответил чужим сертификатом — проверяем подписку')
    try {
      // a refresh already in flight was not asked to compare: wait, then ask
      if (this.inflight) await this.inflight.catch(() => undefined)
      this.healIds = [...nodeIds]
      const res = await this.refresh({ timeoutMs: HEAL_REFRESH_TIMEOUT_MS, force: true })
      if (!res.changed && (this.d.running?.() || res.diff.softOnly.length === 0)) {
        this.d.log('info', 'В подписке нет новых ключей для этого сервера')
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      this.d.log('warn', `Подписка не обновилась: ${why}`)
    }
  }

  /** At start + a check once a minute (timers survive sleep this way). */
  start(): void {
    this.stop()
    if (this.d.url()) void this.background()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** due? — public for tests */
  isDue(): boolean {
    if (!this.d.url() || this.inflight) return false
    const now = this.now
    if (now - this.lastAttempt < RETRY_MS) return false
    const cached = this.d.cached()
    if (!cached) return true
    const every = refreshIntervalMs(cached.updateIntervalHours, this.d.settingHours())
    return now - cached.fetchedAt >= every
  }

  tick(): void {
    if (this.isDue()) void this.background()
  }

  private async background(): Promise<void> {
    try {
      await this.refresh()
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      this.d.log('warn', `Подписка не обновилась: ${why}`)
    }
  }
}
