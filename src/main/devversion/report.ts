import { ConnAggregator, EventBook, type DestStats, type ProcStats } from './aggregate'
import { jitter, percentile, pushCapped, summarize } from './stats'

// ---------------------------------------------------------------------------
// DevVersion report, schema 1 (contract: .claude/plans/devversion.md):
//   { schema, consent_version, install_id, app_version, os:{build, edition},
//     mode, period:{from,to}, system, apps, probes, nodes, events, game_tests }
// The server stores the sections as they are (JSONB); its summaries read
// these fields (names agreed with the bot, 2026-11-23):
//   nodes[]      node, protocol, latency_ms, loss_pct, ok, failures (+ p95_ms, jitter_ms, stalls)
//   probes[]     target, route "direct"|"vpn", ok, latency_ms, loss_pct, failures
//                (+ node, protocol through a server; app for a program's addresses)
//   apps[]       name, direct_failures, domains[]{domain, direct_failures, …}
//   game_tests[] game, route, latency_ms, loss_pct, jitter_ms, ok, failures
// Before a report is written to disk or sent it goes through sanitizeReport
// (the subscription link / token, UUIDs, passwords and keys, node addresses,
// the Windows user name) and fitReport (the server's limits: ≤ 1 MB JSON,
// ≤ 200 000 values, depth ≤ 10). Pure — unit tested in report.test.ts.
// ---------------------------------------------------------------------------

export const REPORT_SCHEMA = 1

export interface TargetProbe {
  type: 'target'
  t: string
  /** the host checked */
  target: string
  /** youtube / discord / … / game */
  group: string
  port: number
  route: 'direct' | 'vpn'
  /** true = TCP connected (and TLS / HTTP answered when tried) */
  ok: boolean
  /** TCP connect time */
  latency_ms: number | null
  loss_pct: number
  failures: number
  /** the server for «vpn» */
  node?: string
  protocol?: string
  /** the program whose address this is (game domains) */
  app?: string
  /** how it left the machine: plain / src_bind / socks:xray */
  method: string
  dns_ms?: number | null
  tls_ms?: number | null
  tls_error?: string
  http_status?: number | null
  error?: string
}

export interface DnsProbe {
  type: 'dns'
  t: string
  target: string
  route: 'direct'
  /** false = the system resolver's answer looks spoofed (disjoint / bogon) */
  ok: boolean
  failures: number
  method: string
  system: string[]
  doh: string[]
  mismatch?: boolean
  /** the system resolver gave a private / null address — a typical block page trick */
  bogon?: boolean
  error?: string
}

export type ProbeRecord = TargetProbe | DnsProbe

export interface NodeSamples {
  protocol: string
  delays: (number | null)[]
  tcp: (number | null)[]
  tcpSkipped?: string
}

export interface TunnelSample {
  t: number
  ms: number | null
  node: string | null
  protocol: string | null
  method: string
}

export interface GameCheck {
  host: string
  port: number
  net: 'tcp' | 'udp'
  direct: { ok: boolean; ms: number | null; error?: string } | null
  vpn: { ok: boolean; ms: number | null; error?: string } | null
  skipped?: string
}

export interface GameTestRecord {
  started_at: string
  duration_s: number
  process: string
  mode: string
  /** the server «vpn» checks went through */
  node?: string
  protocol?: string
  flows: {
    host: string
    ip: string
    port: number
    net: 'tcp' | 'udp'
    via: string
    up: number
    down: number
    conns: number
  }[]
  checks: GameCheck[]
  note?: string
}

const MAX_PROBES = 3000
const MAX_TUNNEL = 400
const MAX_NODE_SAMPLES = 400
const MAX_GAME_TESTS = 10
const MAX_VPN_STATES = 200

/** Everything collected since the last report. */
export class Period {
  from = Date.now()
  readonly conns = new ConnAggregator()
  readonly events = new EventBook()
  readonly nodes = new Map<string, NodeSamples>()
  readonly tunnel: TunnelSample[] = []
  readonly probes: ProbeRecord[] = []
  readonly gameTests: GameTestRecord[] = []
  readonly vpnStates: { t: string; state: string }[] = []
  /** checks that could not be made honestly this period: what → why */
  readonly skips = new Map<string, string>()

  addProbe(p: ProbeRecord): void {
    pushCapped(this.probes, p, MAX_PROBES)
  }

  addSkip(what: string, reason: string): void {
    this.skips.set(what, reason)
  }

  addTunnel(s: TunnelSample): void {
    pushCapped(this.tunnel, s, MAX_TUNNEL)
  }

  node(name: string, protocol: string): NodeSamples {
    let n = this.nodes.get(name)
    if (!n) {
      n = { protocol, delays: [], tcp: [] }
      this.nodes.set(name, n)
    }
    return n
  }

  addNodeDelay(name: string, protocol: string, ms: number | null): void {
    pushCapped(this.node(name, protocol).delays, ms, MAX_NODE_SAMPLES)
  }

  addNodeTcp(name: string, protocol: string, ms: number | null, skipped?: string): void {
    const n = this.node(name, protocol)
    if (skipped) n.tcpSkipped = skipped
    else pushCapped(n.tcp, ms, MAX_NODE_SAMPLES)
  }

  addGameTest(g: GameTestRecord): void {
    pushCapped(this.gameTests, g, MAX_GAME_TESTS)
  }

  addVpnState(state: string, now: number): void {
    pushCapped(this.vpnStates, { t: new Date(now).toISOString(), state }, MAX_VPN_STATES)
  }

  /** Counters start over (the live connection marks of `conns` stay). */
  reset(now = Date.now()): void {
    this.from = now
    this.conns.resetPeriod()
    this.events.resetPeriod()
    this.nodes.clear()
    this.tunnel.length = 0
    this.probes.length = 0
    this.gameTests.length = 0
    this.vpnStates.length = 0
    this.skips.clear()
  }

  clear(now = Date.now()): void {
    this.reset(now)
    this.conns.clear()
    this.events.clear()
  }

  get probeCount(): number {
    let n = this.probes.length + this.tunnel.length
    for (const v of this.nodes.values()) n += v.delays.length + v.tcp.length
    return n
  }
}

export interface DirectFailureIn {
  host: string
  port: string
  count: number
  process?: string
}

export interface ReportMeta {
  consentVersion: string
  installId: string
  appVersion: string
  os: { build: string; edition: string }
  mode: 'tun' | 'proxy'
  system: Record<string, unknown>
  /** «не удалось напрямую» from the core log (DirectFailures): counted into apps */
  directFailures?: DirectFailureIn[]
  /** tunnel drops (VPN state connected → error / connecting) */
  drops?: number
  now: number
}

/** a keepalive round trip longer than this = the tunnel «stalled» */
export const STALL_MS = 2000

export interface Quality {
  latency_ms: number | null
  p95_ms: number | null
  jitter_ms: number | null
  loss_pct: number | null
  ok: boolean
  failures: number
  samples: number
}

/** Samples (time order, null = no answer) → the fields the bot's summaries read. */
export function qualityOf(samples: (number | null)[]): Quality {
  const s = summarize(samples)
  return {
    latency_ms: s.p50_ms,
    p95_ms: s.p95_ms,
    jitter_ms: s.jitter_ms,
    loss_pct: s.loss_pct,
    ok: s.ok_samples > 0,
    failures: s.samples - s.ok_samples,
    samples: s.samples
  }
}

export interface TunnelSummary extends Quality {
  kind: 'tunnel'
  node: string | null
  protocol: string | null
  method: string
  stalls: number
  drops: number
}

export function tunnelSummary(samples: TunnelSample[], drops = 0): TunnelSummary | null {
  if (samples.length === 0) return null
  const last = samples[samples.length - 1]
  return {
    kind: 'tunnel',
    node: last.node,
    protocol: last.protocol,
    method: last.method,
    ...qualityOf(samples.map((s) => s.ms)),
    stalls: samples.filter((s) => typeof s.ms === 'number' && s.ms > STALL_MS).length,
    drops
  }
}

const destOut = (
  key: string,
  d: DestStats,
  kind: 'domain' | 'ip',
  extra = 0
): Record<string, unknown> => ({
  [kind]: key,
  net: d.net,
  ports: d.ports,
  via: d.via,
  up: d.up,
  down: d.down,
  conns: d.conns,
  no_reply: d.noReply,
  direct_failures: d.directFailures + extra
})

const byTraffic = (a: [string, DestStats], b: [string, DestStats]): number =>
  b[1].up + b[1].down - (a[1].up + a[1].down) || b[1].conns - a[1].conns

export function appOut(p: ProcStats, logFails: DirectFailureIn[] = []): Record<string, unknown> {
  // failures the core logged for this program, by host / IP:port
  const byHost = new Map<string, number>()
  let extra = 0
  for (const f of logFails) {
    if ((f.process ?? '').toLowerCase() !== p.name) continue
    extra += f.count
    byHost.set(f.host, (byHost.get(f.host) ?? 0) + f.count)
    const ipKey = `${f.host}:${f.port}/tcp`
    byHost.set(ipKey, (byHost.get(ipKey) ?? 0) + f.count)
  }
  return {
    name: p.name,
    path: p.path,
    up: p.up,
    down: p.down,
    conns: p.conns,
    no_reply: p.noReply,
    direct_failures: p.directFailures + extra,
    via: p.via,
    domains: [...p.domains.entries()]
      .sort(byTraffic)
      .map(([k, d]) => destOut(k, d, 'domain', byHost.get(k) ?? 0)),
    ips: [...p.ips.entries()]
      .sort(byTraffic)
      .map(([k, d]) => destOut(k, d, 'ip', byHost.get(k) ?? 0))
  }
}

export function sortedApps(conns: ConnAggregator): ProcStats[] {
  return [...conns.procs.values()].sort(
    (a, b) => b.up + b.down - (a.up + a.down) || b.conns - a.conns
  )
}

/** One «Тест игры» → a record per route (what the bot summarizes); details on «direct». */
export function gameTestOut(g: GameTestRecord): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const route of ['direct', 'vpn'] as const) {
    const res = g.checks.map((c) => c[route]).filter((r): r is NonNullable<typeof r> => !!r)
    const ms = res.filter((r) => r.ok && typeof r.ms === 'number').map((r) => r.ms as number)
    const failures = res.filter((r) => !r.ok).length
    out.push({
      game: g.process,
      route,
      started_at: g.started_at,
      duration_s: g.duration_s,
      mode: g.mode,
      ...(route === 'vpn' && g.node ? { node: g.node, protocol: g.protocol } : {}),
      checked: res.length,
      ok: res.length > 0 && failures < res.length,
      failures,
      latency_ms: percentile(ms, 50),
      jitter_ms: jitter(ms),
      loss_pct: res.length ? Math.round((failures / res.length) * 1000) / 10 : null,
      ...(route === 'direct' ? { flows: g.flows, checks: g.checks } : {}),
      ...(g.note ? { note: g.note } : {})
    })
  }
  return out
}

/** what the server takes as app_version: ≤ 32 of [0-9A-Za-z.+_-] */
export const safeVersion = (v: string): string => v.replace(/[^0-9A-Za-z.+_-]/g, '').slice(0, 32)

export function buildReport(period: Period, meta: ReportMeta): Record<string, unknown> {
  const tunnel = tunnelSummary(period.tunnel, meta.drops ?? 0)
  const nodes: Record<string, unknown>[] = []
  for (const [name, n] of period.nodes) {
    const tcp = n.tcpSkipped ? { skipped: n.tcpSkipped } : qualityOf(n.tcp)
    nodes.push(
      n.delays.length
        ? {
            kind: 'tile',
            node: name,
            protocol: n.protocol,
            method: 'clash_delay',
            ...qualityOf(n.delays),
            tcp_direct: tcp
          }
        : // VPN off: only the TCP connect to the server's address could be measured
          {
            kind: 'tile',
            node: name,
            protocol: n.protocol,
            method: 'tcp_direct',
            ...tcp
          }
    )
  }
  if (tunnel) nodes.push({ ...tunnel })
  const events = [...period.events.entries.values()]
    .sort((a, b) => b.count - a.count)
    .map((e) => ({
      kind: e.kind,
      outbound: e.outbound,
      target: e.target,
      count: e.count,
      first: new Date(e.first).toISOString(),
      last: new Date(e.last).toISOString()
    }))
  return {
    schema: REPORT_SCHEMA,
    consent_version: meta.consentVersion,
    install_id: meta.installId,
    app_version: safeVersion(meta.appVersion),
    os: meta.os,
    mode: meta.mode,
    period: { from: new Date(period.from).toISOString(), to: new Date(meta.now).toISOString() },
    system: {
      ...meta.system,
      vpn_states: period.vpnStates,
      probe_skips: Object.fromEntries(period.skips)
    },
    apps: sortedApps(period.conns).map((p) => appOut(p, meta.directFailures)),
    probes: period.probes,
    nodes,
    events,
    game_tests: period.gameTests.flatMap(gameTestOut)
  }
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/** keys whose values are ours and must survive masking as they are */
const KEEP_KEYS = ['install_id', 'consent_version', 'schema', 'app_version'] as const

/** long opaque strings (tokens, keys) — but not domain labels / hex hashes of CDNs */
const OPAQUE_RE = /(?<![\w.-])[A-Za-z0-9_-]{32,}(?![\w.-])/g
const SECRET_QUERY_RE = /([?&](?:token|key|auth|password|pass|secret|sig|signature)=)[^&\s"]+/gi
/** the server refuses \u0000 anywhere */
const NUL_RE = /\\u0000/g

export interface SanitizeOpts {
  /** the app's masker (mask.ts createMasker): link, token, UUIDs, credentials, node hosts */
  mask: (text: string) => string
  /** the Windows user name and the PC name — never leave the machine */
  personal?: string[]
  /** this PC's own addresses (a public one included, if the NIC has it) */
  ownIps?: string[]
}

const IPV4_RE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g
/** fe80::/10 (link-local) and fc00::/7 (unique local: our TUN, the LAN) */
const IPV6_LOCAL_RE = /(?<![0-9a-f:])(fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):[0-9a-f:]*(?![0-9a-f:])/gi

/** What a private / LAN address becomes (null = keep it). */
export function privateIpTag(ip: string): string | null {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return null
  if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) {
    return '<private-ip>'
  }
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return '<lan-ip>'
  return null
}

/** Local addresses and the PC's own ones → placeholders (works on JSON text). */
export function maskIps(text: string, ownIps: string[] = []): string {
  const own = new Set(ownIps.map((s) => s.toLowerCase()))
  let out = text.replace(IPV4_RE, (m) => (own.has(m) ? '<own-ip>' : (privateIpTag(m) ?? m)))
  out = out.replace(IPV6_LOCAL_RE, '<local-ip6>')
  for (const ip of own) {
    if (ip.includes(':') && ip.length > 6) out = out.split(ip).join('<own-ip>')
  }
  return out
}

/** The bot's bounds: failures ≤ 1000, latency / jitter ≤ 60 000 ms, loss 0…100 %. */
export function clampMetrics(v: unknown): void {
  if (Array.isArray(v)) {
    for (const x of v) clampMetrics(x)
    return
  }
  if (!v || typeof v !== 'object') return
  const o = v as Record<string, unknown>
  for (const [k, x] of Object.entries(o)) {
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) o[k] = null
      else if (k === 'failures' || k === 'direct_failures') o[k] = Math.min(1000, Math.max(0, x))
      else if (k === 'latency_ms' || k === 'jitter_ms' || k === 'p95_ms')
        o[k] = Math.min(60_000, Math.max(0, x))
      else if (k === 'loss_pct') o[k] = Math.min(100, Math.max(0, x))
    } else if (x && typeof x === 'object') clampMetrics(x)
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Windows profile paths inside JSON text (backslashes are doubled there). */
const JSON_USER_PATH_RE = /[a-z]:(?:\\\\|\/)users(?:\\\\|\/)[^\\/"]+/gi

/**
 * A copy with every string masked. Works on the JSON text in one pass per
 * pattern (a 1 MB report: tens of ms, not seconds of walking every string).
 * KEEP_KEYS at the top level are put back as they were.
 */
export function sanitizeReport(
  report: Record<string, unknown>,
  opts: SanitizeOpts
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...report }
  for (const k of KEEP_KEYS) delete body[k]
  let text = JSON.stringify(body)
  text = text.replace(JSON_USER_PATH_RE, '%USERPROFILE%').replace(NUL_RE, '')
  text = opts.mask(text)
  text = maskIps(text, opts.ownIps)
  text = text.replace(SECRET_QUERY_RE, '$1***').replace(OPAQUE_RE, (m) => `${m.slice(0, 2)}***`)
  for (const s of opts.personal ?? []) {
    const v = s.trim()
    if (v.length < 3) continue
    text = text.replace(new RegExp(`(?<![\\w])${escapeRe(v)}(?![\\w])`, 'gi'), '***')
  }
  const out = JSON.parse(text) as Record<string, unknown>
  clampMetrics(out)
  for (const k of KEEP_KEYS) if (k in report) out[k] = report[k]
  return out
}

// ---------------------------------------------------------------------------
// Size limits (the server: ≤ 1 MB, ≤ 200 000 values, depth ≤ 10, lists ≤ 20 000)
// ---------------------------------------------------------------------------

export const MAX_VALUES = 190_000
export const MAX_DEPTH = 10

export const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8')

/** Every JSON value (objects, arrays, scalars) and the deepest nesting. */
export function shapeOf(v: unknown, depth = 1): { values: number; depth: number } {
  if (Array.isArray(v)) {
    let values = 1
    let d = depth
    for (const x of v) {
      const s = shapeOf(x, depth + 1)
      values += s.values
      d = Math.max(d, s.depth)
    }
    return { values, depth: d }
  }
  if (v && typeof v === 'object') {
    let values = 1
    let d = depth
    for (const x of Object.values(v)) {
      const s = shapeOf(x, depth + 1)
      values += s.values
      d = Math.max(d, s.depth)
    }
    return { values, depth: d }
  }
  return { values: 1, depth }
}

const fits = (r: unknown, maxBytes: number): boolean => {
  if (jsonBytes(r) > maxBytes) return false
  const s = shapeOf(r)
  return s.values <= MAX_VALUES && s.depth <= MAX_DEPTH
}

/**
 * The report cut down to the server's limits: the long tails go first (the
 * domains / IPs per program, then programs, probes, events). null = even the
 * skeleton does not fit.
 */
export function fitReport(
  report: Record<string, unknown>,
  maxBytes: number
): Record<string, unknown> | null {
  if (fits(report, maxBytes)) return report
  const r = JSON.parse(JSON.stringify(report)) as Record<string, unknown>
  const apps = (r.apps as Record<string, unknown>[] | undefined) ?? []
  const lists = ['probes', 'events', 'game_tests'] as const
  let perApp = 200
  let appCap = apps.length
  for (let round = 0; round < 24; round++) {
    perApp = Math.floor(perApp / 2)
    for (const a of apps) {
      a.domains = ((a.domains as unknown[]) ?? []).slice(0, perApp)
      a.ips = ((a.ips as unknown[]) ?? []).slice(0, perApp)
    }
    if (perApp < 10) {
      appCap = Math.floor(appCap / 2)
      r.apps = apps.slice(0, appCap)
    }
    if (round >= 4) {
      for (const k of lists) {
        const l = (r[k] as unknown[] | undefined) ?? []
        // the newest probes / the most frequent events are kept
        r[k] =
          k === 'probes' ? l.slice(Math.floor(l.length / 2)) : l.slice(0, Math.ceil(l.length / 2))
      }
    }
    if (fits(r, maxBytes)) {
      r.truncated = true
      return r
    }
  }
  return null
}
