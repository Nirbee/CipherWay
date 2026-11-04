import { describe, expect, it } from 'vitest'
import type { OutboundConfig } from '@shared/types'
import {
  allIps,
  isRoutableIp,
  normalizeHost,
  resolveServers,
  toExcludeCidrs,
  type LookupFn
} from './resolve'

const node = (id: string, server: string): OutboundConfig => ({
  id,
  name: id,
  protocol: 'vless',
  server,
  port: 443
})

// made-up answers (documentation ranges), no real DNS
const table: Record<string, { address: string; family: number }[]> = {
  'nl.example.com': [
    { address: '2001:db8::7', family: 6 },
    { address: '198.51.100.7', family: 4 }
  ],
  'de.example.com': [{ address: '198.51.100.9', family: 4 }]
}
const lookup: LookupFn = async (h) => {
  if (h === 'slow.example.com') return new Promise(() => undefined) // never answers
  const r = table[h]
  if (!r) throw new Error('ENOTFOUND')
  return r
}

describe('resolveServers', () => {
  it('resolves each distinct host once, IPv4 first; IP literals map to themselves', async () => {
    const calls: string[] = []
    const res = await resolveServers(
      [
        node('a', 'nl.example.com'),
        node('b', 'NL.example.com'),
        node('c', '203.0.113.10'),
        node('d', '[2001:db8::1]'),
        node('e', 'de.example.com')
      ],
      async (h) => {
        calls.push(h)
        return lookup(h)
      }
    )
    expect(calls.sort()).toEqual(['de.example.com', 'nl.example.com'])
    expect(res).toEqual({
      'nl.example.com': ['198.51.100.7', '2001:db8::7'],
      '203.0.113.10': ['203.0.113.10'],
      '2001:db8::1': ['2001:db8::1'],
      'de.example.com': ['198.51.100.9']
    })
  })

  it('failed and timed-out lookups are skipped (the cores resolve those themselves)', async () => {
    const res = await resolveServers(
      [node('a', 'gone.example.com'), node('b', 'slow.example.com'), node('c', 'de.example.com')],
      lookup,
      50
    )
    expect(res).toEqual({ 'de.example.com': ['198.51.100.9'] })
  })
})

describe('exclusion CIDRs', () => {
  it('/32 for IPv4, /128 for IPv6, deduped; loopback / link-local skipped', () => {
    expect(
      toExcludeCidrs({
        a: ['198.51.100.7', '2001:DB8::7'],
        b: ['198.51.100.7'],
        c: ['127.0.0.1', '::1', 'fe80::1', '0.0.0.0']
      })
    ).toEqual(['198.51.100.7/32', '2001:db8::7/128'])
  })

  it('helpers', () => {
    expect(normalizeHost(' [2001:DB8::1] ')).toBe('2001:db8::1')
    expect(isRoutableIp('10.0.0.1')).toBe(true)
    expect(isRoutableIp('not-an-ip')).toBe(false)
    expect(allIps({ a: ['1.1.1.1'], b: ['1.1.1.1', '2.2.2.2'] })).toEqual(['1.1.1.1', '2.2.2.2'])
  })
})
