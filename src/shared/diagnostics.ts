import type { AppSettings, ConnectionState, LogEntry } from './types'

// ---------------------------------------------------------------------------
// «Скопировать диагностику» / «Приложить диагностику»: version, state,
// settings and the newest log lines. Log lines arrive already masked by the
// main process (no node addresses, no subscription link); settings hold
// nothing secret. Pure — unit tested in diagnostics.test.ts.
// ---------------------------------------------------------------------------

export interface DiagnosticsInput {
  version: string
  state: ConnectionState
  servers: number
  settings: AppSettings | null
  logs: LogEntry[]
  now?: Date
}

export function formatLogLine(e: LogEntry): string {
  return `${new Date(e.ts).toISOString()} [${e.source}/${e.level}] ${e.message}`
}

/**
 * @param maxChars whole text limit (the support API takes 4096): the header
 *   always stays, log lines are added newest-first while they fit.
 * @param maxLines log lines at most
 */
export function buildDiagnostics(d: DiagnosticsInput, maxChars = Infinity, maxLines = 300): string {
  const s = d.settings
  const safe = s
    ? {
        proxyMode: s.proxyMode,
        routingMode: s.routingMode,
        autoLaunch: s.autoLaunch,
        autoConnect: s.autoConnect,
        verboseLog: s.verboseLog,
        supportUrl: s.supportUrl ? 'задана' : ''
      }
    : null
  const header = [
    'CipherWay VPN — диагностика',
    `версия: ${d.version}`,
    `дата: ${(d.now ?? new Date()).toISOString()}`,
    `состояние: ${d.state}`,
    `серверов в подписке: ${d.servers}`,
    `настройки: ${JSON.stringify(safe)}`,
    '--- последние записи журнала ---'
  ].join('\n')

  const lines: string[] = []
  let len = header.length
  for (let i = d.logs.length - 1; i >= 0 && lines.length < maxLines; i--) {
    const line = formatLogLine(d.logs[i])
    if (len + 1 + line.length > maxChars) {
      // a single huge line: keep its start rather than nothing
      if (lines.length === 0 && maxChars - len > 80)
        lines.push(`${line.slice(0, maxChars - len - 2)}…`)
      break
    }
    lines.push(line)
    len += 1 + line.length
  }
  return [header, ...lines.reverse()].join('\n')
}
