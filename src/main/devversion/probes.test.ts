import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compareDns,
  isBogon,
  parseDefaultRoutes,
  parseDohJson,
  pickPhysicalSource,
  probeTarget,
  tcpCheck
} from './probes'

// `route print -4 0.0.0.0` of a Russian Windows with our TUN up
const ROUTE_PRINT = `===========================================================================
Список интерфейсов
 12...00 15 5d 01 02 03 ......Intel(R) Ethernet
 45...........................CipherWay
===========================================================================

IPv4 таблица маршрута
===========================================================================
Активные маршруты:
Сетевой адрес           Маска сети      Адрес шлюза       Интерфейс  Метрика
          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.50     25
          0.0.0.0          0.0.0.0         On-link       172.19.0.1      0
          0.0.0.0          0.0.0.0         10.8.0.1        10.8.0.6     50
===========================================================================
Постоянные маршруты:
  Отсутствует
`

describe('DevVersion probes: the physical adapter (TUN)', () => {
  it('reads the default routes language-independently, skips ours, takes the best metric', () => {
    const routes = parseDefaultRoutes(ROUTE_PRINT)
    expect(routes).toEqual([
      { gateway: '192.168.1.1', iface: '192.168.1.50', metric: 25 },
      { gateway: 'On-link', iface: '172.19.0.1', metric: 0 },
      { gateway: '10.8.0.1', iface: '10.8.0.6', metric: 50 }
    ])
    expect(pickPhysicalSource(routes, ['172.19.0.1'])).toBe('192.168.1.50')
    expect(pickPhysicalSource([], [])).toBeNull()
  })
})

describe('DevVersion probes: DNS comparison', () => {
  it('parses DoH JSON A records only', () => {
    expect(
      parseDohJson({
        Answer: [
          { type: 5, data: 'cname.example.' },
          { type: 1, data: '142.250.1.1' },
          { type: 1, data: 'junk' }
        ]
      })
    ).toEqual(['142.250.1.1'])
    expect(parseDohJson({})).toEqual([])
  })

  it('a disjoint answer is a mismatch; a private / null address is a bogon', () => {
    expect(compareDns(['1.1.1.1'], ['1.1.1.1', '1.0.0.1'])).toEqual({
      mismatch: false,
      bogon: false
    })
    expect(compareDns(['5.5.5.5'], ['1.1.1.1'])).toEqual({ mismatch: true, bogon: false })
    expect(compareDns(['0.0.0.0'], ['1.1.1.1']).bogon).toBe(true)
    expect(compareDns([], ['1.1.1.1']).mismatch).toBe(false)
    expect(isBogon('10.1.2.3')).toBe(true)
    expect(isBogon('8.8.8.8')).toBe(false)
  })
})

// local stand-ins: an HTTP-ish TCP server and a SOCKS5 server (= xray's per-server inbound)
const port = (s: Server): number => (s.address() as AddressInfo).port
const listen = (s: Server): Promise<void> => new Promise((r) => s.listen(0, '127.0.0.1', () => r()))
const sockets = new Set<Socket>()
const track = (s: Server): Server => s.on('connection', (c: Socket) => sockets.add(c))
const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()))

function socksServer(): Server & { seen: string[] } {
  const seen: string[] = []
  const srv = createServer((c: Socket) => {
    let buf = Buffer.alloc(0)
    let stage = 0
    c.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (stage === 0 && buf.length >= 2 + buf[1]) {
        buf = buf.subarray(2 + buf[1])
        c.write(Buffer.from([0x05, 0x00]))
        stage = 2
      }
      if (stage === 2 && buf.length >= 5 && buf[3] === 0x03 && buf.length >= 7 + buf[4]) {
        const host = buf.subarray(5, 5 + buf[4]).toString()
        const p = buf.readUInt16BE(5 + buf[4])
        seen.push(`${host}:${p}`)
        stage = 3
        c.removeAllListeners('data')
        const up = connect({ host: '127.0.0.1', port: p }, () => {
          c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
          c.pipe(up).pipe(c)
        })
        up.on('error', () => c.destroy())
      }
    })
    c.on('error', () => undefined)
  })
  return Object.assign(srv, { seen })
}

describe('DevVersion probes: TCP directly and through a SOCKS5 entry', () => {
  let target: Server
  let socks: Server & { seen: string[] }
  let freePort = 0

  beforeAll(async () => {
    target = track(createServer((c) => c.on('error', () => undefined)))
    socks = socksServer()
    track(socks)
    await listen(target)
    await listen(socks)
    const tmp = createServer()
    await listen(tmp)
    freePort = port(tmp)
    await close(tmp)
  })
  afterAll(async () => {
    for (const c of sockets) c.destroy()
    await close(target)
    await close(socks)
  })

  it('direct (plain): TCP time; a closed port is an error, not a time', async () => {
    const ok = await probeTarget({ path: 'direct', method: 'plain' }, '127.0.0.1', port(target))
    expect(ok.tcp_ms).toBeGreaterThan(0)
    expect(ok.error).toBeUndefined()
    const bad = await tcpCheck({ path: 'direct', method: 'plain' }, '127.0.0.1', freePort, 2000)
    expect(bad).toMatchObject({ ok: false, ms: null, error: 'ECONNREFUSED' })
  })

  it('direct bound to a source address (what TUN mode does)', async () => {
    const r = await tcpCheck(
      { path: 'direct', method: 'src_bind', localAddress: '127.0.0.1' },
      '127.0.0.1',
      port(target)
    )
    expect(r.ok).toBe(true)
  })

  it('vpn: through the server entry, the name goes to the server unresolved', async () => {
    const r = await tcpCheck(
      { path: 'vpn', method: 'socks:xray', socks: { port: port(socks) }, node: 'NL' },
      'game.example.com',
      port(target)
    )
    expect(r.ok).toBe(true)
    expect(socks.seen).toContain(`game.example.com:${port(target)}`)
    const none = await tcpCheck({ path: 'vpn', method: '-' }, 'x', 1)
    expect(none).toMatchObject({ ok: false, error: 'no_socks_entry' })
  })

  it('TLS against a non-TLS server: a TLS error, the TCP time still counts; never throws', async () => {
    const r = await probeTarget({ path: 'direct', method: 'plain' }, '127.0.0.1', port(target), {
      tls: true,
      http: true,
      timeoutMs: 1500
    })
    expect(r.tcp_ms).toBeGreaterThan(0)
    expect(r.tls_ms ?? null).toBeNull()
    expect(r.tls_error ?? r.error).toBeTruthy()
  })
})
