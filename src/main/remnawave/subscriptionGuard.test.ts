import { describe, expect, it } from 'vitest'
import { parseOutbounds } from './parsers'
import {
  filterSubscription,
  httpStatusError,
  hwidHeaderError,
  isPlaceholderOutbound,
  MSG_DEVICE_LIMIT,
  MSG_HWID_NOT_SUPPORTED,
  MSG_NOT_FOUND,
  MSG_STUB_PREFIX
} from './subscriptionGuard'

const UUID = '00000000-0000-4000-8000-000000000000'
const stub = (name: string, host = '0.0.0.0', port = 1): string =>
  `vless://${UUID}@${host}:${port}?security=none&type=tcp#${encodeURIComponent(name)}`
const REAL =
  'vless://11111111-2222-4333-8444-555555555555@nl.example.com:443' +
  '?security=reality&pbk=KEY&sid=ab&sni=www.example.org&fp=firefox#NL'
const b64 = (lines: string[]): string => Buffer.from(lines.join('\n')).toString('base64')

const headers =
  (h: Record<string, string>) =>
  (name: string): string | null =>
    h[name] ?? null

describe('hwidHeaderError (Remnawave response headers)', () => {
  it('device limit', () => {
    expect(hwidHeaderError(headers({ 'x-hwid-max-devices-reached': 'true' }))).toBe(
      MSG_DEVICE_LIMIT
    )
    expect(hwidHeaderError(headers({ 'x-hwid-limit': 'true' }))).toBe(MSG_DEVICE_LIMIT)
  })
  it('hwid not supported', () => {
    expect(hwidHeaderError(headers({ 'x-hwid-not-supported': 'true' }))).toBe(
      MSG_HWID_NOT_SUPPORTED
    )
  })
  it('normal answer', () => {
    expect(hwidHeaderError(headers({ 'x-hwid-active': 'true' }))).toBeNull()
    expect(hwidHeaderError(headers({ 'x-hwid-max-devices-reached': 'false' }))).toBeNull()
  })
})

describe('placeholder ("stub") servers', () => {
  it('detects 0.0.0.0:1 style entries', () => {
    const [s] = parseOutbounds(stub('App not supported'))
    expect(isPlaceholderOutbound(s)).toBe(true)
    const [r] = parseOutbounds(REAL)
    expect(isPlaceholderOutbound(r)).toBe(false)
  })

  it('device-limit stub -> readable Russian error, no servers', () => {
    const res = filterSubscription(parseOutbounds(b64([stub('Вы достигли лимита устройств!')])))
    expect(res.outbounds).toEqual([])
    expect(res.error).toBe(MSG_DEVICE_LIMIT)
  })

  it('"App not supported" stub', () => {
    const res = filterSubscription(parseOutbounds(b64([stub('⚠️ App not supported')])))
    expect(res.error).toBe(MSG_HWID_NOT_SUPPORTED)
  })

  it('unknown stub keeps its text for the user', () => {
    const res = filterSubscription(parseOutbounds(b64([stub('Подписка истекла', '127.0.0.1')])))
    expect(res.error).toContain(MSG_STUB_PREFIX)
    expect(res.error).toContain('Подписка истекла')
  })

  it('drops stubs mixed with real servers', () => {
    const res = filterSubscription(parseOutbounds(b64([stub('info'), REAL])))
    expect(res.error).toBeUndefined()
    expect(res.outbounds.map((o) => o.name)).toEqual(['NL'])
  })

  it('empty body', () => {
    expect(filterSubscription([]).error).toMatch(/не найдено/)
  })
})

describe('httpStatusError', () => {
  it('maps 404 to a hint about the link', () => {
    expect(httpStatusError(404, 'Not Found')).toBe(MSG_NOT_FOUND)
    expect(httpStatusError(502, 'Bad Gateway')).toBe('Подписка недоступна: 502 Bad Gateway')
  })
})
