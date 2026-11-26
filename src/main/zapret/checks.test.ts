import { createServer, type Server, type Socket } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { isServerAlert, mapLimit, networkId, parseArpMac, parseDohAnswer, probeTls } from './checks'
import { parseDefaultRoutes, pickPhysicalSource } from '../devversion/probes'

describe('network id', () => {
  it('PPPoE: an on-link default route is the network (our TUN skipped); its id survives a new address', () => {
    const print = (pub: string): string => `
IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0         On-link        172.19.0.1      0
          0.0.0.0          0.0.0.0         On-link     ${pub}     26
===========================================================================`
    const routes = parseDefaultRoutes(print('95.24.10.20'))
    expect(routes.map((r) => r.gateway)).toEqual(['On-link', 'On-link'])
    // our TUN (172.19.0.1) is never «the physical adapter»
    expect(pickPhysicalSource(routes, ['172.19.0.1'])).toBe('95.24.10.20')
    const a = networkId('On-link', null, '95.24.10.20')
    // reconnected: another address of the same provider's block
    expect(networkId('On-link', null, '95.24.200.7')).toBe(a)
    expect(networkId('On-link', null, '178.65.1.2')).not.toBe(a)
  })

  it('arp -a: the MAC of the gateway, whatever the language', () => {
    const ru = `
Интерфейс: 192.168.5.10 --- 0x11
  адрес в Интернете      Физический адрес      Тип
  192.168.5.1           a4-91-b1-0c-22-ef     динамический
  192.168.5.255         ff-ff-ff-ff-ff-ff     статический`
    expect(parseArpMac(ru, '192.168.5.1')).toBe('a4-91-b1-0c-22-ef')
    expect(parseArpMac(ru, '192.168.5.2')).toBeNull()
    expect(parseArpMac('No ARP Entries Found.', '10.0.0.1')).toBeNull()
  })

  it('the same router = the same id; hashed, no address in it', () => {
    const a = networkId('192.168.1.1', 'aa-bb-cc-dd-ee-ff', '192.168.1.5')
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(networkId('192.168.1.1', 'aa-bb-cc-dd-ee-ff', '192.168.1.77')).toBe(a)
    expect(networkId('192.168.1.1', '11-22-33-44-55-66', '192.168.1.5')).not.toBe(a)
    expect(networkId('192.168.1.1', null, '192.168.1.5')).not.toBe(a)
  })
})

describe('probeTls never hangs', () => {
  const sockets: Socket[] = []
  let server: Server
  const port = new Promise<number>((resolve) => {
    // accepts and says nothing: a DPI box that swallows the ClientHello
    server = createServer((s) => sockets.push(s)).listen(0, '127.0.0.1', () => {
      const a = server.address()
      resolve(typeof a === 'object' && a ? a.port : 0)
    })
  })
  afterAll(() => {
    for (const s of sockets) s.destroy()
    server.close()
  })

  it('a silent server (DPI swallowing the ClientHello) → «timeout» within the deadline', async () => {
    const t0 = Date.now()
    const r = await probeTls('127.0.0.1', { host: 'example.org', http: true }, {}, 800, await port)
    expect(r).toEqual({ host: 'example.org', ok: false, error: 'timeout' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('a closed port → an error at once, not a hang', async () => {
    const r = await probeTls('127.0.0.1', { host: 'example.org', http: false }, {}, 3000, 1)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^tls:|timeout/)
  })
})

describe('mapLimit', () => {
  it('keeps the order, never more than the limit at once', async () => {
    let now = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => {
      now++
      peak = Math.max(peak, now)
      await new Promise((r) => setTimeout(r, x * 5))
      now--
      return x * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30])
    expect(peak).toBe(2)
  })
})

describe('own domains (0.7.2): a TLS alert is an answer; «no address» is not a failure', () => {
  it('server alerts count, resets / timeouts do not', () => {
    expect(isServerAlert('ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR')).toBe(true)
    expect(isServerAlert('ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE')).toBe(true)
    expect(isServerAlert('ERR_SSL_TLSV1_UNRECOGNIZED_NAME')).toBe(true)
    expect(isServerAlert('ECONNRESET')).toBe(false)
    expect(isServerAlert('ETIMEDOUT')).toBe(false)
  })

  it('DoH: «answered, no address» apart from «no answer»', () => {
    expect(parseDohAnswer({ Status: 0, Answer: [{ type: 1, data: '203.0.113.5' }] }, 1)).toEqual({
      ips: ['203.0.113.5'],
      answered: true
    })
    expect(parseDohAnswer({ Status: 3 }, 1)).toEqual({ ips: [], answered: true })
    expect(parseDohAnswer({ Status: 0, Answer: [{ type: 28, data: '2001:db8::5' }] }, 28)).toEqual({
      ips: ['2001:db8::5'],
      answered: true
    })
    expect(parseDohAnswer(null, 1)).toEqual({ ips: [], answered: false })
    expect(parseDohAnswer({ error: 'x' }, 1)).toEqual({ ips: [], answered: false })
  })
})
