import type { LogEntry } from './types'

// ---------------------------------------------------------------------------
// Log buffers. With «Подробный журнал» the cores print thousands of lines a
// minute: main batches them (one IPC message per ~300 ms, oldest lines dropped
// when a batch overflows) and the renderer keeps only the last UI_LOG_LIMIT.
// Pure — unit tested in logBuffer.test.ts.
// ---------------------------------------------------------------------------

/** lines kept by the «Логи» screen */
export const UI_LOG_LIMIT = 1000
/** lines in one main → renderer batch */
export const BATCH_LOG_LIMIT = 400

/** `entries` + `incoming`, keeping only the newest `max` (never mutates). */
export function appendCapped<T>(entries: readonly T[], incoming: readonly T[], max: number): T[] {
  if (max <= 0) return []
  if (incoming.length >= max) return incoming.slice(incoming.length - max)
  const keep = Math.max(0, entries.length + incoming.length - max)
  return [...entries.slice(keep), ...incoming]
}

/**
 * Collects log entries and hands them out in batches. If more than `limit`
 * lines arrive between two flushes, the oldest are dropped and a single
 * «пропущено N строк» line takes their place.
 */
export class LogBatcher {
  private queue: LogEntry[] = []
  private dropped = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private flushFn: (batch: LogEntry[]) => void,
    private intervalMs = 300,
    private limit = BATCH_LOG_LIMIT
  ) {}

  push(e: LogEntry): void {
    this.queue.push(e)
    if (this.queue.length > this.limit) {
      this.dropped += this.queue.length - this.limit
      this.queue.splice(0, this.queue.length - this.limit)
    }
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.queue.length === 0) return
    const batch = this.queue
    if (this.dropped > 0) {
      batch.unshift({
        ts: batch[0].ts,
        level: 'warn',
        source: 'app',
        message: `… пропущено строк журнала: ${this.dropped} (слишком много записей)`
      })
    }
    this.queue = []
    this.dropped = 0
    this.flushFn(batch)
  }
}
