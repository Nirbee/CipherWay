// ---------------------------------------------------------------------------
// DevVersion: when the heavy probes (5 delays per server, TLS / HTTP checks of
// the targets, the DNS comparison) may run. They load the line and the tunnel,
// so they wait while a game or a call is on (real-time UDP of a non-browser
// program, a known game exe) and for QUIET_MS after it; once running they stop
// at the next step when one starts. Even then: ≤ 2 probes at a time, with
// pauses between them (runLimited). Pure — unit tested in scheduler.test.ts.
// ---------------------------------------------------------------------------

export const HEAVY_INTERVAL_MS = 30 * 60_000
/** delays per server in one heavy run */
export const NODE_SAMPLES = 5
/** the light keepalive through the server in use (games included) */
export const TUNNEL_PROBE_MS = 60_000

/** What the server's flags may change (flat keys; anything else keeps the default). */
export interface Tuning {
  heavyIntervalMs: number
  nodeSamples: number
  heavyProbes: boolean
  tunnelProbeMs: number
}

const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null

/**
 * flags.probe_interval_s (300…86400), node_samples (1…20), heavy_probes (bool),
 * tunnel_probe_s (30…3600) over the defaults; an absent / bad value = default.
 */
export function tuningFrom(flags: Record<string, unknown>): Tuning {
  const interval = intIn(flags.probe_interval_s, 300, 86_400)
  const samples = intIn(flags.node_samples, 1, 20)
  const tunnel = intIn(flags.tunnel_probe_s, 30, 3600)
  return {
    heavyIntervalMs: interval !== null ? interval * 1000 : HEAVY_INTERVAL_MS,
    nodeSamples: samples ?? NODE_SAMPLES,
    heavyProbes: flags.heavy_probes !== false,
    tunnelProbeMs: tunnel !== null ? tunnel * 1000 : TUNNEL_PROBE_MS
  }
}
/** ± this share of the interval, so many PCs don't probe in step */
export const HEAVY_JITTER = 0.2
/** after the last game / call traffic, wait this long before probing */
export const QUIET_MS = 2 * 60_000

export type GateVerdict = 'run' | 'wait' | 'deferred'

export class HeavyGate {
  nextAt: number
  deferred = false
  lastBusyAt = Number.NEGATIVE_INFINITY

  constructor(
    now: number,
    private intervalMs = HEAVY_INTERVAL_MS,
    private random: () => number = Math.random,
    /** the first run comes sooner: a few minutes after the start */
    firstDelayMs = 3 * 60_000
  ) {
    this.nextAt = now + firstDelayMs
  }

  setInterval(ms: number): void {
    this.intervalMs = ms
  }

  /** `busy` = the game / call program right now (null = none). */
  check(now: number, busy: string | null): GateVerdict {
    if (busy) this.lastBusyAt = now
    if (now < this.nextAt) return 'wait'
    if (busy || now - this.lastBusyAt < QUIET_MS) {
      this.deferred = true
      return 'deferred'
    }
    this.deferred = false
    return 'run'
  }

  /** A run finished (or was cut short): the next one in interval ± jitter. */
  done(now: number): void {
    const j = 1 + HEAVY_JITTER * (2 * this.random() - 1)
    this.nextAt = now + Math.round(this.intervalMs * j)
  }

  /** A run was interrupted by a game: try again once it is over. */
  interrupted(now: number): void {
    this.lastBusyAt = now
    this.deferred = true
  }
}

export interface LimitOpts {
  concurrency?: number
  gapMs?: number
  /** checked before every task: true = stop here */
  shouldStop?: () => boolean
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

/**
 * Runs the tasks at most `concurrency` at a time (default 2), each worker
 * pausing `gapMs` between its tasks. Results in task order; a stopped run
 * leaves `undefined` for the tasks that never started. Never throws: a
 * failing task's result is undefined.
 */
export async function runLimited<T>(
  tasks: (() => Promise<T>)[],
  opts: LimitOpts = {}
): Promise<{ results: (T | undefined)[]; stopped: boolean }> {
  const concurrency = Math.max(1, opts.concurrency ?? 2)
  const gap = opts.gapMs ?? 300
  const sleep = opts.sleep ?? defaultSleep
  const results: (T | undefined)[] = new Array(tasks.length).fill(undefined)
  let next = 0
  let stopped = false
  const worker = async (): Promise<void> => {
    let first = true
    while (next < tasks.length) {
      if (opts.shouldStop?.()) {
        stopped = true
        return
      }
      const i = next++
      if (!first && gap > 0) await sleep(gap)
      first = false
      if (opts.shouldStop?.()) {
        stopped = true
        return
      }
      try {
        results[i] = await tasks[i]()
      } catch {
        results[i] = undefined
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
  return { results, stopped }
}
