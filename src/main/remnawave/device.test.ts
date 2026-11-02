import { describe, expect, it } from 'vitest'
import {
  buildSubscriptionHeaders,
  hashHwid,
  normalizeModel,
  parseMachineGuid,
  sanitizeHeaderValue
} from './device'

// made-up GUID, not from a real machine
const GUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
// Remnawave ≥3.0.0 ignores x-hwid that doesn't match this
const REMNAWAVE_HWID_RE = /^[a-zA-Z0-9=-]{10,64}$/

describe('hashHwid', () => {
  it('is a stable 32-hex salted hash that never contains the MachineGuid', () => {
    const h = hashHwid(GUID)
    expect(h).toMatch(/^[0-9a-f]{32}$/)
    expect(h).toMatch(REMNAWAVE_HWID_RE)
    expect(hashHwid(GUID)).toBe(h)
    expect(hashHwid(GUID.toUpperCase())).toBe(h) // case/whitespace-insensitive
    expect(hashHwid(` ${GUID}\n`)).toBe(h)
    expect(h).not.toContain(GUID.replace(/-/g, '').slice(0, 8))
  })
  it('depends on the salt and on the machine', () => {
    expect(hashHwid(GUID, 'other-salt')).not.toBe(hashHwid(GUID))
    expect(hashHwid('00000000-0000-0000-0000-000000000000')).not.toBe(hashHwid(GUID))
  })
})

describe('buildSubscriptionHeaders', () => {
  const headers = buildSubscriptionHeaders(
    { hwid: hashHwid(GUID), osVersion: '10.0.19045', model: 'LENOVO 20XW' },
    '0.3.0'
  )

  it('sends the Remnawave HWID header set', () => {
    expect(headers).toEqual({
      'User-Agent': 'CipherWay/0.3.0 (Windows)',
      Accept: '*/*',
      'x-hwid': hashHwid(GUID),
      'x-device-os': 'Windows',
      'x-ver-os': '10.0.19045',
      'x-device-model': 'LENOVO 20XW'
    })
  })

  it('UA does not trigger the panel clash/mihomo YAML rules', () => {
    expect(headers['User-Agent']).not.toMatch(/^(flclash|mihomo|koala-clash|clash)/i)
  })

  it('falls back to safe values', () => {
    const h = buildSubscriptionHeaders({ hwid: 'abcdefabcdef', osVersion: '', model: '' }, '1.0.0')
    expect(h['x-device-model']).toBe('PC')
    expect(h['x-ver-os']).toBe('unknown')
  })
})

describe('device model / helpers', () => {
  it('normalizes WMI manufacturer + model', () => {
    expect(normalizeModel('LENOVO', '20XW004LRT')).toBe('LENOVO 20XW004LRT')
    expect(normalizeModel('Lenovo', 'Lenovo ThinkPad X1')).toBe('Lenovo ThinkPad X1')
    expect(normalizeModel('System manufacturer', 'System Product Name')).toBe('PC')
    expect(normalizeModel('To be filled by O.E.M.', 'To be filled by O.E.M.')).toBe('PC')
    expect(normalizeModel('', '')).toBe('PC')
  })
  it('keeps header values printable ASCII and short', () => {
    expect(sanitizeHeaderValue('Ноутбук\tASUS  ROG')).toBe('ASUS ROG')
    expect(sanitizeHeaderValue('x'.repeat(100))).toHaveLength(64)
  })
  it('parses `reg query` output', () => {
    const out =
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n' +
      `    MachineGuid    REG_SZ    ${GUID}\r\n\r\n`
    expect(parseMachineGuid(out)).toBe(GUID)
    expect(parseMachineGuid('ERROR: The system was unable to find the key')).toBeNull()
  })
})
