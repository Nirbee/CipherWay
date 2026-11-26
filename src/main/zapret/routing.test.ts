import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { NO_ZAPRET, ruleSetText } from '../rules/compile'
import { SERVICE_DEFS } from './lists'
import {
  customKey,
  itemKeys,
  itemRules,
  routeKeyOf,
  routeKeys,
  routingChange,
  routingDomains,
  zapretRouting
} from './routing'

const S = {
  enabled: true,
  services: ['youtube', 'discord'] as ('youtube' | 'discord')[],
  custom: ['example.org', 'rutracker.example'],
  warned: true
}
const YT_ALL = new Set(['youtube', 'youtube:video', 'youtube:quic'])

describe('zapretRouting', () => {
  it('off → empty sets', () => {
    expect(zapretRouting({ ...S, enabled: false }, YT_ALL, 'primary')).toEqual(NO_ZAPRET)
  })

  it('nothing confirmed → everything of the feature through the VPN (never direct on a guess)', () => {
    const r = zapretRouting(S, new Set(), 'primary')
    expect(r.direct).toEqual([])
    expect(r.proxy[0].domain_suffix).toEqual(
      expect.arrayContaining(['youtube.com', 'googlevideo.com', 'discord.com', 'example.org'])
    )
    expect(r.proxy[0].network).toBeUndefined()
    expect(r.proxy.at(-1)?.ip_cidr).toEqual(SERVICE_DEFS.discord.cidrs)
  })

  it('confirmed items direct, failed ones through the VPN — domains and addresses apart', () => {
    const r = zapretRouting(S, new Set(['discord', customKey('example.org')]), 'fallback')
    expect(r.dns).toBe('fallback')
    expect(r.direct).toEqual([
      { domain_suffix: [...SERVICE_DEFS.discord.domains, 'example.org'] },
      { ip_cidr: [...SERVICE_DEFS.discord.cidrs] }
    ])
    expect(r.proxy).toHaveLength(1)
    expect(r.proxy[0].domain_suffix).toEqual(
      expect.arrayContaining([...SERVICE_DEFS.youtube.domains, 'rutracker.example'])
    )
    expect(routingDomains(r)).toContain('googlevideo.com')
  })

  it('YouTube by protocol: video over QUIC direct, over TCP through the VPN; the pages by their own result', () => {
    const r = zapretRouting(
      { ...S, services: ['youtube'], custom: [] },
      new Set(['youtube', 'youtube:quic']),
      'primary'
    )
    const pages = SERVICE_DEFS.youtube.domains.filter((d) => d !== 'googlevideo.com')
    expect(r.direct).toEqual([
      // TCP (pages) + UDP (QUIC) → no network field
      { domain_suffix: pages },
      { domain_suffix: ['googlevideo.com'], network: ['udp'] }
    ])
    expect(r.proxy).toEqual([{ domain_suffix: ['googlevideo.com'], network: ['tcp'] }])
    // only QUIC direct
    const q = zapretRouting({ ...S, services: ['youtube'], custom: [] }, new Set(['youtube:quic']), 'primary')
    expect(q.direct).toEqual([{ domain_suffix: [...SERVICE_DEFS.youtube.domains], network: ['udp'] }])
    expect(q.proxy).toEqual([
      { domain_suffix: [...pages, 'googlevideo.com'], network: ['tcp'] }
    ])
  })

  it('the more specific domain wins: a direct parent never takes a VPN subdomain', () => {
    const s = { ...S, services: [], custom: ['pragmaengine.com', 'live.wardogs.bulkhead.pragmaengine.com'] }
    // the subdomain ✓, the root not: the direct set is matched first — nothing to cut
    const a = zapretRouting(s, new Set([customKey('live.wardogs.bulkhead.pragmaengine.com')]), 'primary')
    expect(a.direct).toEqual([{ domain_suffix: ['live.wardogs.bulkhead.pragmaengine.com'] }])
    expect(a.proxy).toEqual([{ domain_suffix: ['pragmaengine.com'] }])
    // the root ✓, the subdomain not: cut out of the root
    const b = zapretRouting(s, new Set([customKey('pragmaengine.com')]), 'primary')
    expect(b.direct).toEqual([
      {
        type: 'logical',
        mode: 'and',
        rules: [
          { domain_suffix: ['pragmaengine.com'] },
          { domain_suffix: ['live.wardogs.bulkhead.pragmaengine.com'], invert: true }
        ]
      }
    ])
    expect(routingDomains(b)).toEqual(['pragmaengine.com', 'live.wardogs.bulkhead.pragmaengine.com'])
  })

  it('a service switched off disappears from both sets', () => {
    const r = zapretRouting({ ...S, services: ['discord'] }, YT_ALL, 'primary')
    expect(JSON.stringify(r)).not.toContain('youtube.com')
  })

  it('keys and rules of items', () => {
    expect(itemKeys(S)).toEqual(['youtube', 'discord', 'd:example.org', 'd:rutracker.example'])
    expect(routeKeys(S).slice(0, 3)).toEqual(['youtube', 'youtube:video', 'youtube:quic'])
    expect(itemRules('d:example.org')).toEqual([{ domain_suffix: ['example.org'] }])
    expect(itemRules('youtube:video')).toEqual([{ domain_suffix: ['googlevideo.com'], network: ['tcp'] }])
    expect(itemRules('unknown')).toEqual([])
  })

  it('which route key a connection belongs to: the most specific domain, then its protocol', () => {
    const s = { ...S, custom: ['example.org', 'a.example.org'] }
    expect(routeKeyOf(s, 'rr1---sn-x.googlevideo.com', 'tcp')).toBe('youtube:video')
    expect(routeKeyOf(s, 'rr1---sn-x.googlevideo.com', 'udp')).toBe('youtube:quic')
    expect(routeKeyOf(s, 'www.youtube.com', 'udp')).toBe('youtube:quic')
    expect(routeKeyOf(s, 'i.ytimg.com', 'tcp')).toBe('youtube')
    expect(routeKeyOf(s, 'x.a.example.org', 'tcp')).toBe('d:a.example.org')
    expect(routeKeyOf(s, 'b.example.org', 'tcp')).toBe('d:example.org')
    expect(routeKeyOf(s, 'nothing.example.com', 'tcp')).toBeNull()
  })
})

describe('routingChange (which connections to close)', () => {
  it('only what changed its way; address ranges reported apart', () => {
    const before = zapretRouting(S, YT_ALL, 'primary')
    const after = zapretRouting(S, new Set([...YT_ALL, 'discord']), 'primary')
    const c = routingChange(before, after)
    expect(c.domains).toContain('discord.com')
    expect(c.domains).not.toContain('youtube.com')
    expect(c.cidrs).toBe(true)
    expect(c.affects('cdn.discordapp.com', 'tcp', '')).toBe(true)
    expect(c.affects('www.youtube.com', 'tcp', '')).toBe(false)
    expect(c.affects('', 'udp', 'rule_set=cw-z-p => route(proxy)')).toBe(true)
    const same = routingChange(after, after)
    expect(same.domains).toEqual([])
    expect(same.cidrs).toBe(false)
    // a new own domain: only it
    const more = zapretRouting({ ...S, custom: [...S.custom, 'new.example'] }, new Set([...YT_ALL, 'discord']), 'primary')
    expect(routingChange(after, more).domains).toEqual(['new.example'])
  })

  it('a protocol of its own: QUIC moving does not cut the TCP connections', () => {
    const s = { ...S, services: ['youtube' as const], custom: [] }
    const a = zapretRouting(s, new Set(['youtube', 'youtube:video']), 'primary')
    const b = zapretRouting(s, new Set(['youtube', 'youtube:video', 'youtube:quic']), 'primary')
    const c = routingChange(a, b)
    expect(c.affects('rr1---sn-x.googlevideo.com', 'udp', '')).toBe(true)
    expect(c.affects('rr1---sn-x.googlevideo.com', 'tcp', '')).toBe(false)
  })

  it('a ✓ subdomain is never cut off because its parent moved', () => {
    const s = { ...S, services: [], custom: ['pragmaengine.com', 'live.wardogs.bulkhead.pragmaengine.com'] }
    const sub = customKey('live.wardogs.bulkhead.pragmaengine.com')
    const a = zapretRouting(s, new Set([sub]), 'primary')
    const b = zapretRouting(s, new Set([sub, customKey('pragmaengine.com')]), 'primary')
    const c = routingChange(a, b)
    expect(c.affects('live.wardogs.bulkhead.pragmaengine.com', 'tcp', '')).toBe(false)
    expect(c.affects('cdn.pragmaengine.com', 'tcp', '')).toBe(true)
  })
})

// --- sing-box itself matches the sets this way ------------------------------
const CORE = resolve(__dirname, '../../../resources/bin/cipherway-core.exe')

describe.skipIf(process.platform !== 'win32' || !existsSync(CORE))('the sets in sing-box (rule-set match)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cw-zset-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  const matches = (rules: Record<string, unknown>[], domain: string): boolean => {
    const f = join(tmp, `s${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(f, ruleSetText(rules))
    // sing-box prints the match into its log (stderr)
    const r = spawnSync(CORE, ['rule-set', 'match', '-f', 'source', f, domain], {
      windowsHide: true,
      timeout: 20_000
    })
    return /match rules/.test(`${r.stdout}${r.stderr}`)
  }

  it('a direct root with a VPN subdomain: the subdomain is not in the direct set; the compiler accepts the sets', () => {
    const s = { ...S, services: [], custom: ['pragmaengine.com', 'live.wardogs.bulkhead.pragmaengine.com'] }
    const r = zapretRouting(s, new Set([customKey('pragmaengine.com')]), 'primary')
    expect(matches(r.direct, 'cdn.pragmaengine.com')).toBe(true)
    expect(matches(r.direct, 'live.wardogs.bulkhead.pragmaengine.com')).toBe(false)
    expect(matches(r.direct, 'x.live.wardogs.bulkhead.pragmaengine.com')).toBe(false)
    expect(matches(r.proxy, 'live.wardogs.bulkhead.pragmaengine.com')).toBe(true)
    // network-specific sets compile too
    const yt = zapretRouting({ ...S, custom: [] }, new Set(['youtube', 'youtube:quic']), 'primary')
    const f = join(tmp, 'yt.json')
    writeFileSync(f, ruleSetText(yt.direct))
    execFileSync(CORE, ['rule-set', 'compile', '-o', join(tmp, 'yt.srs'), f], { windowsHide: true, timeout: 20_000 })
  })
})
