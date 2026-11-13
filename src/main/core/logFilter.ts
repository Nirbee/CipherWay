import type { LogEntry } from '@shared/types'

// ---------------------------------------------------------------------------
// What the cores print is not always worth a line in «Журнал»:
//  * ordinary broken connections (the user closed a tab, a site reset the
//    stream) — hidden unless «Подробный журнал» is on;
//  * endless repeats (REALITY with a stale key, «connection refused» to our own
//    loopback ports while a core restarts, a dead node / a blocked direct
//    route: thousands of «i/o timeout» / «no recent network activity» a minute)
//    — the first line stays, the rest become one «… ещё строк: N за 30 с» per
//    window, per kind of error and outbound.
// Application lines are never touched. Pure — unit tested in logFilter.test.ts.
// ---------------------------------------------------------------------------

const ORDINARY_CLOSE: RegExp[] = [
  /connection: connection (upload|download) closed/i,
  /aborted by the software/i,
  /forcibly closed/i,
  // Windows may print these in Russian if the English message is unavailable
  /разорвала установленное подключение/i,
  /принудительно разорвал/i
]

interface CollapseRule {
  key: string
  re: RegExp
  label: string
}

const COLLAPSE: CollapseRule[] = [
  {
    key: 'reality',
    re: /REALITY: received real certificate/,
    label: 'REALITY: сервер ответил чужим сертификатом'
  },
  {
    key: 'refused',
    re: /(dial tcp |connect to )127\.0\.0\.1:\d+.*(connectex|refused)/i,
    label: 'локальное ядро не принимает соединения'
  }
]

/** connection errors that repeat endlessly when a node or the direct route is dead */
const CONN_KINDS: { re: RegExp; label: string }[] = [
  { re: /i\/o timeout|timed out|did not properly respond/i, label: 'нет ответа (timeout)' },
  { re: /no recent network activity/i, label: 'нет активности (no recent network activity)' }
]
const OUTBOUND_RE = /\b(outbound\/[\w-]+\[[^\]]*\])/

/** Collapse group of a line: a fixed one, or kind + outbound of a connection error. */
export function collapseKey(message: string): { key: string; label: string } | null {
  const rule = COLLAPSE.find((c) => c.re.test(message))
  if (rule) return { key: rule.key, label: rule.label }
  if (!/connection: |outbound\//.test(message)) return null
  const kind = CONN_KINDS.find((k) => k.re.test(message))
  if (!kind) return null
  const out = OUTBOUND_RE.exec(message)?.[1]
  return { key: `${kind.label}|${out ?? ''}`, label: out ? `${kind.label}, ${out}` : kind.label }
}

export const COLLAPSE_WINDOW_MS = 30_000

interface Group {
  label: string
  first: number
  count: number
  level: LogEntry['level']
  source: LogEntry['source']
}

export const isOrdinaryClose = (line: string): boolean => ORDINARY_CLOSE.some((r) => r.test(line))

export class LogFilter {
  private groups = new Map<string, Group>()

  constructor(
    private emit: (e: LogEntry) => void,
    private windowMs = COLLAPSE_WINDOW_MS
  ) {}

  push(e: LogEntry, verbose: boolean): void {
    if (e.source === 'app') return this.emit(e)
    if (!verbose && isOrdinaryClose(e.message)) return
    const c = collapseKey(e.message)
    if (!c) return this.emit(e)
    const g = this.groups.get(c.key)
    if (!g) {
      this.groups.set(c.key, {
        label: c.label,
        first: e.ts,
        count: 0,
        level: e.level,
        source: e.source
      })
      return this.emit(e)
    }
    g.count++
    if (e.ts - g.first >= this.windowMs) this.close(c.key, g, e.ts)
  }

  /** Closes the windows that ended (called once a second while connected). */
  tick(now = Date.now()): void {
    for (const [key, g] of this.groups) {
      if (now - g.first >= this.windowMs) this.close(key, g, now)
    }
  }

  /** Reports everything still being counted (the core stopped). */
  flush(now = Date.now()): void {
    for (const [key, g] of this.groups) this.close(key, g, now)
  }

  private close(key: string, g: Group, now: number): void {
    this.groups.delete(key)
    if (g.count === 0) return
    const sec = Math.max(1, Math.round((now - g.first) / 1000))
    this.emit({
      ts: now,
      level: g.level,
      source: g.source,
      message: `… ещё строк: ${g.count} за ${sec} с (${g.label})`
    })
  }
}
