import { lookup } from 'node:dns/promises'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { performance } from 'node:perf_hooks'

// ---------------------------------------------------------------------------
// The server list's own latency test (0.5.2, Settings → «Пинг»), no Clash API:
//  * keepalivePing — like Happ's «via Proxy (GET), Keepalive»: through a node's
//    loopback SOCKS5 entry (xray's per-node inbound for VLESS, the per-node test
//    inbound of a throw-away sing-box for Hysteria2 / VMess) two HTTPS GETs of
//    the test page over ONE connection; the time of the SECOND one is the result
//    — the round trip through the tunnel without the TCP / TLS / REALITY
//    handshakes the first one pays for;
//  * tcpPing — TCP connect straight to the node's address (outside the VPN).
// Pure networking (node:net / node:tls), unit tested with local servers in
// latency.test.ts.
// ---------------------------------------------------------------------------

/** a node's loopback SOCKS5 entry; user/pass when the entry wants RFC 1929 auth */
export interface SocksTarget {
  port: number
  user?: string
  pass?: string
}

export class PingError extends Error {}

/** Resolves with exactly `n` bytes of a paused socket (what is left stays buffered). */
function readExact(sock: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tryRead = (): void => {
      const b = sock.read(n) as Buffer | null
      if (b) {
        cleanup()
        resolve(b)
      }
    }
    const onEnd = (): void => {
      cleanup()
      reject(new PingError('socks: connection closed'))
    }
    const onError = (e: Error): void => {
      cleanup()
      reject(e)
    }
    const cleanup = (): void => {
      sock.off('readable', tryRead)
      sock.off('end', onEnd)
      sock.off('close', onEnd)
      sock.off('error', onError)
    }
    sock.on('readable', tryRead)
    sock.once('end', onEnd)
    sock.once('close', onEnd)
    sock.once('error', onError)
    tryRead()
  })
}

/**
 * SOCKS5 CONNECT to host:port through 127.0.0.1:<target.port> (the host goes as
 * a name — the node resolves it). Resolves with the socket, ready for TLS.
 */
export async function socks5Connect(
  target: SocksTarget,
  host: string,
  port: number
): Promise<Socket> {
  const sock = netConnect({ host: '127.0.0.1', port: target.port })
  sock.setNoDelay(true)
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve())
      sock.once('error', reject)
    })
    sock.pause()
    const auth = target.user !== undefined
    sock.write(Buffer.from([0x05, 0x01, auth ? 0x02 : 0x00]))
    const [ver, method] = await readExact(sock, 2)
    if (ver !== 0x05 || method !== (auth ? 0x02 : 0x00)) {
      throw new PingError('socks: method refused')
    }
    if (auth) {
      const u = Buffer.from(target.user ?? '', 'utf8')
      const p = Buffer.from(target.pass ?? '', 'utf8')
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
      const [, status] = await readExact(sock, 2)
      if (status !== 0x00) throw new PingError('socks: auth failed')
    }
    const h = Buffer.from(host, 'utf8')
    sock.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]),
        h,
        Buffer.from([port >> 8, port & 0xff])
      ])
    )
    const head = await readExact(sock, 4)
    if (head[0] !== 0x05 || head[1] !== 0x00) throw new PingError(`socks: reply ${head[1]}`)
    const atyp = head[3]
    const rest =
      atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await readExact(sock, 1))[0] : -1
    if (rest < 0) throw new PingError('socks: bad reply')
    await readExact(sock, rest + 2)
    return sock
  } catch (err) {
    sock.destroy()
    throw err
  }
}

interface HttpResponse {
  status: number
  /** the server announced `Connection: close` */
  close: boolean
}

/**
 * Reads ONE HTTP/1.1 response (headers + body by Content-Length / chunked) from
 * a stream that keeps receiving data; leftover bytes stay in `buf` for the next.
 */
class ResponseReader {
  private buf = Buffer.alloc(0)
  private waiter: (() => void) | null = null
  private failed: Error | null = null

  constructor(stream: TLSSocket | Socket) {
    stream.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d])
      this.wake()
    })
    const fail = (e: Error): void => {
      this.failed ??= e
      this.wake()
    }
    stream.on('error', fail)
    stream.on('end', () => fail(new PingError('http: connection closed')))
    stream.on('close', () => fail(new PingError('http: connection closed')))
  }

  private wake(): void {
    const w = this.waiter
    this.waiter = null
    w?.()
  }

  private async more(): Promise<void> {
    if (this.failed) throw this.failed
    await new Promise<void>((r) => (this.waiter = r))
    if (this.failed) throw this.failed
  }

  async read(): Promise<HttpResponse> {
    let end: number
    while ((end = this.buf.indexOf('\r\n\r\n')) < 0) {
      if (this.buf.length > 64 * 1024) throw new PingError('http: headers too long')
      await this.more()
    }
    const head = this.buf.subarray(0, end).toString('latin1')
    this.buf = this.buf.subarray(end + 4)
    const [statusLine, ...lines] = head.split('\r\n')
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
    if (!m) throw new PingError('http: bad status line')
    const status = Number(m[1])
    const headers = new Map<string, string>()
    for (const l of lines) {
      const i = l.indexOf(':')
      if (i > 0) headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim())
    }
    const close = /\bclose\b/i.test(headers.get('connection') ?? '')
    if (status === 204 || status === 304 || (status >= 100 && status < 200)) {
      return { status, close }
    }
    if (/chunked/i.test(headers.get('transfer-encoding') ?? '')) {
      // the last chunk + the empty trailer
      let i: number
      while ((i = this.buf.indexOf('0\r\n\r\n')) < 0 || (i > 0 && this.buf[i - 1] !== 0x0a)) {
        if (this.buf.length > 1024 * 1024) throw new PingError('http: body too long')
        await this.more()
      }
      this.buf = this.buf.subarray(i + 5)
      return { status, close }
    }
    const len = Number(headers.get('content-length') ?? NaN)
    // no length: the body ends with the connection — nothing to keep alive
    if (!Number.isFinite(len) || len < 0) return { status, close: true }
    if (len > 1024 * 1024) throw new PingError('http: body too long')
    while (this.buf.length < len) await this.more()
    this.buf = this.buf.subarray(len)
    return { status, close }
  }
}

export interface KeepaliveResult {
  /** the first request, connection + handshakes included */
  firstMs: number
  /** the second request over the same connection — the result shown */
  secondMs: number
}

function requestText(u: URL): string {
  return (
    `GET ${u.pathname || '/'}${u.search} HTTP/1.1\r\n` +
    `Host: ${u.host}\r\n` +
    'User-Agent: CipherWay\r\n' +
    'Accept: */*\r\n' +
    'Connection: keep-alive\r\n\r\n'
  )
}

/**
 * Two GETs of `url` through the SOCKS5 entry over one connection (https: one
 * TLS session, certificate checked). Throws when either fails, when the server
 * closes the connection after the first, or after `timeoutMs` in total.
 */
export async function keepalivePing(
  target: SocksTarget,
  url: string,
  timeoutMs: number
): Promise<KeepaliveResult> {
  const u = new URL(url)
  const https = u.protocol === 'https:'
  const port = Number(u.port) || (https ? 443 : 80)
  let sock: Socket | null = null
  let tls: TLSSocket | null = null
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PingError('timeout')), timeoutMs)
  })
  const run = async (): Promise<KeepaliveResult> => {
    const t0 = performance.now()
    sock = await socks5Connect(target, u.hostname, port)
    let stream: Socket | TLSSocket = sock
    if (https) {
      const raw = sock
      tls = await new Promise<TLSSocket>((resolve, reject) => {
        const t = tlsConnect({
          socket: raw,
          servername: isIP(u.hostname) ? undefined : u.hostname,
          ALPNProtocols: ['http/1.1']
        })
        t.once('secureConnect', () => resolve(t))
        t.once('error', reject)
      })
      stream = tls
    }
    const reader = new ResponseReader(stream)
    const req = requestText(u)
    stream.write(req)
    const first = await reader.read()
    const firstMs = performance.now() - t0
    if (first.status >= 400) throw new PingError(`http: status ${first.status}`)
    if (first.close) throw new PingError('http: no keep-alive')
    const t1 = performance.now()
    stream.write(req)
    const second = await reader.read()
    const secondMs = performance.now() - t1
    if (second.status >= 400) throw new PingError(`http: status ${second.status}`)
    return { firstMs: Math.round(firstMs), secondMs: Math.max(1, Math.round(secondMs)) }
  }
  try {
    return await Promise.race([run(), timeout])
  } finally {
    clearTimeout(timer)
    ;(tls as TLSSocket | null)?.destroy()
    ;(sock as Socket | null)?.destroy()
  }
}

/** The second request's time, or null — what the list shows («нет ответа»). */
export async function keepaliveMs(
  target: SocksTarget | undefined,
  url: string,
  timeoutMs: number
): Promise<number | null> {
  if (!target) return null
  try {
    return (await keepalivePing(target, url, timeoutMs)).secondMs
  } catch {
    return null
  }
}

export type HostLookup = (host: string) => Promise<string>

const systemLookup: HostLookup = async (host) => (await lookup(host, { family: 0 })).address

/**
 * TCP connect time to host:port, straight (no proxy); the name is resolved
 * first and not counted. null = refused / no answer within `timeoutMs`.
 */
export async function tcpPing(
  host: string,
  port: number,
  timeoutMs: number,
  resolve: HostLookup = systemLookup
): Promise<number | null> {
  const h = host.trim().replace(/^\[|\]$/g, '')
  const deadline = Date.now() + timeoutMs
  let addr: string
  try {
    addr = isIP(h) ? h : await withDeadline(resolve(h), timeoutMs)
  } catch {
    return null
  }
  const left = deadline - Date.now()
  if (left <= 0) return null
  return new Promise((done) => {
    const t0 = performance.now()
    const sock = netConnect({ host: addr, port })
    const finish = (v: number | null): void => {
      clearTimeout(timer)
      sock.destroy()
      done(v)
    }
    const timer = setTimeout(() => finish(null), left)
    sock.once('connect', () => finish(Math.max(1, Math.round(performance.now() - t0))))
    sock.once('error', () => finish(null))
  })
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new PingError('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}
