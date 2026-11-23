import { describe, expect, it } from 'vitest'
import {
  normalizeConfig,
  normalizeFlags,
  retryAfterMs,
  TelemetryApi,
  TelemetryError,
  telemetryError
} from './api'

const CTX = {
  apiBase: 'https://cabinet.example.com/',
  subscriptionUrl: 'https://sub.example.com/api/sub/TOKEN123abc',
  deviceHeaders: { 'x-hwid': 'hw', 'User-Agent': 'CipherWay/1.0' }
}

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(responses: Response[]): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses.shift()
    if (!r) throw new TypeError('fetch failed')
    return r
  }) as unknown as typeof fetch
  return { fn, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })

describe('DevVersion API client', () => {
  it('POST: gzip body, Content-Encoding, the token header, to the API origin only', async () => {
    const f = fakeFetch([json(202, { ok: true })])
    const api = new TelemetryApi(() => CTX, f.fn)
    expect(await api.upload(new Uint8Array([1, 2, 3]))).toBeNull()
    const c = f.calls[0]
    expect(c.url).toBe('https://cabinet.example.com/api/app/v1/telemetry')
    expect(c.init.method).toBe('POST')
    const h = c.init.headers as Record<string, string>
    expect(h['X-Subscription-Token']).toBe('TOKEN123abc')
    expect(h['Content-Encoding']).toBe('gzip')
    expect(h['Content-Type']).toBe('application/json')
    expect(h['x-hwid']).toBe('hw')
    expect(c.init.redirect).toBe('manual')
  })

  it('status → error kind: 413 / 429 / 403 (inactive, trial, not allowed) / 404 / 422 / 415 / 503', async () => {
    const cases: [Response, string][] = [
      [json(413, { detail: 'too_large' }), 'too_large'],
      [json(429, { detail: 'rate_limited' }, { 'retry-after': '120' }), 'rate'],
      [json(403, { detail: 'subscription_inactive' }), 'inactive'],
      [json(403, { detail: 'trial_not_allowed' }), 'trial'],
      [json(403, { detail: 'not_allowed' }), 'not_allowed'],
      [json(403, null), 'inactive'],
      [json(404, { detail: 'telemetry_disabled' }), 'disabled'],
      [json(404, { detail: 'Not Found' }), 'not_found'],
      [json(422, { detail: 'consent_version' }), 'rejected'],
      [json(400, { detail: 'bad_gzip' }), 'rejected'],
      [json(415, null), 'unsupported'],
      [json(503, null), 'server'],
      [json(502, null), 'server']
    ]
    for (const [res, kind] of cases) {
      const api = new TelemetryApi(() => CTX, fakeFetch([res]).fn)
      const err = await api.upload(new Uint8Array([1])).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TelemetryError)
      expect((err as TelemetryError).kind).toBe(kind)
      if (kind === 'rate') expect((err as TelemetryError).retryAfterMs).toBe(120_000)
      if (res.status === 422) expect((err as TelemetryError).detail).toBe('consent_version')
    }
    const net = new TelemetryApi(() => CTX, fakeFetch([]).fn)
    expect(((await net.config().catch((e: unknown) => e)) as TelemetryError).kind).toBe('network')
  })

  it('no subscription: nothing is sent', async () => {
    const f = fakeFetch([json(200, {})])
    const api = new TelemetryApi(() => ({ ...CTX, subscriptionUrl: null }), f.fn)
    expect(((await api.deleteAll().catch((e: unknown) => e)) as TelemetryError).kind).toBe('nosub')
    expect(f.calls.length).toBe(0)
  })

  it('a redirect to another origin is not followed (the token stays home)', async () => {
    const f = fakeFetch([
      new Response(null, { status: 302, headers: { location: 'https://evil.example.net/x' } })
    ])
    const api = new TelemetryApi(() => CTX, f.fn)
    await expect(api.config()).rejects.toBeInstanceOf(TelemetryError)
    expect(f.calls.length).toBe(1)
  })

  it('config: defaults and bounds; DELETE answers {deleted}', async () => {
    const f = fakeFetch([
      json(200, {
        enabled: false,
        consent_version: 2,
        upload_interval_s: 5,
        max_report_bytes: 10,
        flags: { x: 1 }
      }),
      json(200, { deleted: 4 })
    ])
    const api = new TelemetryApi(() => CTX, f.fn)
    expect(await api.config()).toEqual({
      enabled: false,
      consentVersion: '2',
      uploadIntervalS: 600,
      maxReportBytes: 64 * 1024,
      flags: { x: 1 },
      reason: null
    })
    expect(normalizeConfig({ enabled: false, reason: 'trial_not_allowed' }).reason).toBe(
      'trial_not_allowed'
    )
    expect(await api.deleteAll()).toBe(4)
    expect(f.calls[1].init.method).toBe('DELETE')
    expect(normalizeConfig(null)).toMatchObject({
      enabled: true,
      uploadIntervalS: 3600,
      maxReportBytes: 512 * 1024
    })
  })

  it('helpers', () => {
    expect(retryAfterMs('30')).toBe(30_000)
    expect(retryAfterMs(null)).toBeUndefined()
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000)
    expect(telemetryError(401, '').kind).toBe('auth')
    expect(TelemetryApi.host('https://Cabinet.Example.com/')).toBe('cabinet.example.com')
    expect(TelemetryApi.host('nope')).toBeNull()
  })

  it('flags: flat only — key ^[a-z0-9_]{1,32}$, value bool / integer / short string', () => {
    expect(
      normalizeFlags({
        probe_interval_s: 3600,
        heavy_probes: false,
        mode: 'lite',
        tunnel_probe_s: 90,
        'Bad-Key': 1,
        nested: { a: 1 },
        list: [1],
        frac: 1.5,
        long: 'x'.repeat(65),
        [`k${'a'.repeat(32)}`]: 1,
        nul: null
      })
    ).toEqual({ probe_interval_s: 3600, heavy_probes: false, mode: 'lite', tunnel_probe_s: 90 })
    expect(normalizeFlags([1, 2])).toEqual({})
    expect(normalizeFlags(null)).toEqual({})
  })
})
