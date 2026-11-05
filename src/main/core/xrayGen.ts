import { isIP } from 'node:net'
import type { OutboundConfig } from '@shared/types'
import { normalizeHost, type ServerIps } from '../system/resolve'

// ---------------------------------------------------------------------------
// Xray-core config generator.
//
// Architecture: Xray carries the actual VLESS (+REALITY/TLS) connections to the
// nodes (same core as the Xray nodes themselves, so protocol changes on the
// servers don't break the client). sing-box stays in front for TUN, routing
// rules, DNS and Hysteria2.
//
//   app traffic -> sing-box (tun / mixed) -> socks outbound 127.0.0.1:<port>
//               -> xray socks inbound (one per VLESS node) -> VLESS outbound
//
// Each VLESS node gets its own loopback SOCKS inbound with a dedicated port,
// and xray routing maps inboundTag -> outboundTag 1:1. Inbounds listen on
// 127.0.0.1 only (no auth, UDP enabled). Schema checked with
// `xray run -test -c` against Xray-core 26.7.x (see scripts/download-cores.ts).
// ---------------------------------------------------------------------------

export const XRAY_BLOCK_TAG = 'block'

/** Protocols whose connections are carried by xray (the rest stay in sing-box). */
export function isXrayHandled(o: OutboundConfig): boolean {
  return o.protocol === 'vless'
}

export interface XrayBridge {
  outbound: OutboundConfig
  /** local SOCKS port xray listens on for this node */
  port: number
}

export interface XrayConfig {
  log: { loglevel: string; access?: string }
  dns?: { hosts: Record<string, string[]> }
  inbounds: Record<string, unknown>[]
  outbounds: Record<string, unknown>[]
  routing: { domainStrategy: string; rules: Record<string, unknown>[] }
}

const inTag = (id: string): string => `in-${id}`
const outTag = (id: string): string => `out-${id}`

function streamSettings(o: OutboundConfig): Record<string, unknown> {
  const network = o.network === 'ws' || o.network === 'grpc' ? o.network : 'raw'
  const s: Record<string, unknown> = { network }

  if (o.security === 'reality') {
    s.security = 'reality'
    s.realitySettings = {
      serverName: o.serverName ?? '',
      fingerprint: o.fingerprint ?? 'chrome',
      publicKey: o.publicKey ?? '',
      shortId: o.shortId ?? '',
      ...(o.spiderX ? { spiderX: o.spiderX } : {})
    }
  } else if (o.security === 'tls') {
    s.security = 'tls'
    s.tlsSettings = {
      serverName: o.serverName ?? o.host ?? o.server,
      fingerprint: o.fingerprint ?? 'chrome'
    }
  } else {
    s.security = 'none'
  }

  if (network === 'ws') {
    s.wsSettings = { path: o.path ?? '/', ...(o.host ? { host: o.host } : {}) }
  } else if (network === 'grpc') {
    s.grpcSettings = { serviceName: o.path ?? '' }
  }
  return s
}

/** Xray VLESS outbound for one subscription node. */
export function buildXrayOutbound(o: OutboundConfig, pinned = false): Record<string, unknown> {
  if (!isXrayHandled(o)) throw new Error(`xray: unsupported protocol ${o.protocol}`)
  const user: Record<string, unknown> = {
    id: o.uuid ?? '',
    encryption: o.encryption ?? 'none'
  }
  if (o.flow) user.flow = o.flow
  return {
    tag: outTag(o.id),
    protocol: 'vless',
    settings: { vnext: [{ address: o.server, port: o.port, users: [user] }] },
    streamSettings: {
      ...streamSettings(o),
      // resolve the node through dns.hosts (the IPs pinned before start)
      // instead of the system resolver; SNI / Host stay the domain
      ...(pinned ? { sockopt: { domainStrategy: 'UseIP' } } : {})
    }
  }
}

/**
 * dns.hosts for xray: node domain → its pre-resolved IPs. One address family
 * only (IPv4 if there is any): xray picks a random address from the list and
 * an IPv6 pick on a machine without IPv6 would just fail.
 */
export function xrayHosts(nodes: OutboundConfig[], ips: ServerIps): Record<string, string[]> {
  const hosts: Record<string, string[]> = {}
  for (const o of nodes) {
    const h = normalizeHost(o.server)
    if (!h || isIP(h) || hosts[o.server]) continue
    const list = ips[h] ?? []
    const v4 = list.filter((ip) => isIP(ip) === 4)
    const pick = v4.length ? v4 : list.filter((ip) => isIP(ip) === 6)
    if (pick.length) hosts[o.server] = pick
  }
  return hosts
}

export interface XrayGenOptions {
  /** resolved node IPs (see system/resolve.ts); empty = xray resolves itself */
  serverIps?: ServerIps
}

export function generateXrayConfig(bridges: XrayBridge[], opts: XrayGenOptions = {}): XrayConfig {
  const hosts = xrayHosts(
    bridges.map((b) => b.outbound),
    opts.serverIps ?? {}
  )
  return {
    // Always `info`: at warning level `REALITY: received real certificate` can't be
    // traced to a node — only `taking detour [out-<id>]` carries the id, with the
    // same session number. SidecarManager drops info lines from «Журнал» unless
    // «Подробный журнал» is on.
    log: { loglevel: 'info', access: 'none' },
    ...(Object.keys(hosts).length ? { dns: { hosts } } : {}),
    inbounds: bridges.map((b) => ({
      tag: inTag(b.outbound.id),
      listen: '127.0.0.1',
      port: b.port,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: true, ip: '127.0.0.1' }
    })),
    outbounds: [
      // first outbound = xray's default: anything unmatched is dropped
      { tag: XRAY_BLOCK_TAG, protocol: 'blackhole' },
      ...bridges.map((b) => buildXrayOutbound(b.outbound, !!hosts[b.outbound.server]))
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: bridges.map((b) => ({
        type: 'field',
        inboundTag: [inTag(b.outbound.id)],
        outboundTag: outTag(b.outbound.id)
      }))
    }
  }
}
