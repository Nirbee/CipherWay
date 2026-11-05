import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { GeoCache } from './geo'

const dir = mkdtempSync(join(tmpdir(), 'cw-geo-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SRS = Buffer.from('SRS\x03fake')

function deps(over: Partial<ConstructorParameters<typeof GeoCache>[0]> = {}) {
  const warn = vi.fn()
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    void url
    return new Response(SRS, { status: 200 })
  })
  // «decompile»: writes the source rules the real sing-box would produce
  const decompile = vi.fn(async (srs: string, json: string) => {
    expect(readFileSync(srs).subarray(0, 3).toString()).toBe('SRS')
    writeFileSync(json, JSON.stringify({ version: 1, rules: [{ domain_suffix: ['ya.ru'] }] }))
  })
  return { dir, decompile, fetch: fetchFn as unknown as typeof fetch, warn, ...over }
}

describe('GeoCache', () => {
  it('downloads the SagerNet set, decompiles it once and caches it', async () => {
    const d = deps()
    const g = new GeoCache(d)
    const res = await g.load(['geosite-yandex'])
    expect(res.get('geosite-yandex')).toEqual([{ domain_suffix: ['ya.ru'] }])
    expect((d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-yandex.srs'
    )
    // second load: memory; a new instance: the file cache (no download)
    await g.load(['geosite-yandex'])
    const d2 = deps()
    await new GeoCache(d2).load(['geosite-yandex'])
    expect(d.decompile).toHaveBeenCalledTimes(1)
    expect(d2.fetch).not.toHaveBeenCalled()
  })

  it('a set that does not exist (404) is skipped with a warning, not retried at once', async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    })
    const g = new GeoCache(d)
    expect((await g.load(['geoip-telegram'])).has('geoip-telegram')).toBe(false)
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('geoip-telegram не загружен'))
    await g.load(['geoip-telegram'])
    expect(d.fetch).toHaveBeenCalledTimes(1)
  })

  it('an old cache is used when the refresh fails', async () => {
    writeFileSync(
      join(dir, 'geoip-ru.json'),
      JSON.stringify({ version: 1, rules: [{ ip_cidr: ['5.0.0.0/8'] }] })
    )
    const old = new Date(Date.now() - 3 * 24 * 3600_000)
    utimesSync(join(dir, 'geoip-ru.json'), old, old)
    const d = deps({
      fetch: vi.fn(async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch
    })
    const res = await new GeoCache(d).load(['geoip-ru'])
    expect(res.get('geoip-ru')).toEqual([{ ip_cidr: ['5.0.0.0/8'] }])
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('используется сохранённый'))
  })

  it('refuses names with path tricks and non-rule-set downloads', async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    })
    const g = new GeoCache(d)
    expect((await g.load(['geosite-../../x', 'geosite-html'])).size).toBe(0)
    expect(d.decompile).not.toHaveBeenCalled()
  })
})
