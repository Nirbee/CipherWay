import type { LogEntry } from '@shared/types'
import { redactLan } from './redact'

// ---------------------------------------------------------------------------
// The LAN daemon logs a lot (netcheck, magicsock, wgengine every minute). In
// «Логи» (1000 lines shared with the cores) only what matters is shown — errors,
// state changes, login, adapter / router, peers — the rest only with «Подробный
// журнал». Keys and public addresses are always redacted (redact.ts).
// 0.5.2 (LanLogFolder): what repeats on every network change of Windows (a
// Teredo flap is enough — 200+ times in 3 hours on a test PC) is folded:
// the first line stays, the rest become one «… ещё N за 5 мин» per kind and
// window; tailscaled's own «[RATELIMIT]» notes are dropped.
// Pure — unit tested in lanCtl.test.ts.
// ---------------------------------------------------------------------------

const ERRORISH = /\b(error|failed|failure|panic|fatal|denied|refused|unable)\b/i
const IMPORTANT =
  /(Switching ipn state|ipn state|NeedsLogin|NeedsMachineAuth|Running|Stopped|control: |doLogin|RegisterReq|authRoutine|tun\b|wintun|router:|health\(|logged in|logout|DERP home|derp-\d+: connected|magicsock: endpoints changed|wgengine: Reconfig: configuring router|disco: node .* now using|Reconfig: configuring userspace WireGuard|LinkChange: major)/i
/** «2026/11/18 20:31:05 » / «2026/11/18 20:31:05.123456 » at the start of a tailscaled line */
const STAMP = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(\.\d+)? /

/** tailscaled's note that it dropped repeats of a message — noise of noise */
const DROPPED = /^\[RATELIMIT\]/
/** chatty on every network change: one line + a count per window */
const FOLDED: { key: string; re: RegExp; label: string }[] = [
  { key: 'endpoints', re: /^magicsock: endpoints changed/, label: 'magicsock: endpoints changed' },
  { key: 'netinfo', re: /^control: NetInfo/, label: 'control: NetInfo' },
  { key: 'linkchange', re: /^LinkChange: major, rebinding/, label: 'LinkChange: major, rebinding' }
]
export const LAN_FOLD_WINDOW_MS = 5 * 60_000

/** «LinkChange: major, rebinding: old: {…} new: {…} diff: X» → only what changed */
function shortLinkChange(line: string): string {
  const m = /^(LinkChange: major, rebinding): old: .* diff: (.*)$/.exec(line)
  return m ? `${m[1]} — ${m[2]}` : line
}

export function lanLogEntries(lines: string[], verbose: boolean, now = Date.now()): LogEntry[] {
  const out: LogEntry[] = []
  for (const raw of lines) {
    const line = shortLinkChange(redactLan(raw.replace(STAMP, '').trim()))
    if (!line) continue
    const level: LogEntry['level'] = ERRORISH.test(line)
      ? 'warn'
      : IMPORTANT.test(line)
        ? 'info'
        : 'debug'
    if (level === 'debug' && !verbose) continue
    out.push({ ts: now, level, source: 'lan', message: line.slice(0, 2000) })
  }
  return out
}

interface Window {
  first: number
  count: number
}

/**
 * lanLogEntries + folding (not with «Подробный журнал»: then everything stays).
 * Call push() with each batch of the daemon's log and tick() now and then — a
 * window that ended is reported even if the daemon went quiet.
 */
export class LanLogFolder {
  private windows = new Map<string, Window>()

  constructor(private windowMs = LAN_FOLD_WINDOW_MS) {}

  push(lines: string[], verbose: boolean, now = Date.now()): LogEntry[] {
    const out = this.tick(now)
    for (const e of lanLogEntries(lines, verbose, now)) {
      if (verbose) {
        out.push(e)
        continue
      }
      if (DROPPED.test(e.message)) continue
      const kind = e.level === 'warn' ? undefined : FOLDED.find((f) => f.re.test(e.message))
      if (!kind) {
        out.push(e)
        continue
      }
      const w = this.windows.get(kind.key)
      if (w) {
        w.count++
        continue
      }
      this.windows.set(kind.key, { first: now, count: 0 })
      out.push(e)
    }
    return out
  }

  /** «… ещё N за 5 мин (…)» for every window that ended by `now`. */
  tick(now = Date.now()): LogEntry[] {
    const out: LogEntry[] = []
    for (const f of FOLDED) {
      const w = this.windows.get(f.key)
      if (!w || now - w.first < this.windowMs) continue
      this.windows.delete(f.key)
      if (w.count === 0) continue
      const min = Math.max(1, Math.round((now - w.first) / 60_000))
      out.push({
        ts: now,
        level: 'info',
        source: 'lan',
        message: `… ещё строк: ${w.count} за ${min} мин (${f.label})`
      })
    }
    return out
  }
}
