import { describe, expect, it } from 'vitest'
import {
  hasInterfaceIpv6,
  ipv6Status,
  isIpv6TunError,
  parseDisabledComponents,
  shouldRetryIpv4Only
} from './ipv6'

/** what a user with IPv6 switched off got from 0.4.5 */
const REAL_ERROR =
  'start service: start inbound/tun[tun-in]: configure tun interface: set ipv6 address: Element not found.'

const lo = { family: 'IPv4', internal: true }
const lo6 = { family: 'IPv6', internal: true }
const v4 = { family: 'IPv4', internal: false }
const ll6 = { family: 'IPv6', internal: false }

const dualStack = { Loopback: [lo, lo6], Ethernet: [ll6, v4] }
const noV6 = { Loopback: [lo, lo6], Ethernet: [v4] }

describe('IPv6 in Windows (0.4.6)', () => {
  it('reads DisabledComponents from `reg query`', () => {
    const out =
      '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters\r\n' +
      '    DisabledComponents    REG_DWORD    0xff\r\n\r\n'
    expect(parseDisabledComponents(out)).toBe(0xff)
    expect(parseDisabledComponents('    DisabledComponents    REG_DWORD    0x20')).toBe(0x20)
    // value not set: reg prints an error (localized) and exits with 1
    expect(parseDisabledComponents('')).toBeNull()
    expect(parseDisabledComponents('ОШИБКА: не удается найти указанный раздел')).toBeNull()
  })

  it('IPv6 off in the registry: 0xFF and every value with 0x10 (all non-tunnel interfaces)', () => {
    for (const v of [0xff, 0x10, 0x11, 0x30, 0xffffffff]) {
      const st = ipv6Status(v, dualStack)
      expect(st.available).toBe(false)
      expect(st.reason).toMatch(/^DisabledComponents=0x/)
    }
    expect(ipv6Status(0xff, dualStack).reason).toBe('DisabledComponents=0xFF')
  })

  it('0x01 (Teredo/6to4/ISATAP only) and 0x20 (prefer IPv4) leave IPv6 on wintun', () => {
    expect(ipv6Status(0x01, dualStack)).toEqual({ available: true })
    expect(ipv6Status(0x20, dualStack)).toEqual({ available: true })
    expect(ipv6Status(0, dualStack)).toEqual({ available: true })
    expect(ipv6Status(null, dualStack)).toEqual({ available: true })
  })

  it('no IPv6 address (not even fe80::) on any adapter but loopback → off', () => {
    expect(hasInterfaceIpv6(noV6)).toBe(false)
    expect(hasInterfaceIpv6(dualStack)).toBe(true)
    // Node 18.0–18.3: family as a number
    expect(hasInterfaceIpv6({ Ethernet: [{ family: 6, internal: false }] })).toBe(true)
    expect(ipv6Status(null, noV6)).toEqual({
      available: false,
      reason: 'ни у одного адаптера нет IPv6'
    })
  })

  it('no network at all says nothing: IPv6 is assumed on', () => {
    expect(ipv6Status(null, { Loopback: [lo, lo6] })).toEqual({ available: true })
    expect(ipv6Status(null, {})).toEqual({ available: true })
  })

  it('recognises the TUN IPv6 failure of sing-box, and only it', () => {
    expect(isIpv6TunError(REAL_ERROR)).toBe(true)
    expect(isIpv6TunError(`+0300 2026-11-20 12:00:00 FATAL[0000] ${REAL_ERROR}`)).toBe(true)
    expect(
      isIpv6TunError('start inbound/tun[tun-in]: configure tun interface: set ipv6 options: x')
    ).toBe(true)
    expect(
      isIpv6TunError('start inbound/tun[tun-in]: configure tun interface: set ipv6 dns: x')
    ).toBe(true)
    // not IPv6 / not the TUN
    expect(
      isIpv6TunError('start inbound/tun[tun-in]: configure tun interface: set ipv4 address: x')
    ).toBe(false)
    expect(isIpv6TunError('WARN inbound/tun[tun-in]: open interface take too much time')).toBe(
      false
    )
    expect(isIpv6TunError('ERROR outbound/direct: dial tcp [2001:db8::1]:443: no route')).toBe(
      false
    )
    expect(isIpv6TunError('')).toBe(false)
  })

  it('retry decision: the error → one IPv4-only restart of a TUN core that still had IPv6', () => {
    const out = ['WARN inbound/tun[tun-in]: open interface take too much time', REAL_ERROR]
    expect(shouldRetryIpv4Only(out, { tun: true, ipv4Only: false })).toBe(true)
    // already IPv4-only: no second time (the usual retry / error takes over)
    expect(shouldRetryIpv4Only(out, { tun: true, ipv4Only: true })).toBe(false)
    // no TUN — nothing to drop
    expect(shouldRetryIpv4Only(out, { tun: false, ipv4Only: false })).toBe(false)
    // another failure: no IPv4-only restart
    expect(
      shouldRetryIpv4Only(['start service: start inbound/tun[tun-in]: Access is denied.'], {
        tun: true,
        ipv4Only: false
      })
    ).toBe(false)
    expect(shouldRetryIpv4Only([], { tun: true, ipv4Only: false })).toBe(false)
  })
})
