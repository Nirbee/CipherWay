import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { geoUrl } from '../core/sbTypes'
import type { HeadlessRule } from './compile'

// ---------------------------------------------------------------------------
// GEOSITE / GEOIP sets for the rule slots. Headless rules can't reference
// another rule-set, so the SagerNet .srs files are downloaded by the app and
// decompiled once (`sing-box rule-set decompile`) into source rules that are
// merged into the slot files (compile.ts). Cached in <userData>/geo for a day;
// a failed refresh keeps the old copy, a set that never loaded is skipped
// with a warning instead of stopping the core (sing-box itself refuses to
// start on a 404 remote rule-set).
// ---------------------------------------------------------------------------

export interface GeoDeps {
  dir: string
  /** sing-box rule-set decompile <srs> -o <json> */
  decompile: (srs: string, json: string) => Promise<void>
  fetch?: typeof fetch
  now?: () => number
  warn?: (msg: string) => void
}

const MAX_AGE_MS = 24 * 3600_000
const DOWNLOAD_TIMEOUT_MS = 20_000
const MAX_SRS_BYTES = 20 * 1024 * 1024
const RETRY_AFTER_MS = 5 * 60_000

export class GeoCache {
  private mem = new Map<string, { at: number; rules: HeadlessRule[] }>()
  private inflight = new Map<string, Promise<HeadlessRule[] | null>>()
  /** tag → time of the last failed download (no retry for a few minutes) */
  private failedAt = new Map<string, number>()

  constructor(private deps: GeoDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Rules of every tag that could be loaded (fresh, cached or stale). */
  async load(tags: string[]): Promise<Map<string, HeadlessRule[]>> {
    const out = new Map<string, HeadlessRule[]>()
    await Promise.all(
      tags.map(async (tag) => {
        const rules = await this.one(tag)
        if (rules) out.set(tag, rules)
      })
    )
    return out
  }

  private one(tag: string): Promise<HeadlessRule[] | null> {
    const m = this.mem.get(tag)
    if (m && this.now - m.at < MAX_AGE_MS) return Promise.resolve(m.rules)
    const failed = this.failedAt.get(tag)
    if (!m && failed && this.now - failed < RETRY_AFTER_MS) return Promise.resolve(null)
    let p = this.inflight.get(tag)
    if (!p) {
      p = this.refresh(tag).finally(() => this.inflight.delete(tag))
      this.inflight.set(tag, p)
    }
    return p
  }

  private async readJson(file: string): Promise<HeadlessRule[] | null> {
    try {
      const json = JSON.parse(await readFile(file, 'utf8')) as { rules?: unknown }
      return Array.isArray(json.rules) ? (json.rules as HeadlessRule[]) : null
    } catch {
      return null
    }
  }

  private async refresh(tag: string): Promise<HeadlessRule[] | null> {
    if (!/^geo(site|ip)-[a-z0-9]/.test(tag) || /[\\/]|\.\./.test(tag)) return null
    await mkdir(this.deps.dir, { recursive: true })
    const json = join(this.deps.dir, `${tag}.json`)
    const cachedAt = await stat(json).then(
      (s) => s.mtimeMs,
      () => 0
    )
    if (cachedAt && this.now - cachedAt < MAX_AGE_MS) {
      const rules = await this.readJson(json)
      if (rules) {
        this.mem.set(tag, { at: cachedAt, rules })
        return rules
      }
    }
    try {
      const res = await (this.deps.fetch ?? fetch)(geoUrl(tag), {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > MAX_SRS_BYTES || buf.subarray(0, 3).toString('latin1') !== 'SRS') {
        throw new Error('не похоже на набор правил')
      }
      const srs = join(this.deps.dir, `${tag}.srs`)
      const tmp = `${json}.tmp`
      await writeFile(srs, buf)
      await this.deps.decompile(srs, tmp)
      const rules = await this.readJson(tmp)
      if (!rules) throw new Error('набор не прочитан')
      await rename(tmp, json)
      await rm(srs, { force: true })
      this.mem.set(tag, { at: this.now, rules })
      return rules
    } catch (err) {
      const stale = cachedAt ? await this.readJson(json) : null
      const why = err instanceof Error ? err.message : String(err)
      if (stale) {
        this.deps.warn?.(`Набор ${tag} не обновлён (${why}) — используется сохранённый`)
        this.mem.set(tag, { at: this.now, rules: stale })
        return stale
      }
      this.deps.warn?.(`Набор ${tag} не загружен (${why}) — правила с ним пропущены`)
      this.failedAt.set(tag, this.now)
      return null
    }
  }
}
