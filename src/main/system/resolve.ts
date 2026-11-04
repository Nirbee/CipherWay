import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { OutboundConfig } from '@shared/types'

// ---------------------------------------------------------------------------
// Node addresses resolved once before the cores start (system DNS — the TUN
// is not up yet). Used for:
//  - tun.route_exclude_address: xray's connections to the nodes bypass the
//    TUN entirely (no second trip through sing-box's stack);
//  - xray dns.hosts: xray dials exactly these IPs, so its sockets always hit
//    the excluded routes (and never wait for DNS through the tunnel).
// ---------------------------------------------------------------------------

/** host → its IPs (IPv4 first); IP literals map to themselves */
export type ServerIps = Record<string, string[]>

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true })

/** `[2001:db8::1]` → `2001:db8::1`, lower-case, trimmed */
export function normalizeHost(server: string): string {
  return server
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(null)
      }
    )
  })
}

/**
 * Resolves every distinct node host in parallel. Hosts that fail or time out
 * are left out — the cores then resolve them themselves as before.
 */
export async function resolveServers(
  outbounds: OutboundConfig[],
  lookup: LookupFn = defaultLookup,
  timeoutMs = 3000
): Promise<ServerIps> {
  const hosts = [...new Set(outbounds.map((o) => normalizeHost(o.server)).filter(Boolean))]
  const out: ServerIps = {}
  await Promise.all(
    hosts.map(async (h) => {
      if (isIP(h)) {
        out[h] = [h]
        return
      }
      const res = await withTimeout(lookup(h), timeoutMs)
      if (!res?.length) return
      const v4 = res.filter((r) => r.family === 4).map((r) => r.address)
      const v6 = res.filter((r) => r.family === 6).map((r) => r.address)
      const ips = [...new Set([...v4, ...v6])]
      if (ips.length) out[h] = ips
    })
  )
  return out
}

/** Addresses that must never be excluded from the TUN routes. */
export function isRoutableIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return !/^(127\.|0\.)/.test(ip) && ip !== '255.255.255.255'
  if (v === 6) {
    const l = ip.toLowerCase()
    return l !== '::1' && l !== '::' && !l.startsWith('fe80:')
  }
  return false
}

/** `1.2.3.4` → `1.2.3.4/32`, `2001:db8::1` → `2001:db8::1/128` (deduped, loopback skipped). */
export function toExcludeCidrs(ips: ServerIps): string[] {
  const set = new Set<string>()
  for (const list of Object.values(ips)) {
    for (const ip of list) {
      if (!isRoutableIp(ip)) continue
      set.add(isIP(ip) === 4 ? `${ip}/32` : `${ip.toLowerCase()}/128`)
    }
  }
  return [...set]
}

/** Every resolved IP (for hiding them in logs, like the host names). */
export function allIps(ips: ServerIps): string[] {
  return [...new Set(Object.values(ips).flat())]
}
