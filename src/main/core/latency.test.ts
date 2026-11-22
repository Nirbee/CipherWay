import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { keepaliveMs, keepalivePing, socks5Connect, tcpPing } from './latency'

// Local stand-ins only: a SOCKS5 server (what xray's per-node inbound / sing-box's
// test inbound are) and an HTTP server (what gstatic.com/generate_204 is).

const port = (s: Server | HttpServer): number => (s.address() as AddressInfo).port
const listen = (s: Server | HttpServer): Promise<void> =>
  new Promise((r) => s.listen(0, '127.0.0.1', () => r()))
const close = (s: Server | HttpServer): Promise<void> => new Promise((r) => s.close(() => r()))

/** Minimal SOCKS5 server: CONNECT to a domain name; every name means 127.0.0.1. */
function socksServer(auth?: { user: string; pass: string }): Server & { seen: string[] } {
  const seen: string[] = []
  const srv = createServer((c: Socket) => {
    let buf = Buffer.alloc(0)
    let stage = 0
    c.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])]
        buf = buf.subarray(2 + buf[1])
        const want = auth ? 0x02 : 0x00
        if (!methods.includes(want)) return void c.end(Buffer.from([0x05, 0xff]))
        c.write(Buffer.from([0x05, want]))
        stage = auth ? 1 : 2
      }
      if (stage === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] + (buf[2 + buf[1]] ?? 0)) {
        const ul = buf[1]
        const user = buf.subarray(2, 2 + ul).toString()
        const pl = buf[2 + ul]
        const pass = buf.subarray(3 + ul, 3 + ul + pl).toString()
        buf = buf.subarray(3 + ul + pl)
        const ok = user === auth?.user && pass === auth?.pass
        c.write(Buffer.from([0x01, ok ? 0x00 : 0x01]))
        if (!ok) return void c.end()
        stage = 2
      }
      if (stage === 2 && buf.length >= 5 && buf[3] === 0x03 && buf.length >= 7 + buf[4]) {
        const host = buf.subarray(5, 5 + buf[4]).toString()
        const p = buf.readUInt16BE(5 + buf[4])
        buf = buf.subarray(7 + buf[4])
        seen.push(`${host}:${p}`)
        stage = 3
        const up = connect({ host: '127.0.0.1', port: p }, () => {
          c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
          if (buf.length) up.write(buf)
          c.pipe(up).pipe(c)
        })
        up.on('error', () => c.destroy())
        c.removeAllListeners('data')
      }
    })
    c.on('error', () => undefined)
  })
  return Object.assign(srv, { seen })
}

describe('latency: keepalive ping through a SOCKS5 entry (0.5.2)', () => {
  let http: HttpServer
  let socks: Server & { seen: string[] }
  let socksAuth: Server & { seen: string[] }
  let requests = 0
  let connections = 0

  beforeAll(async () => {
    http = createHttpServer((req, res) => {
      requests++
      if (req.url === '/close') {
        res.writeHead(204, { Connection: 'close' })
        return void res.end()
      }
      if (req.url === '/hang') return // never answers
      // the first request on a connection is slow (a «handshake»), the rest quick
      const first = (req.socket as Socket & { n?: number }).n === undefined
      ;(req.socket as Socket & { n?: number }).n = 1
      setTimeout(
        () => {
          res.writeHead(req.url === '/len' ? 200 : 204, {
            'Content-Length': req.url === '/len' ? '5' : '0'
          })
          res.end(req.url === '/len' ? 'hello' : undefined)
        },
        first ? 150 : 0
      )
    })
    http.on('connection', () => connections++)
    socks = socksServer()
    socksAuth = socksServer({ user: 'cw', pass: 'p4ss' })
    await Promise.all([listen(http), listen(socks), listen(socksAuth)])
  })

  afterAll(async () => {
    http.closeAllConnections()
    await Promise.all([close(http), close(socks), close(socksAuth)])
  })

  it('two requests over ONE connection; the second (no handshake) is the result', async () => {
    const before = { requests, connections }
    const r = await keepalivePing(
      { port: port(socks) },
      `http://www.gstatic.test:${port(http)}/generate_204`,
      5000
    )
    expect(requests - before.requests).toBe(2)
    expect(connections - before.connections).toBe(1)
    expect(r.firstMs).toBeGreaterThanOrEqual(140)
    expect(r.secondMs).toBeLessThan(r.firstMs)
    expect(r.secondMs).toBeGreaterThan(0)
    // the name goes to the node as a name — it resolves it, not us
    expect(socks.seen.at(-1)).toBe(`www.gstatic.test:${port(http)}`)
  })

  it('a body with Content-Length is read before the second request', async () => {
    const r = await keepalivePing({ port: port(socks) }, `http://h.test:${port(http)}/len`, 5000)
    expect(r.secondMs).toBeGreaterThan(0)
  })

  it('SOCKS5 user/password (the sing-box test inbounds have one)', async () => {
    const ok = await keepaliveMs(
      { port: port(socksAuth), user: 'cw', pass: 'p4ss' },
      `http://h.test:${port(http)}/generate_204`,
      5000
    )
    expect(typeof ok).toBe('number')
    const bad = await keepaliveMs(
      { port: port(socksAuth), user: 'cw', pass: 'wrong' },
      `http://h.test:${port(http)}/generate_204`,
      5000
    )
    expect(bad).toBeNull()
  })

  it('«нет ответа»: no entry, a closed port, no keep-alive, a silent server (timeout)', async () => {
    const url = `http://h.test:${port(http)}/generate_204`
    expect(await keepaliveMs(undefined, url, 1000)).toBeNull()
    const closed = createServer()
    await listen(closed)
    const dead = port(closed)
    await close(closed)
    expect(await keepaliveMs({ port: dead }, url, 1000)).toBeNull()
    expect(
      await keepaliveMs({ port: port(socks) }, `http://h.test:${port(http)}/close`, 2000)
    ).toBeNull()
    const t0 = Date.now()
    expect(
      await keepaliveMs({ port: port(socks) }, `http://h.test:${port(http)}/hang`, 600)
    ).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('socks5Connect refuses a server that wants a password we do not have', async () => {
    await expect(socks5Connect({ port: port(socksAuth) }, 'h.test', 80)).rejects.toThrow()
  })
})

describe('latency: TCP ping straight to the server', () => {
  it('connect time of an open port; null for a closed one; the name lookup is not counted', async () => {
    const srv = createServer((c) => c.destroy())
    await listen(srv)
    try {
      const ms = await tcpPing('127.0.0.1', port(srv), 2000)
      expect(typeof ms).toBe('number')
      let looked = ''
      const viaName = await tcpPing('node.example', port(srv), 2000, async (h) => {
        looked = h
        await new Promise((r) => setTimeout(r, 300))
        return '127.0.0.1'
      })
      expect(looked).toBe('node.example')
      expect(viaName).not.toBeNull()
      expect(viaName as number).toBeLessThan(250)
    } finally {
      await close(srv)
    }
    const closed = createServer()
    await listen(closed)
    const dead = port(closed)
    await close(closed)
    expect(await tcpPing('127.0.0.1', dead, 1000)).toBeNull()
    expect(
      await tcpPing('nowhere.example', 80, 1000, async () => {
        throw new Error('ENOTFOUND')
      })
    ).toBeNull()
  })
})
