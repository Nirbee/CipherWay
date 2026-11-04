import { describe, expect, it } from 'vitest'
import type { AppSettings, LogEntry } from './types'
import { buildDiagnostics } from './diagnostics'

const settings: AppSettings = {
  proxyMode: 'tun',
  routingMode: 'rule',
  supportUrl: 'https://t.me/example_support',
  autoLaunch: false,
  autoConnect: true,
  language: 'ru',
  socksPort: 10808,
  httpPort: 10809,
  subscriptionRefreshHours: 12,
  verboseLog: false,
  apiBase: 'https://cabinet.example.com'
}
const logs: LogEntry[] = Array.from({ length: 500 }, (_, i) => ({
  ts: Date.UTC(2026, 10, 4, 12, 0, i % 60),
  level: 'info',
  source: 'singbox',
  message: `line ${i} ${'x'.repeat(40)}`
}))
const base = {
  version: '0.4.1',
  state: 'connected' as const,
  servers: 8,
  settings,
  logs,
  now: new Date(0)
}

describe('buildDiagnostics', () => {
  it('header + newest 300 lines by default, oldest first', () => {
    const text = buildDiagnostics(base)
    expect(text).toContain('версия: 0.4.1')
    expect(text).toContain('серверов в подписке: 8')
    expect(text).not.toContain('line 199 ')
    expect(text).toContain('line 200 ')
    expect(text.indexOf('line 200 ')).toBeLessThan(text.indexOf('line 499 '))
  })

  it('fits into the support message limit, keeping the newest lines', () => {
    const text = buildDiagnostics(base, 4096)
    expect(text.length).toBeLessThanOrEqual(4096)
    expect(text).toContain('line 499 ')
    expect(text).toContain('CipherWay VPN — диагностика')
  })

  it('never includes the support link or other settings values beyond the safe subset', () => {
    const text = buildDiagnostics(base)
    expect(text).not.toContain('t.me/example_support')
    expect(text).not.toContain('cabinet.example.com')
    expect(text).toContain('"supportUrl":"задана"')
  })
})
