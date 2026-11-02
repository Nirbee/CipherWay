import type { AppSettings, OutboundConfig, RulesConfig } from '@shared/types'
import { compileRules } from '../rules/compile'
import { TAG_DIRECT, type SbConfig, type SbInbound, type SbOutbound, type SbRouteRule } from './sbTypes'
import { isXrayHandled, XRAY_EXE } from './xrayGen'

export interface GenParams {
  outbounds: OutboundConfig[]
  activeOutboundId: string | undefined
  rules: RulesConfig
  settings: AppSettings
  /** local ports */
  socksPort: number
  httpPort: number
  clashApiPort: number
  logFile: string
  cacheFile: string
  /** outbound id -> loopback SOCKS port of its xray inbound (VLESS nodes) */
  xrayPorts: Record<string, number>
}

/**
 * Build a sing-box outbound from a parsed subscription profile.
 *  - VLESS is carried by xray: sing-box gets a `socks` outbound pointing at the
 *    node's loopback xray inbound (`xrayPort` is required).
 *  - Hysteria2 / VMess stay native in sing-box.
 */
export function buildOutbound(o: OutboundConfig, xrayPort?: number): SbOutbound {
  if (isXrayHandled(o)) {
    if (!xrayPort) throw new Error(`no xray bridge port for ${o.id}`)
    return {
      type: 'socks',
      tag: o.id,
      server: '127.0.0.1',
      server_port: xrayPort,
      version: '5'
    }
  }

  if (o.protocol === 'hysteria2') {
    const ob: SbOutbound = {
      type: 'hysteria2',
      tag: o.id,
      server: o.server,
      server_port: o.port,
      password: o.password ?? '',
      tls: {
        enabled: true,
        server_name: o.sni ?? o.server,
        insecure: o.insecure ?? false
      }
    }
    if (o.obfs) {
      ob.obfs = { type: o.obfs, password: o.obfsPassword ?? '' }
    }
    return ob
  }

  // vmess
  return {
    type: 'vmess',
    tag: o.id,
    server: o.server,
    server_port: o.port,
    uuid: o.uuid ?? '',
    security: 'auto',
    ...(o.security === 'tls' ? { tls: { enabled: true, server_name: o.serverName ?? o.server } } : {})
  }
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/** Node hostnames (not IP literals) — resolved directly, never via the tunnel. */
export function serverDomains(outbounds: OutboundConfig[]): string[] {
  const set = new Set<string>()
  for (const o of outbounds) {
    const h = o.server.trim().toLowerCase()
    if (!h || IPV4_RE.test(h) || h.includes(':')) continue
    set.add(h)
  }
  return [...set]
}

function inbounds(p: GenParams): SbInbound[] {
  if (p.settings.proxyMode === 'tun') {
    return [
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: 'CipherWay',
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        mtu: 9000,
        auto_route: true,
        strict_route: true,
        stack: 'system'
      }
    ]
  }
  // system-proxy mode: a local mixed (socks+http) inbound
  return [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: p.httpPort }]
}

export function generateSingboxConfig(p: GenParams): SbConfig {
  const { rules, ruleSets, final } = compileRules(p.rules, p.outbounds, p.activeOutboundId)
  const proxyOutbounds = p.outbounds.map((o) => buildOutbound(o, p.xrayPorts[o.id]))
  const tun = p.settings.proxyMode === 'tun'

  const geositeTags = ruleSets.filter((r) => r.tag.startsWith('geosite-')).map((r) => r.tag)
  const nodeDomains = serverDomains(p.outbounds)

  // Loop protection in TUN mode: xray.exe dials the nodes itself, and with
  // auto_route + strict_route its sockets land in our TUN. Send them straight
  // out (sing-box binds `direct` to the physical NIC via auto_detect_interface).
  // Node hostnames are resolved by the local (direct) DNS server so the first
  // lookup doesn't depend on the tunnel that is being brought up.
  const loopGuard: SbRouteRule[] = tun
    ? [{ process_name: [XRAY_EXE], action: 'route', outbound: TAG_DIRECT }]
    : []

  return {
    log: { level: 'info', output: p.logFile, timestamp: true },
    // new (1.12+) typed DNS server format
    dns: {
      servers: [
        // sing-box 1.12+ refuses to *start* (check passes!) with an explicit
        // detour to an empty direct outbound — omit it, direct is the default
        {
          type: 'https',
          tag: 'remote',
          server: '1.1.1.1',
          ...(final !== TAG_DIRECT ? { detour: final } : {})
        },
        { type: 'https', tag: 'local', server: '77.88.8.8' }
      ],
      rules: [
        ...(nodeDomains.length ? [{ domain: nodeDomains, server: 'local' }] : []),
        // resolve geosite-matched (local) domains via the local resolver
        ...(geositeTags.length ? [{ rule_set: geositeTags, server: 'local' }] : [])
      ],
      final: 'remote',
      strategy: 'ipv4_only'
    },
    experimental: {
      clash_api: { external_controller: `127.0.0.1:${p.clashApiPort}`, default_mode: 'rule' },
      cache_file: { enabled: true, path: p.cacheFile }
    },
    inbounds: inbounds(p),
    outbounds: [...proxyOutbounds, { type: 'direct', tag: TAG_DIRECT }],
    route: {
      // xray loop guard first, then sniff (protocol/domain detection), hijack
      // DNS in TUN mode, then the user's compiled rules (first match wins).
      rules: [
        ...loopGuard,
        { action: 'sniff' },
        ...(tun ? [{ protocol: ['dns'], action: 'hijack-dns' as const }] : []),
        ...rules
      ],
      rule_set: ruleSets,
      final,
      auto_detect_interface: true,
      // resolve outbound server domains via the local DNS server (1.12+)
      default_domain_resolver: { server: 'local' }
    }
  }
}
