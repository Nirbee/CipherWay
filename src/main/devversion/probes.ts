import { execFile, type ChildProcess } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { constants as osConstants, setPriority } from 'node:os'
import { performance } from 'node:perf_hooks'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { socks5Connect, type SocksTarget } from '../core/latency'
import { inCidr4 } from '../core/connections'

// ---------------------------------------------------------------------------
// DevVersion network probes. Two ways out:
//  * «direct» — outside the VPN in every mode:
//      - VPN off / «Системный прокси»: a plain socket. Node's sockets never use
//        the WinInet proxy, so nothing of ours passes sing-box;
//      - TUN: the socket is bound to the address of the physical adapter
//        (the default route that is not ours, `route print`). Windows sends a
//        socket bound to an address out of the interface that owns it (strong
//        host model), so it does not enter the TUN; strict_route on Windows only
//        blocks DNS (port 53) outside the TUN. This is checked on every run by a
//        canary (DevVersionService.verifyBypass): if the core still lists the
//        canary connection as ours, the direct probes are skipped («tun_bypass_failed»).
//        Only our probe sockets are bound — the user's traffic is not touched.
//  * «vpn» — SOCKS5 into xray's loopback inbound of the server in use (VLESS:
//    one inbound per server, routed to exactly that server — see xrayGen.ts and
//    latency.ts SocksTarget). Servers sing-box carries itself (Hysteria2, VMess)
//    have no such entry in the running core → skipped («no_socks_entry»).
// No ICMP and no generic UDP probes: Node has no raw sockets, and an UDP
// «answer» needs the game's own protocol — reported as skipped, not invented.
// ---------------------------------------------------------------------------

export interface ProbePath {
  path: 'direct' | 'vpn'
  /** plain | src_bind | socks:xray */
  method: string
  localAddress?: string
  socks?: SocksTarget
  /** server name for «vpn» */
  node?: string
  protocol?: string
}

export interface ProbeResult {
  dns_ms?: number | null
  tcp_ms: number | null
  tls_ms?: number | null
  tls_error?: string
  http_status?: number | null
  error?: string
  /** bytes on the wire (both directions, TLS included) */
  bytes: number
}

export class ProbeError extends Error {}

const ms = (t0: number): number => Math.max(1, Math.round(performance.now() - t0))

function errCode(e: unknown): string {
  if (e && typeof e === 'object') {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)
}

function deadline<T>(p: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout()
      reject(new ProbeError('timeout'))
    }, timeoutMs)
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

/** IPv4 of `host` through the OS resolver (in TUN: answered by the core). */
async function resolve4(host: string): Promise<string> {
  if (isIP(host)) return host
  return (await lookup(host, { family: 4 })).address
}

function plainConnect(ip: string, port: number, localAddress?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: ip, port, ...(localAddress ? { localAddress } : {}) })
    sock.once('connect', () => resolve(sock))
    sock.once('error', (e) => {
      sock.destroy()
      reject(e)
    })
  })
}

/** Opens TCP to host:port the chosen way; the socket + timings. */
async function open(
  p: ProbePath,
  host: string,
  port: number
): Promise<{ sock: Socket; dnsMs: number | null; tcpMs: number }> {
  if (p.path === 'vpn') {
    if (!p.socks) throw new ProbeError('no_socks_entry')
    const t0 = performance.now()
    const sock = await socks5Connect(p.socks, host, port)
    return { sock, dnsMs: null, tcpMs: ms(t0) }
  }
  const d0 = performance.now()
  const ip = await resolve4(host)
  const dnsMs = isIP(host) ? null : ms(d0)
  const t0 = performance.now()
  const sock = await plainConnect(ip, port, p.localAddress)
  return { sock, dnsMs, tcpMs: ms(t0) }
}

/** Reads until the end of the first line (the HTTP status line). */
function statusLine(stream: TLSSocket | Socket): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (d: Buffer): void => {
      buf += d.toString('latin1')
      const i = buf.indexOf('\r\n')
      if (i < 0 && buf.length < 4096) return
      cleanup()
      const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buf.slice(0, i < 0 ? undefined : i))
      resolve(m ? Number(m[1]) : null)
    }
    const onEnd = (): void => {
      cleanup()
      reject(new ProbeError('closed'))
    }
    const onErr = (e: Error): void => {
      cleanup()
      reject(e)
    }
    const cleanup = (): void => {
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('close', onEnd)
      stream.off('error', onErr)
    }
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('close', onEnd)
    stream.once('error', onErr)
  })
}

export interface TargetOpts {
  timeoutMs?: number
  tls?: boolean
  http?: boolean
}

/**
 * One connection to host:port: TCP (+ TLS with SNI = host, certificate
 * checked; + `HEAD /` and the status line). Never throws.
 */
export async function probeTarget(
  p: ProbePath,
  host: string,
  port: number,
  o: TargetOpts = {}
): Promise<ProbeResult> {
  const timeoutMs = o.timeoutMs ?? 8000
  let sock: Socket | null = null
  let tls: TLSSocket | null = null
  const r: ProbeResult = { tcp_ms: null, bytes: 0 }
  const kill = (): void => {
    tls?.destroy()
    sock?.destroy()
  }
  const run = async (): Promise<void> => {
    const opened = await open(p, host, port).catch((e: unknown) => {
      r.error = errCode(e)
      return null
    })
    if (!opened) return
    sock = opened.sock
    if (opened.dnsMs !== null) r.dns_ms = opened.dnsMs
    r.tcp_ms = opened.tcpMs
    if (!o.tls) return
    const t0 = performance.now()
    const raw = sock
    tls = await new Promise<TLSSocket | null>((resolve) => {
      const t = tlsConnect({
        socket: raw,
        host,
        servername: isIP(host) ? undefined : host,
        ALPNProtocols: ['http/1.1']
      })
      t.once('secureConnect', () => resolve(t))
      t.once('error', (e) => {
        r.tls_error = errCode(e)
        resolve(null)
      })
    })
    if (!tls) {
      r.tls_ms = null
      return
    }
    r.tls_ms = ms(t0)
    if (!o.http) return
    tls.write(
      `HEAD / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0 (CipherWay DevVersion)\r\nAccept: */*\r\nConnection: close\r\n\r\n`
    )
    r.http_status = await statusLine(tls).catch((e: unknown) => {
      r.error = errCode(e)
      return null
    })
  }
  try {
    await deadline(run(), timeoutMs, kill)
  } catch (e) {
    r.error ??= errCode(e)
  } finally {
    const s = sock as Socket | null
    r.bytes = s ? s.bytesRead + s.bytesWritten : 0
    kill()
  }
  return r
}

/** TCP connect only (game flows, node addresses): ms or null + error. */
export async function tcpCheck(
  p: ProbePath,
  host: string,
  port: number,
  timeoutMs = 5000
): Promise<{ ok: boolean; ms: number | null; error?: string }> {
  const r = await probeTarget(p, host, port, { timeoutMs })
  return r.tcp_ms !== null
    ? { ok: true, ms: r.tcp_ms }
    : { ok: false, ms: null, ...(r.error ? { error: r.error } : {}) }
}

// ---------------------------------------------------------------------------
// DNS: the system resolver vs DoH 1.1.1.1
// ---------------------------------------------------------------------------

const BOGON = [
  '0.0.0.0/8',
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16'
]
export const isBogon = (ip: string): boolean => BOGON.some((c) => inCidr4(ip, c))

/** `{Answer:[{type:1,data:"1.2.3.4"}]}` (application/dns-json) → the A records. */
export function parseDohJson(json: unknown): string[] {
  const ans = (json as { Answer?: unknown } | null)?.Answer
  if (!Array.isArray(ans)) return []
  return ans
    .filter(
      (a): a is { type: number; data: string } =>
        !!a && typeof a === 'object' && (a as { type?: unknown }).type === 1
    )
    .map((a) => String(a.data))
    .filter((ip) => isIP(ip) === 4)
}

export function compareDns(system: string[], doh: string[]): { mismatch: boolean; bogon: boolean } {
  const s = new Set(system)
  return {
    mismatch: system.length > 0 && doh.length > 0 && !doh.some((ip) => s.has(ip)),
    bogon: system.some(isBogon)
  }
}

export async function systemA(host: string): Promise<string[]> {
  const list = await lookup(host, { family: 4, all: true })
  return [...new Set(list.map((a) => a.address))].slice(0, 8)
}

/** A records from https://1.1.1.1/dns-query (JSON API), the direct way. */
/**
 * One TLS connection to 1.1.1.1 for all the DNS checks of a run (20 handshakes
 * would cost ~100 KB); it closes itself 5 s after the last query.
 */
const dohAgent = new HttpsAgent({ keepAlive: true, maxSockets: 1, timeout: 5000 })

export function dohA(host: string, localAddress?: string, timeoutMs = 6000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '1.1.1.1',
        port: 443,
        path: `/dns-query?name=${encodeURIComponent(host)}&type=A`,
        method: 'GET',
        headers: { accept: 'application/dns-json' },
        ...(localAddress ? { localAddress } : {}),
        // a bound socket (TUN) can't share the pooled one
        agent: localAddress ? false : dohAgent,
        timeout: timeoutMs
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          if (body.length < 65_536) body += c
        })
        res.on('end', () => {
          try {
            resolve(parseDohJson(JSON.parse(body)).slice(0, 8))
          } catch {
            reject(new ProbeError('doh: bad answer'))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new ProbeError('timeout')))
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// The physical adapter's address (TUN): `route print -4`
// ---------------------------------------------------------------------------

export interface DefaultRoute {
  gateway: string
  iface: string
  metric: number
}

/** The 0.0.0.0/0 lines of `route print -4` (language-independent: numbers only). */
export function parseDefaultRoutes(text: string): DefaultRoute[] {
  const out: DefaultRoute[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/.exec(
      line
    )
    if (m) out.push({ gateway: m[1], iface: m[2], metric: Number(m[3]) })
  }
  return out
}

/** The best default route that is not ours (TUN) and not loopback → its source address. */
export function pickPhysicalSource(routes: DefaultRoute[], exclude: string[]): string | null {
  const ex = new Set(exclude)
  const ok = routes
    .filter(
      (r) => !ex.has(r.iface) && !r.iface.startsWith('127.') && !r.iface.startsWith('169.254.')
    )
    .sort((a, b) => a.metric - b.metric)
  return ok[0]?.iface ?? null
}

/** execFile with BELOW_NORMAL priority, hidden, with a timeout; stdout or '' on failure. */
export function execLow(cmd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    let child: ChildProcess | null = null
    try {
      child = execFile(
        cmd,
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (_err, stdout) => resolve(String(stdout ?? ''))
      )
      if (child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      if (!child) resolve('')
    }
  })
}

export async function physicalSource(exclude: string[]): Promise<string | null> {
  if (process.platform !== 'win32') return null
  return pickPhysicalSource(
    parseDefaultRoutes(await execLow('route', ['print', '-4', '0.0.0.0'])),
    exclude
  )
}
