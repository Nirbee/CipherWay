import type { ConnItem, OutboundConfig } from '@shared/types'
import { TAG_AUTO, TAG_DIRECT, TAG_PROXY_GROUP } from './sbTypes'
import { XRAY_EXE } from './xrayGen'

// ---------------------------------------------------------------------------
// Clash API `/connections` (sing-box) → what the «Подключения» screen shows.
// Destination hosts are the user's own sites and are kept; our node
// addresses never are: the chain is reduced to a server *name*, the matched
// rule loses its `=> route(<node id>)` tail, and connections of our own cores
// (xray.exe dialing the nodes in TUN mode) or to node addresses are dropped.
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
}

const OWN_CORES = new Set([XRAY_EXE, 'sing-box.exe'])

export function exeOf(path: string | undefined): string | undefined {
  if (!path) return undefined
  const name = path.split(/[\\/]/).pop()
  return name || undefined
}

/** `domain_suffix=[x.com] => route(ob_1)` → «домен x.com»; no node ids survive. */
export function describeRule(rule: string | undefined): string {
  const r = (rule ?? '').trim()
  if (!r || r === 'final') return 'По умолчанию'
  const cond = r.split('=>')[0].trim()
  const mode = /clash_mode=(\w+)/i.exec(cond)?.[1]?.toLowerCase()
  if (mode === 'global') return 'Режим «Весь трафик через VPN»'
  if (mode === 'direct') return 'Режим «Напрямую»'
  if (/ip_is_private/.test(cond)) return 'Локальная сеть'
  const list = (key: string): string | undefined => {
    const m = new RegExp(`${key}=\\[([^\\]]*)\\]`).exec(cond) ?? new RegExp(`${key}=(\\S+)`).exec(cond)
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

    const chain = c.chains ?? []
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
      rule: describeRule(c.rule),
      route,
      serverName,
      upload,
      download,
      uploadSpeed: prev ? Math.max(0, (upload - prev.upload) / dt) : 0,
      downloadSpeed: prev ? Math.max(0, (download - prev.download) / dt) : 0,
      start: Number.isFinite(start) ? start : ctx.now
    })
  }
  return out
}
