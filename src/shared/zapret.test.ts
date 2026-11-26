import { describe, expect, it } from 'vitest'
import {
  addZapretDomain,
  normalizeZapretDomain,
  PUBLIC_SUFFIXES,
  userRuleFor,
  zapretRoute,
  ZAPRET_ROUTE_TEXT,
  sanitizeZapretSettings,
  zapretStateText,
  ZAPRET_CUSTOM_MAX
} from './zapret'

const ok = (raw: string, reserved: string[] = []): string => {
  const r = normalizeZapretDomain(raw, reserved)
  if (!r.ok) throw new Error(`${raw}: ${r.error}`)
  return r.domain
}
const bad = (raw: string, reserved: string[] = []): string => {
  const r = normalizeZapretDomain(raw, reserved)
  if (r.ok) throw new Error(`${raw} accepted as ${r.domain}`)
  return r.error
}

describe('normalizeZapretDomain', () => {
  it('cleans what people paste: scheme, path, port, *., case, trailing dot', () => {
    expect(ok('Example.COM')).toBe('example.com')
    expect(ok('https://www.example.com/watch?v=1')).toBe('www.example.com')
    expect(ok('example.com:443')).toBe('example.com')
    expect(ok('*.example.com')).toBe('example.com')
    expect(ok('  example.com.  ')).toBe('example.com')
    expect(ok('sub-1.a.example.co.uk')).toBe('sub-1.a.example.co.uk')
  })

  it('IDN → punycode (the form zapret and sing-box compare)', () => {
    expect(ok('пример.рф')).toBe('xn--e1afmkfd.xn--p1ai')
    expect(ok('xn--e1afmkfd.xn--p1ai')).toBe('xn--e1afmkfd.xn--p1ai')
  })

  it('no IP addresses', () => {
    expect(bad('1.2.3.4')).toMatch(/IP/)
    expect(bad('http://1.2.3.4/')).toMatch(/IP/)
    expect(bad('2001:db8::1')).toMatch(/IP/)
    expect(bad('[2001:db8::1]:443')).toMatch(/IP/)
  })

  it('no local names', () => {
    for (const d of [
      'localhost',
      'a.localhost',
      'nas.local',
      'router.lan',
      'x.home.arpa',
      'a.internal'
    ]) {
      expect(bad(d)).toBeTruthy()
    }
  })

  it('not our own domains, nor the reserved ones (with subdomains)', () => {
    expect(bad('cipherway.ru')).toMatch(/нужен самому VPN/)
    expect(bad('lan.cipherway.ru')).toMatch(/нужен самому VPN/)
    expect(bad('cabinet.cipherway.net.ru')).toMatch(/нужен самому VPN/)
    expect(bad('sub.example.net', ['example.net'])).toMatch(/нужен самому VPN/)
    expect(bad('node1.vpn.example', ['NODE1.vpn.example'])).toBeTruthy()
    expect(ok('notcipherway.ru')).toBe('notcipherway.ru')
  })

  it('garbage is refused', () => {
    for (const d of [
      '',
      'com',
      'exa mple.com',
      'a_b.com',
      '-a.com',
      'a-.com',
      'a..com',
      'user@example.com',
      'example.123',
      `${'a'.repeat(64)}.com`,
      `${'a.'.repeat(130)}com`
    ]) {
      expect(normalizeZapretDomain(d).ok).toBe(false)
    }
  })

  it('nothing that could break a hostlist line or a command line gets through', () => {
    for (const d of [
      'a.com\nb.com',
      'a.com" --x',
      'a.com;b',
      'a.com%TLS%',
      '$(x).com',
      'a.com\\b'
    ]) {
      const r = normalizeZapretDomain(d)
      if (r.ok) expect(r.domain).toMatch(/^[a-z0-9.-]+$/)
    }
  })
})

describe('public suffixes', () => {
  it('a zone of many owners is refused, a site in it is fine', () => {
    for (const d of ['com.ru', 'msk.ru', 'pp.ua', 'co.uk', 'github.io', 'https://com.ru/']) {
      expect(bad(d)).toMatch(/общая зона/)
    }
    expect(ok('example.com.ru')).toBe('example.com.ru')
    expect(ok('user.github.io')).toBe('user.github.io')
    // single label: never
    expect(bad('ru')).toBeTruthy()
  })

  it('every listed suffix is itself a normalized name (the broker compares byte for byte)', () => {
    for (const s of PUBLIC_SUFFIXES) expect(s).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/)
  })
})

describe('addZapretDomain', () => {
  it('normalized, no duplicates, the limit kept', () => {
    const r = addZapretDomain([], 'https://Example.com/')
    expect(r).toEqual({ ok: true, list: ['example.com'] })
    expect(addZapretDomain(['example.com'], 'EXAMPLE.com')).toEqual({
      ok: false,
      error: 'Этот домен уже в списке'
    })
    const full = Array.from({ length: ZAPRET_CUSTOM_MAX }, (_, i) => `d${i}.example`)
    const over = addZapretDomain(full, 'one-more.com')
    expect(over.ok).toBe(false)
  })
})

describe('sanitizeZapretSettings', () => {
  it('off by default with both services; junk from the store is dropped', () => {
    expect(sanitizeZapretSettings(undefined)).toEqual({
      enabled: false,
      services: ['youtube', 'discord'],
      custom: [],
      warned: false
    })
    expect(
      sanitizeZapretSettings({
        enabled: true,
        services: ['discord', 'evil' as never],
        custom: ['A.com', 'a.com', '1.2.3.4', 'localhost'],
        warned: true
      })
    ).toEqual({ enabled: true, services: ['discord'], custom: ['a.com'], warned: true })
    const many = Array.from({ length: ZAPRET_CUSTOM_MAX + 50 }, (_, i) => `d${i}.example.com`)
    expect(sanitizeZapretSettings({ custom: many }).custom).toHaveLength(ZAPRET_CUSTOM_MAX)
  })

  it('state texts', () => {
    expect(zapretStateText({ state: 'direct' })).toBe('напрямую ✓')
    expect(zapretStateText({ state: 'vpn' })).toBe('через VPN — напрямую не открылся')
    expect(zapretStateText({ state: 'checking' })).toBe('проверяется')
  })
})

describe('«Правила»: how each item goes now (0.7.1)', () => {
  const rule = (conditionType: string, value: string, action: string, enabled = true) => ({
    conditionType,
    value,
    action,
    enabled
  })

  it('the first enabled user rule that catches the service wins', () => {
    expect(userRuleFor('youtube', [rule('DomainSuffix', 'googlevideo.com', 'PROXY')])).toBe('PROXY')
    expect(userRuleFor('youtube', [rule('GeoSite', 'youtube', 'DIRECT')])).toBe('DIRECT')
    expect(userRuleFor('youtube', [rule('DomainKeyword', 'youtube', 'Нидерланды')])).toBe(
      'Нидерланды'
    )
    expect(userRuleFor('youtube', [rule('Domain', 'youtube.com', 'PROXY', false)])).toBeNull()
    expect(userRuleFor('discord', [rule('ProcessName', 'Discord.exe', 'PROXY')])).toBeNull()
    expect(userRuleFor('d:example.org', [rule('DomainSuffix', 'example.org', 'REJECT')])).toBe(
      'REJECT'
    )
    expect(userRuleFor('d:example.org', [rule('DomainRegex', '([', 'PROXY')])).toBeNull()
  })

  it('the labels', () => {
    const it = (state: 'direct' | 'vpn' | 'checking' | 'idle') => ({ key: 'youtube', state })
    expect(ZAPRET_ROUTE_TEXT[zapretRoute(it('direct'), 'running', [])]).toBe('Напрямую + zapret ✓')
    expect(ZAPRET_ROUTE_TEXT[zapretRoute(it('vpn'), 'running', [])]).toBe(
      'Через VPN — напрямую не открылся'
    )
    expect(ZAPRET_ROUTE_TEXT[zapretRoute(it('idle'), 'off', [])]).toBe(
      'Через VPN — zapret выключен'
    )
    expect(
      ZAPRET_ROUTE_TEXT[zapretRoute(it('direct'), 'running', [rule('GeoSite', 'google', 'PROXY')])]
    ).toBe('Ваше правило важнее: VPN')
    expect(zapretRoute(it('checking'), 'starting', [])).toBe('checking')
    expect(zapretRoute(it('idle'), 'idle', [])).toBe('waiting')
  })
})
