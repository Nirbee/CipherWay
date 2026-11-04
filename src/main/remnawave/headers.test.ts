import { describe, expect, it } from 'vitest'
import type { SubscriptionData } from '@shared/types'
import { decodeHeaderText, parseSubscriptionHeaders, parseUserInfoHeader, safeLink } from './headers'
import { toSubscriptionView } from './view'

const b64 = (s: string): string => `base64:${Buffer.from(s, 'utf8').toString('base64')}`

describe('subscription-userinfo', () => {
  it('parses upload / download / total / expire', () => {
    expect(
      parseUserInfoHeader('upload=1024; download=2048; total=10737418240; expire=1767225600')
    ).toEqual({ upload: 1024, download: 2048, total: 10737418240, expire: 1767225600 })
  })

  it('tolerates spacing, unknown keys and garbage values', () => {
    expect(parseUserInfoHeader(' upload = 5 ;download=x; foo=1; total=0 ;')).toEqual({
      upload: 5,
      total: 0
    })
    expect(parseUserInfoHeader('expire=')).toBeUndefined()
    expect(parseUserInfoHeader(null)).toBeUndefined()
    expect(parseUserInfoHeader('upload=-1')).toBeUndefined()
  })
})

describe('header text (title / announce)', () => {
  it('decodes base64: prefix (Cyrillic) and plain text', () => {
    expect(decodeHeaderText(b64('Моя подписка'))).toBe('Моя подписка')
    expect(decodeHeaderText('Plain title')).toBe('Plain title')
    expect(decodeHeaderText('   ')).toBeUndefined()
    expect(decodeHeaderText(null)).toBeUndefined()
  })
})

describe('links from headers', () => {
  it('accepts https and tg, normalises t.me shorthands, rejects the rest', () => {
    expect(safeLink('https://t.me/example_support')).toBe('https://t.me/example_support')
    expect(safeLink('tg://resolve?domain=example_bot')).toBe('tg://resolve?domain=example_bot')
    expect(safeLink('t.me/example_support')).toBe('https://t.me/example_support')
    expect(safeLink('@example_support')).toBe('https://t.me/example_support')
    expect(safeLink('http://example.com')).toBeUndefined()
    expect(safeLink('javascript:alert(1)')).toBeUndefined()
    expect(safeLink('file:///C:/x.exe')).toBeUndefined()
    expect(safeLink(undefined)).toBeUndefined()
  })
})

describe('parseSubscriptionHeaders', () => {
  const headers: Record<string, string> = {
    'subscription-userinfo': 'upload=1; download=2; total=3; expire=4',
    'profile-title': b64('CipherWay · Премиум'),
    'support-url': 'https://t.me/example_support',
    'profile-web-page-url': 'https://panel.example.com/sub/abc',
    announce: b64('Плановые работы в субботу'),
    'profile-update-interval': '12'
  }
  const meta = parseSubscriptionHeaders((n) => headers[n] ?? null)

  it('collects every known header', () => {
    expect(meta).toEqual({
      userInfo: { upload: 1, download: 2, total: 3, expire: 4 },
      rawTitle: 'CipherWay · Премиум',
      supportUrl: 'https://t.me/example_support',
      webPageUrl: 'https://panel.example.com/sub/abc',
      announce: 'Плановые работы в субботу',
      updateIntervalHours: 12
    })
  })

  it('missing headers stay undefined', () => {
    const empty = parseSubscriptionHeaders(() => null)
    expect(Object.values(empty).every((v) => v === undefined)).toBe(true)
  })

  it('caps very long announcements', () => {
    const long = parseSubscriptionHeaders((n) => (n === 'announce' ? 'x'.repeat(5000) : null))
    expect(long.announce).toHaveLength(600)
  })
})

describe('toSubscriptionView (what the renderer receives)', () => {
  const data: SubscriptionData = {
    url: '',
    fetchedAt: 1,
    outbounds: [
      {
        id: 'ob_1',
        name: 'Нидерланды',
        protocol: 'vless',
        server: 'nl.example.com',
        port: 443,
        uuid: '11111111-2222-4333-8444-555555555555',
        raw: 'vless://11111111-2222-4333-8444-555555555555@nl.example.com:443'
      }
    ],
    rawTitle: 'Title'
  }

  it('has no addresses, ports, credentials or the full link', () => {
    const v = toSubscriptionView(data, 'https://sub.example.com/api/sub/AbCdEfGh123456')!
    const text = JSON.stringify(v)
    expect(text).not.toContain('nl.example.com')
    expect(text).not.toContain('443')
    expect(text).not.toContain('11111111')
    expect(text).not.toContain('AbCdEfGh')
    expect(v.servers).toEqual([{ id: 'ob_1', name: 'Нидерланды', protocol: 'vless' }])
    expect(v.urlMasked).toBe('https://sub***')
  })

  it('null in, null out', () => {
    expect(toSubscriptionView(null, null)).toBeNull()
  })
})
