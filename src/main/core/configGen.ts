import type { AppSettings, OutboundConfig, RulesConfig } from '@shared/types'
import { compileRules } from '../rules/compile'
import { TAG_DIRECT, type SbConfig, type SbInbound, type SbOutbound } from './sbTypes'

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
}

/** Build a sing-box outbound from a parsed subscription profile. */
export function buildOutbound(o: OutboundConfig): SbOutbound {
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

  if (o.protocol === 'vmess') {
    return {
      type: 'vmess',
      tag: o.id,
      server: o.server,
      server_port: o.port,
      uuid: o.uuid ?? '',
      security: 'auto',
      ...(o.security === 'tls'
        ? { tls: { enabled: true, server_name: o.serverName ?? o.server } }
        : {})
    }
  }

  // vless (+ reality / tls / flow)
  const ob: SbOutbound = {
    type: 'vless',
    tag: o.id,
    server: o.server,
    server_port: o.port,
    uuid: o.uuid ?? '',
    flow: o.flow ?? ''
  }
  if (o.security === 'reality') {
    ob.tls = {
      enabled: true,
      server_name: o.serverName ?? '',
      utls: { enabled: true, fingerprint: o.fingerprint ?? 'chrome' },
      reality: {
        enabled: true,
        public_key: o.publicKey ?? '',
        short_id: o.shortId ?? ''
      }
    }
  } else if (o.security === 'tls') {
    ob.tls = {
      enabled: true,
      server_name: o.serverName ?? o.host ?? o.server,
      utls: { enabled: true, fingerprint: o.fingerprint ?? 'chrome' }
    }
  }
  // transport (ws / grpc)
  if (o.network === 'ws') {
    ob.transport = { type: 'ws', path: o.path ?? '/', headers: o.host ? { Host: o.host } : undefined }
  } else if (o.network === 'grpc') {
    ob.transport = { type: 'grpc', service_name: o.path ?? '' }
  }
  return ob
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
  const proxyOutbounds = p.outbounds.map(buildOutbound)

  const geositeTags = ruleSets.filter((r) => r.tag.startsWith('geosite-')).map((r) => r.tag)

  return {
    log: { level: 'info', output: p.logFile, timestamp: true },
    // new (1.12+) typed DNS server format
    dns: {
      servers: [
        { type: 'https', tag: 'remote', server: '1.1.1.1', detour: final },
        { type: 'https', tag: 'local', server: '77.88.8.8', detour: TAG_DIRECT }
      ],
      // resolve geosite-matched (local) domains via the local resolver
      rules: geositeTags.length ? [{ rule_set: geositeTags, server: 'local' }] : [],
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
      // sniff first (protocol/domain detection), hijack DNS in TUN mode, then
      // the user's compiled rules. sing-box applies first-match-wins.
      rules: [
        { action: 'sniff' },
        ...(p.settings.proxyMode === 'tun'
          ? [{ protocol: ['dns'], action: 'hijack-dns' as const }]
          : []),
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
