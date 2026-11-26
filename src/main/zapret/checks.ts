import { createHash } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls'
import { execLow, parseDefaultRoutes, parseDohJson, pickPhysicalSource } from '../devversion/probes'
import type { CheckTarget } from './lists'
import { probeQuic } from './quic'

// ---------------------------------------------------------------------------
// The direct checks of «Ускорение без VPN»: does a service open WITHOUT the
// VPN (through zapret)? Like utils\test zapret.ps1 of zapret-discord-youtube,
// lighter: per target a TLS handshake (SNI = the host, certificate checked)
// and, for the services, `HEAD /` with a status line — any HTTP answer counts.
//  * DNS: DoH straight to 8.8.8.8, 1.1.1.1 as the fallback — never the
//    provider's DNS (it may give a stub page's address);
//  * the way out: in TUN mode the socket is bound to the physical adapter's
//    address (devversion/probes.ts physicalSource — strong host model: it never
//    enters our TUN); with the system proxy a plain socket (Node never uses it).
//    So the packets pass the adapter winws watches, exactly like the browser's.
//  * every network operation has its own deadline, and a whole check has one
//    too (0.6.0 had probes without timeouts that could hang).
// ---------------------------------------------------------------------------

export interface DirectPath {
  /** TUN: the physical adapter's address to bind to */
  localAddress?: string
}

export type DohServer = 'primary' | 'fallback'

const DOH: Record<DohServer, { host: string; path: (name: string, type: string) => string }> = {
  // Google's JSON API answers on the IP too (the certificate has 8.8.8.8 in it)
  primary: {
    host: '8.8.8.8',
    path: (n, type) => `/resolve?name=${encodeURIComponent(n)}&type=${type}`
  },
  fallback: {
    host: '1.1.1.1',
    path: (n, type) => `/dns-query?name=${encodeURIComponent(n)}&type=${type}`
  }
}

/**
 * The DoH answer of a name: its addresses, and whether the server ANSWERED
 * (a JSON with a Status) — «no such address» vs «DNS did not answer».
 */
export interface DohAnswer {
  ips: string[]
  answered: boolean
}

/** parses a DoH JSON answer of `type` (1 = A, 28 = AAAA) */
export function parseDohAnswer(json: unknown, type: 1 | 28): DohAnswer {
  const o = json as { Status?: unknown; Answer?: unknown } | null
  const answered = !!o && typeof o === 'object' && typeof o.Status === 'number'
  if (type === 1) return { ips: parseDohJson(json), answered }
  const ans = Array.isArray(o?.Answer) ? (o.Answer as unknown[]) : []
  const ips = ans
    .filter(
      (a): a is { type: number; data: string } =>
        !!a && typeof a === 'object' && (a as { type?: unknown }).type === 28
    )
    .map((a) => String(a.data))
    .filter((ip) => isIP(ip) === 6)
  return { ips, answered }
}

/** answers of the last minute: a pick asks the same names for every strategy */
const dohCache = new Map<string, { ips: string[]; until: number }>()
const DOH_CACHE_MS = 60_000

/** A records of `name` from one DoH server, directly; [] on any failure. */
export async function dohResolve(
  name: string,
  server: DohServer,
  path: DirectPath,
  timeoutMs = 4000,
  cache = true
): Promise<string[]> {
  return (await dohLookup(name, server, path, timeoutMs, cache)).ips
}

/** A (or AAAA) records of `name` from one DoH server, directly; never throws. */
export function dohLookup(
  name: string,
  server: DohServer,
  path: DirectPath,
  timeoutMs = 4000,
  cache = true,
  type: 1 | 28 = 1
): Promise<DohAnswer> {
  const d = DOH[server]
  const key = `${server}|${path.localAddress ?? ''}|${name}|${type}`
  const hit = dohCache.get(key)
  if (cache && hit && hit.until > Date.now()) {
    return Promise.resolve({ ips: hit.ips, answered: true })
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (v: DohAnswer): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (v.ips.length) {
        if (dohCache.size > 500) dohCache.clear()
        dohCache.set(key, { ips: v.ips, until: Date.now() + DOH_CACHE_MS })
      }
      resolve(v)
    }
    const fail: DohAnswer = { ips: [], answered: false }
    const req = httpsRequest(
      {
        host: d.host,
        port: 443,
        path: d.path(name, type === 1 ? 'A' : 'AAAA'),
        method: 'GET',
        headers: { accept: 'application/dns-json' },
        agent: false,
        ...(path.localAddress ? { localAddress: path.localAddress } : {})
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          if (body.length < 65_536) body += c
        })
        res.on('end', () => {
          try {
            const a = parseDohAnswer(JSON.parse(body), type)
            finish({ ips: a.ips.slice(0, 8), answered: a.answered && res.statusCode === 200 })
          } catch {
            finish(fail)
          }
        })
        res.on('error', () => finish(fail))
      }
    )
    const timer = setTimeout(() => {
      req.destroy()
      finish(fail)
    }, timeoutMs)
    req.on('error', () => finish(fail))
    req.end()
  })
}

/** Which DoH answers directly right now (null = neither). */
export async function pickDoh(path: DirectPath, timeoutMs = 4000): Promise<DohServer | null> {
  const [a, b] = await Promise.all([
    // reachability: always asked for real
    dohResolve('www.google.com', 'primary', path, timeoutMs, false),
    dohResolve('www.google.com', 'fallback', path, timeoutMs, false)
  ])
  return a.length ? 'primary' : b.length ? 'fallback' : null
}

export interface TargetResult {
  host: string
  ok: boolean
  /**
   * what went wrong: dns, timeout, tls:<code>, http:closed…; `noaddr` = DNS
   * answered: the name has no address (a bare root of a game's domains)
   */
  error?: string
  ms?: number
  /**
   * tlsOnly, a domain: the server answered TLS, but its certificate is not a
   * valid one for this name — reachable, not confirmed (live traffic decides)
   */
  unconfirmed?: boolean
}

function errCode(e: unknown): string {
  if (e && typeof e === 'object') {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return e instanceof Error ? e.message.slice(0, 60) : String(e).slice(0, 60)
}

/**
 * A TLS alert from the server: it read our ClientHello and answered — the way
 * is open (an own domain without a web site on its root; DPI drops or resets,
 * it does not send alerts).
 */
export function isServerAlert(code: string): boolean {
  return /^ERR_SSL_(?:SSLV3|TLSV1)_(?:ALERT_|UNRECOGNIZED_NAME)/.test(code)
}

/**
 * One target: TCP + TLS to `ip` with SNI `host` (+ HEAD and the status line).
 * `tlsOnly`: any certificate, a finished handshake or a TLS alert = ok.
 * Never throws, never takes longer than `timeoutMs`.
 */
export function probeTls(
  ip: string,
  t: CheckTarget,
  path: DirectPath,
  timeoutMs = 6000,
  port = 443
): Promise<TargetResult> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    let sock: TLSSocket | null = null
    let done = false
    const finish = (ok: boolean, error?: string, unconfirmed = false): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock?.destroy()
      resolve({
        host: t.host,
        ok,
        ...(error ? { error } : { ms: Date.now() - t0 }),
        ...(unconfirmed ? { unconfirmed: true } : {})
      })
    }
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
    try {
      sock = tlsConnect({
        host: ip,
        port,
        // an IP rule: no SNI (RFC 6066 forbids an address there)
        ...(isIP(t.host) ? {} : { servername: t.host }),
        ALPNProtocols: ['http/1.1'],
        ...(t.tlsOnly ? { rejectUnauthorized: false } : {}),
        ...(path.localAddress ? { localAddress: path.localAddress } : {})
      })
    } catch (e) {
      finish(false, errCode(e))
      return
    }
    sock.once('error', (e) => {
      const code = errCode(e)
      // an alert: the server read our ClientHello (who it is — not confirmed for a domain)
      if (t.tlsOnly && isServerAlert(code)) finish(true, undefined, !isIP(t.host))
      else finish(false, `tls:${code}`)
    })
    sock.once('secureConnect', () => {
      if (t.tlsOnly && !isIP(t.host)) {
        // a domain: its certificate must be valid AND for this name — else «not confirmed»
        const s = sock as TLSSocket
        const valid = s.authorized && !checkServerIdentity(t.host, s.getPeerCertificate())
        finish(true, undefined, !valid)
        return
      }
      if (!t.http) {
        // an IP rule (no name to check): any certificate — the handshake is the answer
        finish(true)
        return
      }
      let buf = ''
      sock?.on('data', (d: Buffer) => {
        buf += d.toString('latin1')
        if (buf.includes('\r\n') || buf.length > 4096) {
          finish(/^HTTP\/\d(?:\.\d)? \d{3}/.test(buf), /^HTTP/.test(buf) ? undefined : 'http:bad')
        }
      })
      sock?.once('end', () => finish(false, 'http:closed'))
      sock?.once('close', () => finish(false, 'http:closed'))
      const req = t.path ? `GET ${t.path}` : 'HEAD /'
      sock?.write(
        `${req} HTTP/1.1\r\nHost: ${t.host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`
      )
    })
  })
}

/**
 * A target the way the browser would reach it directly: DoH (the server that
 * works) → the first address → TLS (+HTTP). Bounded by `timeoutMs` in total.
 */
export async function checkTarget(
  t: CheckTarget,
  doh: DohServer,
  path: DirectPath,
  timeoutMs = 9000
): Promise<TargetResult> {
  const t0 = Date.now()
  let ips = [t.host]
  if (!isIP(t.host)) {
    const a = await dohLookup(t.host, doh, path, 4000)
    ips = a.ips
    // an own domain: no A record — an AAAA one, or «no address» (not a failure of the way)
    if (!ips.length && a.answered && t.tlsOnly) {
      const v6 = await dohLookup(t.host, doh, path, 3000, true, 28)
      if (!v6.ips.length && v6.answered) return { host: t.host, ok: false, error: 'noaddr' }
      ips = v6.ips
    }
  }
  if (!ips.length) return { host: t.host, ok: false, error: 'dns' }
  const left = Math.max(1000, timeoutMs - (Date.now() - t0))
  if (t.quic) {
    const r = await probeQuic(ips[0], t.host, path.localAddress, Math.min(3000, left))
    return { host: t.host, ok: r.ok, ...(r.ok ? { ms: r.ms } : { error: r.error ?? 'timeout' }) }
  }
  return probeTls(ips[0], t, path, left)
}

/** Runs `fn` over `items`, at most `limit` at a time (order kept). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (x: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// --- the network we are on (the strategy is remembered per network) ----------

/** `arp -a <ip>` → the MAC of that address (language-independent: the pattern only). */
export function parseArpMac(text: string, ip: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] !== ip) continue
    const mac = cols.find((c) => /^([0-9a-f]{2}[-:]){5}[0-9a-f]{2}$/i.test(c))
    if (mac) return mac.toLowerCase().replace(/:/g, '-')
  }
  return null
}

/**
 * A short stable id of the network: the default gateway and its MAC (what
 * Windows' Network List Manager uses too) — the same router = the same
 * provider. Hashed: neither address is stored. null = no network.
 */
export function networkId(gateway: string, mac: string | null, iface: string): string {
  // an on-link default route (PPPoE: no gateway address, a new public address
  // on every reconnect) — the provider's address block (/16) stands for the network
  const onLink = isIP(gateway) !== 4
  const base = mac
    ? `${gateway}|${mac}`
    : onLink
      ? `on-link|${iface.split('.').slice(0, 2).join('.')}`
      : `${gateway}|${iface.split('.').slice(0, 3).join('.')}`
  return createHash('sha256').update(base).digest('hex').slice(0, 16)
}

export interface NetworkInfo {
  id: string
  /** the physical adapter's address (bind to it in TUN mode) */
  source: string
}

/** The current network: the best default route that is not ours (`exclude`). */
export async function currentNetwork(exclude: string[]): Promise<NetworkInfo | null> {
  if (process.platform !== 'win32') return null
  const routes = parseDefaultRoutes(await execLow('route', ['print', '-4', '0.0.0.0'], 8000))
  const source = pickPhysicalSource(routes, exclude)
  if (!source) return null
  const route = routes.filter((r) => r.iface === source).sort((a, b) => a.metric - b.metric)[0]
  const gateway = route?.gateway ?? ''
  const mac =
    isIP(gateway) === 4 ? parseArpMac(await execLow('arp', ['-a', gateway], 5000), gateway) : null
  return { id: networkId(gateway, mac, source), source }
}
