import type { ConnItem, FailedDirect, OutboundConfig } from '@shared/types'
import { TAG_AUTO, TAG_DIRECT, TAG_PROXY_GROUP } from './sbTypes'
import { CORE_EXE, XRAY_EXE } from './coreNames'
import { SLOT_FINAL, TELEGRAM_CIDRS } from '../rules/compile'

// ---------------------------------------------------------------------------
// Clash API `/connections` (sing-box) → what the «Подключения» screen shows.
// Destination hosts are the user's own sites and are kept; our node
// addresses never are: the chain is reduced to a server *name*, the matched
// rule loses its `=> route(<node id>)` tail, and connections of our own cores
// (cipherway-xray.exe dialing the nodes in TUN mode) or to node addresses are dropped.
// Pure — unit tested in connections.test.ts.
// ---------------------------------------------------------------------------

export interface RawConnection {
  id: string
  metadata?: {
    network?: string
    type?: string
    sourceIP?: string
    sourcePort?: string
    destinationIP?: string
    destinationPort?: string
    host?: string
    processPath?: string
  }
  upload?: number
  download?: number
  start?: string
  chains?: string[]
  rule?: string
}

export interface RawConnections {
  connections?: RawConnection[] | null
  uploadTotal?: number
  downloadTotal?: number
}

export interface ConnContext {
  outbounds: OutboundConfig[]
  /** id -> { upload, download, ts } from the previous snapshot */
  prev: Map<string, { upload: number; download: number; ts: number }>
  now: number
  /** rule-set tag of a rule slot → what the user wrote (rules/compile.ts) */
  labels?: Record<string, string>
  /** rule-set tag → PROCESS-NAME values of its run (rules/compile.ts) */
  programs?: Record<string, string[]>
}

/** a direct connection that got nothing back for this long is probably blocked */
export const STALL_MS = 4000

const OWN_CORES = new Set<string>([XRAY_EXE, CORE_EXE])

export function exeOf(path: string | undefined): string | undefined {
  if (!path) return undefined
  const name = path.split(/[\\/]/).pop()
  return name || undefined
}

/** a rule slot of the user's rules (rules/compile.ts) in sing-box's rule text */
const SLOT_RE = /rule_set=\[?(cw-\d+-[dpx])\]?/

/** `domain_suffix=[x.com] => route(ob_1)` → «домен x.com»; no node ids survive. */
export function describeRule(
  rule: string | undefined,
  labels: Record<string, string> = {}
): string {
  const r = (rule ?? '').trim()
  if (!r || r === 'final') return 'Всё остальное'
  const cond = r.split('=>')[0].trim()
  // the user's rules live in slots (rule_set=cw-3-p) — show what they wrote
  const slot = SLOT_RE.exec(cond)?.[1]
  if (slot) return labels[slot] ?? 'Правило'
  const mode = /clash_mode=(\w+)/i.exec(cond)?.[1]?.toLowerCase()
  if (mode === 'global') return 'Режим «Весь трафик через VPN»'
  if (mode === 'direct') return 'Режим «Напрямую»'
  // the tail rule of the «Правила» mode (configGen RULE_MODE_TAIL) = route.final
  if (mode === 'rule') return 'Всё остальное'
  if (/ip_is_private/.test(cond)) return 'Локальная сеть'
  const list = (key: string): string | undefined => {
    const m =
      new RegExp(`${key}=\\[([^\\]]*)\\]`).exec(cond) ?? new RegExp(`${key}=(\\S+)`).exec(cond)
    return m?.[1]?.trim()
  }
  const pairs: [string, string][] = [
    ['process_name', 'процесс'],
    ['process_path', 'путь'],
    ['domain_suffix', 'домен'],
    ['domain_keyword', 'слово в домене'],
    ['domain_regex', 'шаблон домена'],
    ['domain', 'домен'],
    ['ip_cidr', 'IP-подсеть'],
    ['port_range', 'порт'],
    ['port', 'порт'],
    ['rule_set', 'набор']
  ]
  for (const [key, label] of pairs) {
    const v = list(key)
    if (v) return `${label} ${v.replace(/^geosite-/, 'geosite:').replace(/^geoip-/, 'geoip:')}`
  }
  if (/process_name|process_path/.test(cond)) return 'Правило по процессу'
  return 'Правило'
}

/**
 * The rule of one connection. A run of «программа …» rules is one slot: its
 * label names the first program («программа lyrebird.exe и ещё 9») — for a
 * connection of a program from that run say which one matched.
 */
export function connectionRule(
  rule: string | undefined,
  process: string | undefined,
  labels: Record<string, string> = {},
  programs: Record<string, string[]> = {}
): string {
  const slot = SLOT_RE.exec((rule ?? '').split('=>')[0])?.[1]
  if (slot && process) {
    const p = process.toLowerCase()
    const hit = programs[slot]?.find((x) => x.toLowerCase() === p)
    if (hit) return `программа ${hit}`
  }
  return describeRule(rule, labels)
}

/** Node hosts / IPs, lower-case, for hiding connections that target them. */
export function nodeAddressSet(outbounds: OutboundConfig[]): Set<string> {
  return new Set(outbounds.map((o) => o.server.trim().toLowerCase()).filter(Boolean))
}

export function toConnItems(raw: RawConnections, ctx: ConnContext): ConnItem[] {
  const names = new Map(ctx.outbounds.map((o) => [o.id, o.name]))
  const nodeAddrs = nodeAddressSet(ctx.outbounds)
  const out: ConnItem[] = []

  for (const c of raw.connections ?? []) {
    const md = c.metadata ?? {}
    const process = exeOf(md.processPath)
    if (process && OWN_CORES.has(process.toLowerCase())) continue
    const host = (md.host || md.destinationIP || '').trim()
    if (nodeAddrs.has(host.toLowerCase()) || nodeAddrs.has((md.destinationIP ?? '').toLowerCase()))
      continue

    const chain = (c.chains ?? []).filter((t) => t !== SLOT_FINAL)
    const tail = chain[0]
    let route: ConnItem['route'] = 'proxy'
    let serverName: string | undefined
    if (/=>\s*reject/i.test(c.rule ?? '')) route = 'reject'
    else if (tail === TAG_DIRECT || !tail) route = 'direct'
    else {
      serverName =
        names.get(tail) ?? (tail === TAG_AUTO || tail === TAG_PROXY_GROUP ? undefined : 'сервер')
    }

    const upload = c.upload ?? 0
    const download = c.download ?? 0
    const prev = ctx.prev.get(c.id)
    const dt = prev ? Math.max(0.25, (ctx.now - prev.ts) / 1000) : 0
    const start = c.start ? Date.parse(c.start) : NaN

    out.push({
      id: c.id,
      process,
      processPath: md.processPath || undefined,
      host: host || '—',
      port: md.destinationPort ?? '',
      network: md.network ?? 'tcp',
      rule: connectionRule(c.rule, process, ctx.labels, ctx.programs),
      route,
      serverName,
      ...(route === 'direct' &&
      download === 0 &&
      ctx.now - (Number.isFinite(start) ? start : ctx.now) > STALL_MS
        ? { stalled: true }
        : {}),
      upload,
      download,
      uploadSpeed: prev ? Math.max(0, (upload - prev.upload) / dt) : 0,
      downloadSpeed: prev ? Math.max(0, (download - prev.download) / dt) : 0,
      start: Number.isFinite(start) ? start : ctx.now
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// «Не удалось подключиться напрямую»: sing-box logs (at warn level too)
//   ERROR [id 5.0s] connection: open connection to 149.154.167.41:443 using
//   outbound/direct[direct]: dial tcp 149.154.167.41:443: i/o timeout
// Collected per address; the process comes from live connections seen while
// they were still dialing (the Clash API lists them during the dial).
// ---------------------------------------------------------------------------

const FAIL_RE =
  /open connection to (\S+?):(\d+) using outbound\/direct\[direct\]:.*(i\/o timeout|timed out|did not properly respond)/i
const KEEP_MS = 15 * 60_000
const MAX_FAILED = 40

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

export function inCidr4(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/')
  const a = ipv4ToInt(ip)
  const b = ipv4ToInt(net)
  const bits = Number(bitsStr)
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

export function isTelegramIp(ip: string): boolean {
  return TELEGRAM_CIDRS.some((c) => !c.includes(':') && inCidr4(ip, c))
}

export class DirectFailures {
  private failed = new Map<string, FailedDirect>()
  /** host:port → exe, from direct connections seen in snapshots */
  private seen = new Map<string, { process: string; at: number }>()

  /** Feed every sing-box log line. */
  noteLog(line: string, now = Date.now()): void {
    const m = FAIL_RE.exec(line)
    if (!m) return
    const host = m[1].replace(/^\[|\]$/g, '')
    const key = `${host}:${m[2]}`
    const prev = this.failed.get(key)
    this.failed.set(key, {
      host,
      port: m[2],
      count: (prev?.count ?? 0) + 1,
      last: now,
      ...(prev?.process ? { process: prev.process } : {}),
      ...(isTelegramIp(host) ? { telegram: true } : {})
    })
    if (this.failed.size > MAX_FAILED * 2) this.prune(now)
  }

  /** Remember which program dialed what (direct connections only). */
  noteConnections(items: ConnItem[], now = Date.now()): void {
    for (const c of items) {
      if (c.route !== 'direct' || !c.process) continue
      this.seen.set(`${c.host}:${c.port}`, { process: c.process, at: now })
    }
    if (this.seen.size > 2000) {
      for (const [k, v] of this.seen) if (now - v.at > KEEP_MS) this.seen.delete(k)
    }
  }

  private prune(now: number): void {
    for (const [k, v] of this.failed) if (now - v.last > KEEP_MS) this.failed.delete(k)
  }

  /** Newest first; node addresses are never listed. */
  list(hidden: Set<string>, now = Date.now()): FailedDirect[] {
    this.prune(now)
    return [...this.failed.entries()]
      .filter(([, f]) => !hidden.has(f.host.toLowerCase()))
      .map(([key, f]) => {
        const p = f.process ?? this.seen.get(key)?.process
        return p ? { ...f, process: p } : f
      })
      .sort((a, b) => b.last - a.last)
      .slice(0, MAX_FAILED)
  }

  clear(): void {
    this.failed.clear()
  }
}
