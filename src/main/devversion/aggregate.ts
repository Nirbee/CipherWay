import type { OutboundConfig } from '@shared/types'
import type { RawConnection, RawConnections } from '../core/connections'
import { exeOf } from '../core/connections'
import { CORE_EXE, XRAY_EXE } from '../core/coreNames'
import { SLOT_FINAL } from '../rules/compile'
import { TAG_AUTO, TAG_DIRECT, TAG_PROXY_GROUP } from '../core/sbTypes'

// ---------------------------------------------------------------------------
// DevVersion: what programs talk to, from the Clash API `/connections`
// snapshots the core manager ALREADY polls every second for the traffic
// counters (SidecarManager.pollTraffic) — the collector makes no extra request
// to the core. It takes every Nth snapshot (every 3 s, every 6–10 s when there
// are hundreds of connections) and folds it in INCREMENTALLY: per live
// connection only the byte delta since the previous sample is added; a
// connection that disappeared is «closed» (with no byte received = no reply).
// Bounded: ≤ 100 processes, ≤ 200 domains and ≤ 200 IPs per process (the
// rarest are dropped first), ≤ 20 000 live connections tracked.
// Pure — unit tested in aggregate.test.ts.
// ---------------------------------------------------------------------------

export const MAX_PROCESSES = 100
export const MAX_DOMAINS = 200
export const MAX_IPS = 200
const MAX_PORTS = 8
const MAX_LIVE = 20_000
/** maps are trimmed back to the cap once they grow this much past it */
const SLACK = 1.25

/** UDP of a non-browser program at this rate = a game / a call is on */
export const REALTIME_UDP_BPS = 2048
/** … and it counts as «on» this long after the last such sample */
export const REALTIME_HOLD_MS = 90_000

/** browsers, system services, torrent clients: their UDP (QUIC, DHT) is not a game */
const NOT_REALTIME = new Set(
  [
    'chrome.exe',
    'msedge.exe',
    'msedgewebview2.exe',
    'firefox.exe',
    'opera.exe',
    'opera_gx.exe',
    'brave.exe',
    'browser.exe',
    'vivaldi.exe',
    'arc.exe',
    'iexplore.exe',
    'svchost.exe',
    'system',
    'lsass.exe',
    'spoolsv.exe',
    'searchhost.exe',
    'onedrive.exe',
    'qbittorrent.exe',
    'utorrent.exe',
    'bittorrent.exe',
    'transmission-qt.exe',
    'tixati.exe',
    'steamwebhelper.exe',
    'cipherway vpn.exe',
    'cipherway.exe',
    CORE_EXE,
    XRAY_EXE
  ].map((s) => s.toLowerCase())
)

/** Known game executables (lower case): any traffic from them = a game is on. */
export const KNOWN_GAMES = new Set(
  [
    'rainbowsix.exe',
    'rainbowsix_be.exe',
    'rainbowsix_vulkan.exe',
    'cs2.exe',
    'csgo.exe',
    'dota2.exe',
    'valorant-win64-shipping.exe',
    'fortniteclient-win64-shipping.exe',
    'r5apex.exe',
    'r5apex_dx12.exe',
    'gta5.exe',
    'gta5_enhanced.exe',
    'league of legends.exe',
    'leagueoflegends.exe',
    'rustclient.exe',
    'tslgame.exe',
    'escapefromtarkov.exe',
    'overwatch.exe',
    'destiny2.exe',
    'bf2042.exe',
    'cod.exe',
    'deadbydaylight-win64-shipping.exe',
    'warframe.x64.exe',
    'worldoftanks.exe',
    'eldenring.exe',
    'thefinals.exe',
    'marvel-win64-shipping.exe',
    'helldivers2.exe',
    'deadlock.exe'
  ].map((s) => s.toLowerCase())
)

export function isKnownGame(exe: string | undefined): boolean {
  return !!exe && KNOWN_GAMES.has(exe.toLowerCase())
}

/** `C:\Users\Ivan\AppData\…` → `%USERPROFILE%\AppData\…` (any drive, any case). */
export function maskUserPath(p: string): string {
  return p.replace(/[a-z]:[\\/]users[\\/][^\\/]+(?=[\\/]|$)/gi, '%USERPROFILE%')
}

export type Via = string // 'direct' | 'reject' | 'vpn' | 'vpn:<server name>'

export interface DestStats {
  net: 'tcp' | 'udp'
  ports: number[]
  via: Via
  up: number
  down: number
  conns: number
  noReply: number
  /** closed with no reply while going direct */
  directFailures: number
}

export interface ProcStats {
  name: string
  path: string
  up: number
  down: number
  conns: number
  noReply: number
  directFailures: number
  via: Record<string, { up: number; down: number; conns: number }>
  domains: Map<string, DestStats>
  ips: Map<string, DestStats>
}

interface Live {
  proc: string
  domain: string
  ipKey: string
  via: Via
  up: number
  down: number
  seen: number
}

export interface ConnSample {
  id: string
  proc: string
  path: string
  domain: string
  ip: string
  port: number
  net: 'tcp' | 'udp'
  via: Via
  up: number
  down: number
}

const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/i

/** One Clash API connection → a sample; null = ours / a node address / unusable. */
export function toSample(
  c: RawConnection,
  names: Map<string, string>,
  hidden: Set<string>
): ConnSample | null {
  const md = c.metadata ?? {}
  const proc = (exeOf(md.processPath) ?? '').toLowerCase()
  if (proc === CORE_EXE || proc === XRAY_EXE) return null
  const ip = (md.destinationIP ?? '').trim().toLowerCase()
  const rawHost = (md.host ?? '').trim().toLowerCase()
  const domain = rawHost && !IP_RE.test(rawHost) ? rawHost : ''
  if ((domain && hidden.has(domain)) || (ip && hidden.has(ip))) return null
  const chain = (c.chains ?? []).filter((t) => t !== SLOT_FINAL)
  const tail = chain[0]
  let via: Via
  if (/=>\s*reject/i.test(c.rule ?? '')) via = 'reject'
  else if (!tail || tail === TAG_DIRECT) via = 'direct'
  else if (tail === TAG_AUTO || tail === TAG_PROXY_GROUP) via = 'vpn'
  else via = `vpn:${names.get(tail) ?? 'сервер'}`
  return {
    id: c.id,
    proc: proc || 'unknown',
    path: md.processPath ? maskUserPath(md.processPath) : '',
    domain,
    ip: ip || rawHost,
    port: Number(md.destinationPort) || 0,
    net: md.network === 'udp' ? 'udp' : 'tcp',
    via,
    up: c.upload ?? 0,
    down: c.download ?? 0
  }
}

const score = (d: { up: number; down: number; conns: number }): number =>
  d.up + d.down + d.conns * 4096

/** Keeps the `cap` biggest entries of a map (by bytes + connections). */
function trim<V extends { up: number; down: number; conns: number }>(
  map: Map<string, V>,
  cap: number
): void {
  if (map.size <= cap * SLACK) return
  const keep = [...map.entries()].sort((a, b) => score(b[1]) - score(a[1])).slice(0, cap)
  map.clear()
  for (const [k, v] of keep) map.set(k, v)
}

function dest(map: Map<string, DestStats>, key: string, s: ConnSample): DestStats {
  let d = map.get(key)
  if (!d) {
    d = {
      net: s.net,
      ports: [],
      via: s.via,
      up: 0,
      down: 0,
      conns: 0,
      noReply: 0,
      directFailures: 0
    }
    map.set(key, d)
  }
  return d
}

export class ConnAggregator {
  readonly procs = new Map<string, ProcStats>()
  private live = new Map<string, Live>()
  private tick = 0
  /** process → last time it had real-time UDP traffic */
  private realtimeAt = new Map<string, number>()
  private lastSampleAt = 0
  totalConns = 0
  totalBytes = 0

  /** How many snapshots to skip between samples: fewer samples when the list is long. */
  static strideFor(count: number): number {
    if (count >= 1000) return 10
    if (count >= 300) return 6
    return 3
  }

  private proc(s: ConnSample): ProcStats {
    let p = this.procs.get(s.proc)
    if (!p) {
      p = {
        name: s.proc,
        path: s.path,
        up: 0,
        down: 0,
        conns: 0,
        noReply: 0,
        directFailures: 0,
        via: {},
        domains: new Map(),
        ips: new Map()
      }
      this.procs.set(s.proc, p)
    }
    if (!p.path && s.path) p.path = s.path
    return p
  }

  /** Folds one snapshot in (O(connections)); `now` in ms. */
  ingest(raw: RawConnections, outbounds: OutboundConfig[], hidden: Set<string>, now: number): void {
    const names = new Map(outbounds.map((o) => [o.id, o.name]))
    const tick = ++this.tick
    const dt = this.lastSampleAt ? Math.max(1, (now - this.lastSampleAt) / 1000) : 3
    this.lastSampleAt = now
    for (const c of raw.connections ?? []) {
      const s = toSample(c, names, hidden)
      if (!s) continue
      const p = this.proc(s)
      const domainKey = s.domain
      const ipKey = s.ip ? `${s.ip}:${s.port}/${s.net}` : ''
      let l = this.live.get(s.id)
      const fresh = !l
      if (!l) {
        if (this.live.size >= MAX_LIVE) continue
        l = { proc: s.proc, domain: domainKey, ipKey, via: s.via, up: 0, down: 0, seen: tick }
        this.live.set(s.id, l)
      }
      const du = Math.max(0, s.up - l.up)
      const dd = Math.max(0, s.down - l.down)
      l.up = s.up
      l.down = s.down
      l.seen = tick
      l.via = s.via
      const v = (p.via[s.via] ??= { up: 0, down: 0, conns: 0 })
      p.up += du
      p.down += dd
      v.up += du
      v.down += dd
      this.totalBytes += du + dd
      if (fresh) {
        p.conns++
        v.conns++
        this.totalConns++
      }
      for (const [map, key] of [
        [p.domains, domainKey],
        [p.ips, ipKey]
      ] as const) {
        if (!key) continue
        const d = dest(map, key, s)
        d.up += du
        d.down += dd
        d.via = s.via
        if (fresh) {
          d.conns++
          if (d.ports.length < MAX_PORTS && !d.ports.includes(s.port)) d.ports.push(s.port)
        }
      }
      if (s.net === 'udp' && (du + dd) / dt >= REALTIME_UDP_BPS && !NOT_REALTIME.has(s.proc)) {
        this.realtimeAt.set(s.proc, now)
      } else if (isKnownGame(s.proc) && du + dd > 0) {
        this.realtimeAt.set(s.proc, now)
      }
    }
    // gone since the last sample = closed; nothing received = no reply
    for (const [id, l] of this.live) {
      if (l.seen === tick) continue
      this.live.delete(id)
      if (l.down > 0) continue
      const p = this.procs.get(l.proc)
      if (!p) continue
      const direct = l.via === 'direct' ? 1 : 0
      p.noReply++
      p.directFailures += direct
      const d = l.domain ? p.domains.get(l.domain) : undefined
      if (d) {
        d.noReply++
        d.directFailures += direct
      }
      const i = l.ipKey ? p.ips.get(l.ipKey) : undefined
      if (i) {
        i.noReply++
        i.directFailures += direct
      }
    }
    this.enforceCaps()
  }

  private enforceCaps(): void {
    for (const p of this.procs.values()) {
      trim(p.domains, MAX_DOMAINS)
      trim(p.ips, MAX_IPS)
    }
    trim(this.procs, MAX_PROCESSES)
  }

  /** A game / call is on: the program, or null. */
  realtime(now: number): string | null {
    let best: string | null = null
    let bestAt = 0
    for (const [proc, at] of this.realtimeAt) {
      if (now - at > REALTIME_HOLD_MS) {
        this.realtimeAt.delete(proc)
        continue
      }
      if (at > bestAt) {
        best = proc
        bestAt = at
      }
    }
    return best
  }

  /** New period: the counters start from zero; live connections keep their byte marks. */
  resetPeriod(): void {
    this.procs.clear()
    this.totalConns = 0
    this.totalBytes = 0
  }

  /** Everything off (DevVersion switched off). */
  clear(): void {
    this.resetPeriod()
    this.live.clear()
    this.realtimeAt.clear()
    this.lastSampleAt = 0
  }

  get liveCount(): number {
    return this.live.size
  }
}

// ---------------------------------------------------------------------------
// Events: direct failures, REALITY errors, timeouts / resets from the core logs
// ---------------------------------------------------------------------------

export interface EventEntry {
  kind: string
  outbound: string
  target: string
  count: number
  first: number
  last: number
}

const MAX_EVENT_KEYS = 500
const MAX_RECENT = 60

const EVENT_KINDS: { kind: string; re: RegExp }[] = [
  { kind: 'reality', re: /REALITY: received real certificate/ },
  { kind: 'timeout', re: /i\/o timeout|timed out|did not properly respond|deadline exceeded/i },
  { kind: 'no_activity', re: /no recent network activity/i },
  { kind: 'reset', re: /connection reset|forcibly closed|принудительно разорвал/i },
  { kind: 'refused', re: /connection refused|actively refused|отверг/i },
  { kind: 'eof', re: /unexpected EOF|\bEOF\b/ },
  { kind: 'tls', re: /tls: |handshake failure|certificate/i },
  { kind: 'dns', re: /lookup .* (no such host|server misbehaving)|dns: /i }
]

const OUTBOUND_TAG_RE = /outbound\/[\w-]+\[([^\]]*)\]/
const TARGET_RE =
  /(?:open connection to|dial tcp|dial udp|connect to) \[?([\w.:-]+?)\]?:(\d{1,5})\b/

/** Kind + outbound tag + target of one core log line; null = not an error worth counting. */
export function classifyLine(
  line: string
): { kind: string; outboundTag: string; target: string } | null {
  if (!/ERROR|WARN|error|REALITY/.test(line)) return null
  const k = EVENT_KINDS.find((e) => e.re.test(line))
  if (!k) return null
  const outboundTag = OUTBOUND_TAG_RE.exec(line)?.[1] ?? ''
  const t = TARGET_RE.exec(line)
  // our own loopback hops (core ↔ xray) are not the user's targets
  if (t && /^127\./.test(t[1])) return null
  return { kind: k.kind, outboundTag, target: t ? `${t[1]}:${t[2]}` : '' }
}

export class EventBook {
  readonly entries = new Map<string, EventEntry>()
  readonly recent: { at: number; kind: string; outbound: string; target: string }[] = []

  note(kind: string, outbound: string, target: string, now: number): void {
    const key = `${kind}|${outbound}|${target}`
    const e = this.entries.get(key)
    if (e) {
      e.count++
      e.last = now
    } else {
      this.entries.set(key, { kind, outbound, target, count: 1, first: now, last: now })
      if (this.entries.size > MAX_EVENT_KEYS * SLACK) {
        const keep = [...this.entries.entries()]
          .sort((a, b) => b[1].last - a[1].last)
          .slice(0, MAX_EVENT_KEYS)
        this.entries.clear()
        for (const [k, v] of keep) this.entries.set(k, v)
      }
    }
    // the «последние события» list: repeats of the same thing within 10 s are one line
    const last = this.recent[this.recent.length - 1]
    if (last && last.kind === kind && last.target === target && now - last.at < 10_000) return
    this.recent.push({ at: now, kind, outbound, target })
    if (this.recent.length > MAX_RECENT) this.recent.shift()
  }

  get total(): number {
    let n = 0
    for (const e of this.entries.values()) n += e.count
    return n
  }

  resetPeriod(): void {
    this.entries.clear()
  }

  clear(): void {
    this.entries.clear()
    this.recent.length = 0
  }
}
