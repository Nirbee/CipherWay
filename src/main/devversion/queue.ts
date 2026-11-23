import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// DevVersion: reports waiting to be sent, as gzip files in one folder
// (<userData>/devversion/queue/<time>-<n>.json.gz). Bounded: ≤ 20 MB in total,
// the oldest files are dropped first. Async fs only; written once per report
// (an hour by default), never on a collector tick.
// The retry delay after a failed send (Backoff) lives here too.
// Unit tested in queue.test.ts (a temp folder, a fake clock).
// ---------------------------------------------------------------------------

export const QUEUE_MAX_BYTES = 20 * 1024 * 1024

export interface QueueItem {
  name: string
  bytes: number
}

export class DiskQueue {
  private seq = 0

  constructor(
    readonly dir: string,
    private maxBytes = QUEUE_MAX_BYTES
  ) {}

  /** Oldest first. */
  async list(): Promise<QueueItem[]> {
    let names: string[]
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.json.gz')).sort()
    } catch {
      return []
    }
    const out: QueueItem[] = []
    for (const name of names) {
      try {
        out.push({ name, bytes: (await stat(join(this.dir, name))).size })
      } catch {
        /* removed meanwhile */
      }
    }
    return out
  }

  async push(gz: Buffer, now = Date.now()): Promise<string> {
    await mkdir(this.dir, { recursive: true })
    const name = `${String(now).padStart(15, '0')}-${String(++this.seq % 1000).padStart(3, '0')}.json.gz`
    await writeFile(join(this.dir, name), gz)
    await this.enforce()
    return name
  }

  async read(name: string): Promise<Buffer> {
    return readFile(join(this.dir, name))
  }

  async replace(name: string, gz: Buffer): Promise<void> {
    await writeFile(join(this.dir, name), gz)
  }

  async remove(name: string): Promise<void> {
    await rm(join(this.dir, name), { force: true })
  }

  /** Drops the oldest files until the folder is within the limit. */
  async enforce(): Promise<number> {
    const items = await this.list()
    let total = items.reduce((s, i) => s + i.bytes, 0)
    let dropped = 0
    for (const i of items) {
      if (total <= this.maxBytes) break
      await this.remove(i.name)
      total -= i.bytes
      dropped++
    }
    return dropped
  }

  async totals(): Promise<{ reports: number; bytes: number }> {
    const items = await this.list()
    return { reports: items.length, bytes: items.reduce((s, i) => s + i.bytes, 0) }
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }
}

/** Exponential retry delay with jitter: 1, 2, 4 … 60 min; reset after a success. */
export class Backoff {
  private failures = 0
  private until = 0

  constructor(
    private baseMs = 60_000,
    private maxMs = 60 * 60_000,
    private random: () => number = Math.random
  ) {}

  /** The next try is allowed at this time. */
  get readyAt(): number {
    return this.until
  }

  ready(now: number): boolean {
    return now >= this.until
  }

  /** A failure: wait longer (or exactly `ms`, e.g. Retry-After). Returns the wait. */
  fail(now: number, ms?: number): number {
    this.failures++
    const exp = Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - 1))
    const wait = ms ?? Math.round(exp * (0.8 + 0.4 * this.random()))
    this.until = now + wait
    return wait
  }

  succeed(): void {
    this.failures = 0
    this.until = 0
  }

  get attempts(): number {
    return this.failures
  }
}
