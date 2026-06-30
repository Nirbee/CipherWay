import type { OutboundConfig, Protocol } from '@shared/types'

// ---------------------------------------------------------------------------
// URI parsers for the proxy schemes Remnawave subscriptions emit.
// All parsers are pure + side-effect free so they can be unit tested.
// ---------------------------------------------------------------------------

/** Stable-ish id derived from the raw URI (djb2) so ids survive refreshes. */
function hashId(raw: string): string {
  let h = 5381
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0
  return `ob_${h.toString(36)}`
}

function safeDecode(v: string | null | undefined): string | undefined {
  if (v == null || v === '') return undefined
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

/** Decode base64 (standard or url-safe), tolerant of missing padding. */
export function decodeBase64(input: string): string {
  const s = input.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '')
  const pad = s.length % 4 === 0 ? s : s + '='.repeat(4 - (s.length % 4))
  return Buffer.from(pad, 'base64').toString('utf8')
}

function looksLikeBase64(input: string): boolean {
  const t = input.trim()
  // a subscription body of links contains '://'; base64 blobs don't
  if (t.includes('://')) return false
  return /^[A-Za-z0-9+/_=\s-]+$/.test(t) && t.length > 16
}

// --- VLESS (incl. REALITY / TLS / ws / grpc) -------------------------------

export function parseVless(uri: string): OutboundConfig | null {
  if (!uri.startsWith('vless://')) return null
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  const q = url.searchParams
  const security = (q.get('security') as 'reality' | 'tls' | 'none' | null) ?? 'none'
  const network = (q.get('type') as OutboundConfig['network'] | null) ?? 'tcp'

  return {
    id: hashId(uri),
    name: safeDecode(url.hash.slice(1)) || `${url.hostname}:${url.port}`,
    protocol: 'vless',
    server: url.hostname,
    port: Number(url.port) || 443,
    uuid: decodeURIComponent(url.username),
    flow: q.get('flow') || undefined,
    security,
    publicKey: q.get('pbk') || undefined,
    shortId: q.get('sid') || undefined,
    serverName: q.get('sni') || q.get('serverName') || undefined,
    fingerprint: q.get('fp') || undefined,
    spiderX: safeDecode(q.get('spx')),
    network,
    path: safeDecode(q.get('path')),
    host: q.get('host') || undefined,
    raw: uri
  }
}

// --- Hysteria2 (hysteria2:// or hy2://) ------------------------------------

export function parseHysteria2(uri: string): OutboundConfig | null {
  if (!uri.startsWith('hysteria2://') && !uri.startsWith('hy2://')) return null
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  const q = url.searchParams
  // password can live in either userinfo half: user:pass@ or pass@
  const password = decodeURIComponent(url.password || url.username || q.get('auth') || '')
  const insecure = q.get('insecure') === '1' || q.get('insecure') === 'true'

  return {
    id: hashId(uri),
    name: safeDecode(url.hash.slice(1)) || `${url.hostname}:${url.port}`,
    protocol: 'hysteria2',
    server: url.hostname,
    port: Number(url.port) || 443,
    password: password || undefined,
    sni: q.get('sni') || undefined,
    obfs: q.get('obfs') || undefined,
    obfsPassword: safeDecode(q.get('obfs-password')),
    insecure,
    raw: uri
  }
}

// --- VMess (vmess://base64(json)) — fallback -------------------------------

interface VmessJson {
  ps?: string
  add?: string
  port?: string | number
  id?: string
  net?: string
  type?: string
  host?: string
  path?: string
  tls?: string
  sni?: string
}

export function parseVmess(uri: string): OutboundConfig | null {
  if (!uri.startsWith('vmess://')) return null
  try {
    const json = JSON.parse(decodeBase64(uri.slice('vmess://'.length))) as VmessJson
    return {
      id: hashId(uri),
      name: json.ps || `${json.add}:${json.port}`,
      protocol: 'vmess',
      server: String(json.add ?? ''),
      port: Number(json.port) || 443,
      uuid: json.id,
      security: json.tls === 'tls' ? 'tls' : 'none',
      network: (json.net as OutboundConfig['network']) || 'tcp',
      path: json.path,
      host: json.host,
      serverName: json.sni || json.host,
      raw: uri
    }
  } catch {
    return null
  }
}

const PARSERS: ((uri: string) => OutboundConfig | null)[] = [
  parseVless,
  parseHysteria2,
  parseVmess
]

export function parseUri(uri: string): OutboundConfig | null {
  const trimmed = uri.trim()
  if (!trimmed) return null
  for (const p of PARSERS) {
    const out = p(trimmed)
    if (out) return out
  }
  return null
}

/**
 * Parse a raw subscription body into outbounds. Handles:
 *  - base64-encoded blobs (decoded then re-parsed)
 *  - newline-separated URI lists
 *  - a JSON array of URIs or of outbound-like objects
 */
export function parseOutbounds(raw: string): OutboundConfig[] {
  const body = looksLikeBase64(raw) ? decodeBase64(raw) : raw

  // JSON array form
  const trimmed = body.trim()
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown[]
      const out: OutboundConfig[] = []
      for (const item of arr) {
        if (typeof item === 'string') {
          const parsed = parseUri(item)
          if (parsed) out.push(parsed)
        }
      }
      if (out.length) return out
    } catch {
      // fall through to line parsing
    }
  }

  return body
    .split(/\r?\n/)
    .map((l) => parseUri(l))
    .filter((o): o is OutboundConfig => o !== null)
}

export function protocolLabel(p: Protocol): string {
  switch (p) {
    case 'vless':
      return 'VLESS'
    case 'hysteria2':
      return 'Hysteria2'
    case 'vmess':
      return 'VMess'
  }
}
