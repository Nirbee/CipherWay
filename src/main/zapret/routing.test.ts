import { describe, expect, it } from 'vitest'
import { NO_ZAPRET } from '../rules/compile'
import { SERVICE_DEFS } from './lists'
import {
  customKey,
  itemKeys,
  itemRules,
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

describe('zapretRouting', () => {
  it('off → empty sets', () => {
    expect(zapretRouting({ ...S, enabled: false }, new Set(['youtube']), 'primary')).toEqual(
      NO_ZAPRET
    )
  })

  it('nothing confirmed → everything of the feature through the VPN (never direct on a guess)', () => {
    const r = zapretRouting(S, new Set(), 'primary')
    expect(r.direct).toEqual([])
    expect(r.proxy[0].domain_suffix).toEqual(
      expect.arrayContaining(['youtube.com', 'discord.com', 'example.org', 'rutracker.example'])
    )
    expect(r.proxy[1].ip_cidr).toEqual(SERVICE_DEFS.discord.cidrs)
  })

  it('confirmed items direct, failed ones through the VPN — domains and addresses apart', () => {
    const r = zapretRouting(S, new Set(['discord', customKey('example.org')]), 'fallback')
    expect(r.dns).toBe('fallback')
    expect(r.direct).toEqual([
      { domain_suffix: [...SERVICE_DEFS.discord.domains, 'example.org'] },
      { ip_cidr: [...SERVICE_DEFS.discord.cidrs] }
    ])
    expect(r.proxy).toEqual([
      { domain_suffix: [...SERVICE_DEFS.youtube.domains, 'rutracker.example'] }
    ])
    expect(routingDomains(r)).toContain('googlevideo.com')
  })

  it('a service switched off disappears from both sets', () => {
    const r = zapretRouting({ ...S, services: ['discord'] }, new Set(['youtube']), 'primary')
    expect(JSON.stringify(r)).not.toContain('youtube.com')
  })

  it('keys and rules of items', () => {
    expect(itemKeys(S)).toEqual(['youtube', 'discord', 'd:example.org', 'd:rutracker.example'])
    expect(itemRules('d:example.org')).toEqual([{ domain_suffix: ['example.org'] }])
    expect(itemRules('unknown')).toEqual([])
  })
})

describe('routingChange (which connections to close)', () => {
  it('only what changed its way; address ranges reported apart', () => {
    const before = zapretRouting(S, new Set(['youtube']), 'primary')
    const after = zapretRouting(S, new Set(['youtube', 'discord']), 'primary')
    const c = routingChange(before, after)
    expect(c.domains).toContain('discord.com')
    expect(c.domains).not.toContain('youtube.com')
    expect(c.cidrs).toBe(true)
    expect(routingChange(after, after)).toEqual({ domains: [], cidrs: false })
    // a new own domain: only it
    const more = zapretRouting(
      { ...S, custom: [...S.custom, 'new.example'] },
      new Set(['youtube', 'discord']),
      'primary'
    )
    expect(routingChange(after, more)).toEqual({ domains: ['new.example'], cidrs: false })
  })
})
