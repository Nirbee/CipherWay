import type { LogEntry } from '@shared/types'
import { redactLan } from './redact'

// ---------------------------------------------------------------------------
// The LAN daemon logs a lot (netcheck, magicsock, wgengine every minute). In
// «Логи» (1000 lines shared with the cores) only what matters is shown — errors,
// state changes, login, adapter / router — the rest only with «Подробный
// журнал». Keys and public addresses are always redacted (redact.ts).
// Pure — unit tested in logLines.test.ts.
// ---------------------------------------------------------------------------

const ERRORISH = /\b(error|failed|failure|panic|fatal|denied|refused|unable)\b/i
const IMPORTANT =
  /(Switching ipn state|ipn state|NeedsLogin|NeedsMachineAuth|Running|Stopped|control: |doLogin|RegisterReq|authRoutine|tun\b|wintun|router:|health\(|logged in|logout|DERP home|derp-\d+: connected|magicsock: endpoints changed|wgengine: Reconfig: configuring router)/i
/** «2026/11/18 20:31:05 » / «2026/11/18 20:31:05.123456 » at the start of a tailscaled line */
const STAMP = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(\.\d+)? /

export function lanLogEntries(lines: string[], verbose: boolean, now = Date.now()): LogEntry[] {
  const out: LogEntry[] = []
  for (const raw of lines) {
    const line = redactLan(raw.replace(STAMP, '').trim())
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
