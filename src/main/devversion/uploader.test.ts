import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TelemetryError } from './api'
import { DiskQueue } from './queue'
import { gunzipAsync, gzipAsync, Uploader } from './uploader'

let dir: string
let q: DiskQueue
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-devup-'))
  q = new DiskQueue(join(dir, 'q'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const report = (n = 10): Record<string, unknown> => ({
  schema: 1,
  install_id: 'id',
  apps: Array.from({ length: n }, (_, i) => ({
    process: `p${i}.exe`,
    domains: Array.from({ length: 50 }, (_, j) => ({ d: `d${j}.example.com`, up: j })),
    ips: []
  })),
  probes: [],
  events: [],
  game_tests: []
})
const gz = async (r: Record<string, unknown>): Promise<Buffer> =>
  gzipAsync(Buffer.from(JSON.stringify(r), 'utf8'))

function fakeApi(answers: (Error | null)[]): {
  upload: (b: Uint8Array) => Promise<string | null>
  sent: Buffer[]
} {
  const sent: Buffer[] = []
  return {
    sent,
    upload: async (b) => {
      sent.push(Buffer.from(b))
      const a = answers.shift() ?? null
      if (a) throw a
      return 'id-1'
    }
  }
}

describe('DevVersion uploader', () => {
  it('202: the report leaves the queue, the result is shown', async () => {
    await q.push(await gz(report()))
    const api = fakeApi([null])
    const u = new Uploader({ api, queue: q, maxBytes: () => 1024 * 1024, now: () => 5000 })
    expect(await u.run()).toEqual({ sent: 1, dropped: 0 })
    expect(await q.totals()).toEqual({ reports: 0, bytes: 0 })
    expect(u.last).toMatchObject({ at: 5000, ok: true })
    // what went out is gzip of the JSON
    expect(JSON.parse((await gunzipAsync(api.sent[0])).toString()).schema).toBe(1)
  })

  it('413: the report is cut in half and sent again; an uncuttable one is dropped', async () => {
    await q.push(await gz(report(40)))
    const api = fakeApi([new TelemetryError('too_large', 413), null])
    const u = new Uploader({ api, queue: q, maxBytes: () => 1024 * 1024 })
    const res = await u.run()
    expect(res.sent).toBe(1)
    expect(api.sent.length).toBe(2)
    const first = (await gunzipAsync(api.sent[0])).length
    const second = (await gunzipAsync(api.sent[1])).length
    expect(second).toBeLessThanOrEqual(first / 2)

    await q.push(await gz({ schema: 1, apps: [] }))
    const api2 = fakeApi([new TelemetryError('too_large', 413)])
    const u2 = new Uploader({ api: api2, queue: q, maxBytes: () => 1024 * 1024 })
    expect(await u2.run()).toEqual({ sent: 0, dropped: 1 })
    expect(u2.last?.ok).toBe(false)
  })

  it('429: waits Retry-After (or 15 min) and keeps the report', async () => {
    await q.push(await gz(report()))
    let now = 1000
    const api = fakeApi([new TelemetryError('rate', 429, 120_000)])
    const u = new Uploader({ api, queue: q, maxBytes: () => 1 << 20, now: () => now })
    expect((await u.run()).stop).toBe('rate')
    expect((await q.totals()).reports).toBe(1)
    now = 100_000
    expect((await u.run()).stop).toBe('backoff')
    now = 121_001
    expect((await u.run()).sent).toBe(1)

    await q.push(await gz(report()))
    const u2 = new Uploader({
      api: fakeApi([new TelemetryError('rate', 429)]),
      queue: q,
      maxBytes: () => 1 << 20,
      now: () => 0
    })
    await u2.run()
    expect(u2.backoff.readyAt).toBe(15 * 60_000)
  })

  it('403 subscription_inactive / 404: paused with a status text; only a forced run tries again', async () => {
    await q.push(await gz(report()))
    const u = new Uploader({
      api: fakeApi([new TelemetryError('inactive', 403)]),
      queue: q,
      maxBytes: () => 1 << 20
    })
    expect((await u.run()).stop).toBe('paused')
    expect(u.paused).toBe('inactive')
    expect(u.last?.text).toMatch(/Подписка не активна/)
    expect((await u.run()).stop).toBe('paused')

    const u404 = new Uploader({
      api: fakeApi([new TelemetryError('not_found', 404), null]),
      queue: q,
      maxBytes: () => 1 << 20
    })
    await u404.run()
    expect(u404.paused).toBe('not_found')
    expect((await u404.run(true)).sent).toBe(1)
    expect(u404.paused).toBeNull()
  })

  it('403 trial / not allowed, 404 telemetry_disabled, 415: paused with a clear status', async () => {
    const cases: [TelemetryError, string, RegExp][] = [
      [new TelemetryError('trial', 403), 'trial', /недоступна на пробном периоде/],
      [new TelemetryError('not_allowed', 403), 'not_allowed', /доступна не всем/],
      [new TelemetryError('disabled', 404), 'server_off', /выключен на сервере/],
      [new TelemetryError('unsupported', 415), 'unsupported', /обновите приложение/]
    ]
    await q.push(await gz(report()))
    for (const [err, pause, text] of cases) {
      const u = new Uploader({ api: fakeApi([err]), queue: q, maxBytes: () => 1 << 20 })
      expect((await u.run()).stop).toBe('paused')
      expect(u.paused).toBe(pause)
      expect(u.last?.text).toMatch(text)
    }
    expect((await q.totals()).reports).toBe(1)
  })

  it('400 / 422: this report breaks the contract — dropped with the reason, the rest go on', async () => {
    await q.push(await gz(report()), 1000)
    await q.push(await gz(report()), 2000)
    const logs: string[] = []
    const u = new Uploader({
      api: fakeApi([new TelemetryError('rejected', 422, undefined, 'consent_version'), null]),
      queue: q,
      maxBytes: () => 1 << 20,
      log: (m) => logs.push(m)
    })
    expect(await u.run()).toEqual({ sent: 1, dropped: 1 })
    expect(logs[0]).toContain('consent_version')
    expect((await q.totals()).reports).toBe(0)
  })

  it('503: backoff and retry', async () => {
    await q.push(await gz(report()))
    const u = new Uploader({
      api: fakeApi([new TelemetryError('server', 503)]),
      queue: q,
      maxBytes: () => 1 << 20,
      now: () => 0
    })
    expect((await u.run()).stop).toBe('backoff')
    expect(u.last?.text).toMatch(/503/)
    expect((await q.totals()).reports).toBe(1)
  })

  it('network / 5xx: exponential backoff, the report stays', async () => {
    await q.push(await gz(report()))
    let now = 0
    const u = new Uploader({
      api: fakeApi([new TelemetryError('network'), new TelemetryError('server', 502)]),
      queue: q,
      maxBytes: () => 1 << 20,
      now: () => now
    })
    expect((await u.run()).stop).toBe('backoff')
    const first = u.backoff.readyAt
    expect(first).toBeGreaterThanOrEqual(48_000)
    now = first
    expect((await u.run()).stop).toBe('backoff')
    expect(u.backoff.readyAt - now).toBeGreaterThanOrEqual(96_000)
    expect((await q.totals()).reports).toBe(1)
  })

  it('at most 3 reports per run (the server allows 6 an hour)', async () => {
    for (let i = 0; i < 5; i++) await q.push(await gz(report(1)), 1000 + i)
    const u = new Uploader({ api: fakeApi([]), queue: q, maxBytes: () => 1 << 20 })
    expect((await u.run()).sent).toBe(3)
    expect((await q.totals()).reports).toBe(2)
  })
})
