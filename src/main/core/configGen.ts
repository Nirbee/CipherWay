import { AUTO_OUTBOUND_ID, type AppSettings, type OutboundConfig } from '@shared/types'
import {
  ruleSkeleton,
  SLOT_DNS,
  SLOT_FINAL,
  ZAPRET_DNS_SERVER,
  ZAPRET_DNS_SERVER2
} from '../rules/compile'
import {
  CLASH_MODE,
  LATENCY_URL,
  TAG_AUTO,
  TAG_DIRECT,
  TAG_PROXY_GROUP,
  type SbConfig,
  type SbInbound,
  type SbOutbound,
  type SbRouteRule
} from './sbTypes'
import { isXrayHandled } from './xrayGen'
import { LAN_CIDR4, LAN_CIDR6, LAN_LOGIN_HOST, TUN_INTERFACE, XRAY_EXE } from './coreNames'
import { toExcludeCidrs, type ServerIps } from '../system/resolve'

export { TUN_INTERFACE }
export const TUN_ADDRESS4 = '172.19.0.1'
/** the TUN's IPv6 half — left out when IPv6 is off in Windows (GenParams.ipv4Only) */
export const TUN_PREFIX6 = 'fdfe:dcba:9876::1/126'

export interface SlotParams {
  /** number of slot groups (rules/compile.ts groupsFor) */
  groups: number
  /** absolute directory the core reads the slot rule-sets from */
  dir: string
  /** RuleLayout.selectors — initial choices of cw-<g> / cw-final / cw-dns */
  selectors: Record<string, string>
}

export interface GenParams {
  outbounds: OutboundConfig[]
  /** node id or AUTO_OUTBOUND_ID — the `proxy` selector's default */
  activeOutboundId: string | undefined
  /** the user's rules, laid out into slots (see rules/compile.ts) */
  slots: SlotParams
  settings: AppSettings
  /** local ports */
  socksPort: number
  httpPort: number
  clashApiPort: number
  /** clash_api.secret (random per start) */
  clashSecret?: string
  logFile: string
  /** outbound id -> loopback SOCKS port of its xray inbound (VLESS nodes) */
  xrayPorts: Record<string, number>
  /** node host -> IPs resolved before start (TUN: excluded from the routes) */
  serverIps?: ServerIps
  /** last measured latency per node id (null = no answer) — urltest order */
  latencies?: Record<string, number | null | undefined>
  /**
   * hosts the app itself must reach outside the tunnel in every mode (the
   * subscription server: its refresh is what repairs a broken tunnel)
   */
  directHosts?: string[]
  /**
   * TUN without its IPv6 half: IPv6 is switched off in Windows and sing-box
   * would die on «set ipv6 address: Element not found» (system/ipv6.ts, 0.4.6)
   */
  ipv4Only?: boolean
  /** «LAN» is switched on: its bypass rules (lanRules) go into the config */
  lan?: LanBypass
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
    ...(o.security === 'tls'
      ? { tls: { enabled: true, server_name: o.serverName ?? o.server } }
      : {})
  }
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Route rules for hosts that always go direct (see GenParams.directHosts):
 * domains by name (sniffed SNI / Host), IP literals by address. Matchers of
 * different kinds in one sing-box rule are AND-ed — so one rule per kind.
 */
export function directHostRules(hosts: string[] = []): SbRouteRule[] {
  const domains = new Set<string>()
  const cidrs = new Set<string>()
  for (const raw of hosts) {
    const h = raw
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
    if (!h) continue
    if (IPV4_RE.test(h)) cidrs.add(`${h}/32`)
    else if (h.includes(':')) cidrs.add(`${h}/128`)
    else domains.add(h)
  }
  return [
    ...(domains.size
      ? [{ domain: [...domains], action: 'route' as const, outbound: TAG_DIRECT }]
      : []),
    ...(cidrs.size ? [{ ip_cidr: [...cidrs], action: 'route' as const, outbound: TAG_DIRECT }] : [])
  ]
}

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

/**
 * urltest members, best first: until its first check finishes sing-box sends
 * everything (DNS included) through the *first* member, so a dead node there
 * means 5–10 s of timeouts right after connecting. Order: answered (fastest
 * first) → never measured (subscription order) → no answer.
 */
export function orderByLatency(
  tags: string[],
  latencies: Record<string, number | null | undefined> = {}
): string[] {
  const rank = (t: string): number => {
    const v = latencies[t]
    return typeof v === 'number' ? 0 : v === null ? 2 : 1
  }
  return tags
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ra = rank(a.t)
      const rb = rank(b.t)
      if (ra !== rb) return ra - rb
      if (ra === 0) return (latencies[a.t] as number) - (latencies[b.t] as number) || a.i - b.i
      return a.i - b.i
    })
    .map((x) => x.t)
}

/**
 * «Лучший сервер (авто)» + the selector everything proxied goes through.
 * Switching servers = Clash API `PUT /proxies/proxy` (no core restart);
 * interrupt_exist_connections moves open connections to the new node at once.
 */
export function groupOutbounds(
  nodeTags: string[],
  activeOutboundId?: string,
  latencies?: Record<string, number | null | undefined>
): SbOutbound[] {
  const def =
    activeOutboundId &&
    (activeOutboundId === AUTO_OUTBOUND_ID || nodeTags.includes(activeOutboundId))
      ? activeOutboundId
      : TAG_AUTO
  return [
    {
      type: 'urltest',
      tag: TAG_AUTO,
      outbounds: orderByLatency(nodeTags, latencies),
      url: LATENCY_URL,
      interval: '5m',
      tolerance: 50,
      idle_timeout: '30m',
      interrupt_exist_connections: false
    },
    {
      type: 'selector',
      tag: TAG_PROXY_GROUP,
      outbounds: [TAG_AUTO, ...nodeTags],
      default: def,
      interrupt_exist_connections: true
    }
  ]
}

export interface LanBypass {
  /**
   * full path of the daemon the service runs: %ProgramData%\CipherWay\bin\cipherway-lan.exe
   * (process_path, not the bare file name: any program can call itself that)
   */
  exePath: string
  /** host of the login server (Headscale, from the bot); LAN_LOGIN_HOST if unknown */
  loginHost?: string
}

/**
 * «LAN» (0.5.0) next to the VPN — only while LAN is switched on (the app rebuilds
 * the config when it is toggled), then in every proxy mode and routing mode:
 *  - the virtual LAN (100.64.0.0/10, fd7a:115c:a1e0::/48) never enters our
 *    TUN (route_exclude_address) — the LAN daemon's own adapter routes it; a
 *    connection that still reaches sing-box (system proxy: a browser opening
 *    http://100.x…) goes direct, i.e. to that adapter;
 *  - the daemon's own traffic (control server, relay, peer-to-peer UDP from
 *    its fixed port) goes direct — through the VPN, peers could not reach it
 *    directly and every game packet would make a detour via the VPN node;
 *  - the login server (Headscale) is direct and resolved directly.
 * Placed before sniff and the routing-mode switch: «Весь трафик через VPN»
 * doesn't take it either.
 */
export const LAN_ROUTE_EXCLUDE = [LAN_CIDR4, LAN_CIDR6]

export function lanRules(lan: LanBypass): SbRouteRule[] {
  return [
    { process_path: [lan.exePath], action: 'route', outbound: TAG_DIRECT },
    { ip_cidr: [...LAN_ROUTE_EXCLUDE], action: 'route', outbound: TAG_DIRECT }
  ]
}

function inbounds(p: GenParams): SbInbound[] {
  if (p.settings.proxyMode === 'tun') {
    // the node IPs get no TUN route: cipherway-xray.exe's connections to them leave via
    // the physical NIC directly instead of looping through sing-box; nor does the LAN.
    // IPv4-only: no IPv6 address → no IPv6 routes either; IPv6 excludes are dropped
    // too (nothing to carve them out of) — the LAN's fd7a::/48 included
    const exclude = [
      ...toExcludeCidrs(p.serverIps ?? {}),
      ...(p.lan ? LAN_ROUTE_EXCLUDE : [])
    ].filter((c) => !p.ipv4Only || !c.includes(':'))
    return [
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: TUN_INTERFACE,
        address: p.ipv4Only ? [`${TUN_ADDRESS4}/30`] : [`${TUN_ADDRESS4}/30`, TUN_PREFIX6],
        mtu: 9000,
        auto_route: true,
        strict_route: true,
        stack: 'system',
        ...(exclude.length ? { route_exclude_address: exclude } : {})
      }
    ]
  }
  // system-proxy mode: a local mixed (socks+http) inbound
  return [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: p.httpPort }]
}

/**
 * Routing-mode switch, evaluated before the user's rules:
 *  Direct → everything direct, Global → everything via the selector.
 * LAN always stays direct (printers, router page, NAS).
 */
export const MODE_RULES: SbRouteRule[] = [
  { ip_is_private: true, action: 'route', outbound: TAG_DIRECT },
  { clash_mode: CLASH_MODE.direct, action: 'route', outbound: TAG_DIRECT },
  { clash_mode: CLASH_MODE.global, action: 'route', outbound: TAG_PROXY_GROUP }
]

/**
 * Last route rule: in the «Правила» mode whatever no slot matched goes to
 * cw-final — exactly what route.final does. It exists for the Clash API:
 * sing-box (checked on 1.13.14) accepts only the modes named in some rule's
 * clash_mode plus default_mode. A core started in «Весь трафик» knew only
 * Global / Direct, and `PATCH /configs {mode: Rule}` answered 204 and changed
 * nothing — the core stayed in Global while the app showed «По правилам» (0.4.5).
 */
export const RULE_MODE_TAIL: SbRouteRule = {
  clash_mode: CLASH_MODE.rule,
  action: 'route',
  outbound: SLOT_FINAL
}

export function generateSingboxConfig(p: GenParams): SbConfig {
  const nodeTags = p.outbounds.map((o) => o.id)
  const slots = ruleSkeleton(p.slots.groups, p.slots.dir, nodeTags, p.slots.selectors)
  const proxyOutbounds = p.outbounds.map((o) => buildOutbound(o, p.xrayPorts[o.id]))
  const tun = p.settings.proxyMode === 'tun'
  const nodeDomains = serverDomains(p.outbounds)
  // the subscription server and the LAN login server: direct and resolved
  // directly in every mode
  // the login host: a rule of its own — «Подключения» names exactly the host matched
  const lanHost = p.lan ? (p.lan.loginHost || LAN_LOGIN_HOST).trim().toLowerCase() : ''
  const directRules = [
    ...directHostRules(p.directHosts),
    ...(lanHost ? [{ domain: [lanHost], action: 'route' as const, outbound: TAG_DIRECT }] : [])
  ]
  const localDomains = [...new Set([...nodeDomains, ...directRules.flatMap((r) => r.domain ?? [])])]

  // Loop protection in TUN mode: cipherway-xray.exe dials the nodes itself. Normally its
  // sockets never reach the TUN (node IPs are in route_exclude_address); if a
  // node's IP changed after the pre-start lookup they would — send them
  // straight out (sing-box binds `direct` to the physical NIC via
  // auto_detect_interface). Node hostnames are resolved by the local (direct)
  // DNS server so the first lookup doesn't depend on the tunnel.
  const loopGuard: SbRouteRule[] = tun
    ? [{ process_name: [XRAY_EXE], action: 'route', outbound: TAG_DIRECT }]
    : []

  return {
    // warn by default: info prints a line per connection (thousands a minute)
    log: { level: p.settings.verboseLog ? 'info' : 'warn', output: p.logFile, timestamp: true },
    // new (1.12+) typed DNS server format
    dns: {
      servers: [
        // detour = the cw-dns selector: the tunnel, or direct when «Всё
        // остальное» is direct (sing-box 1.12+ refuses to *start* with an
        // explicit detour to an empty direct outbound — a selector is fine)
        { type: 'https', tag: 'remote', server: '1.1.1.1', detour: SLOT_DNS },
        { type: 'https', tag: 'local', server: '77.88.8.8' },
        // «Ускорение без VPN»: its direct domains, never the provider's DNS (a stub
        // page) — DoH straight to Google, Cloudflare as the fallback (compile.ts)
        { type: 'https', tag: ZAPRET_DNS_SERVER, server: '8.8.8.8' },
        { type: 'https', tag: ZAPRET_DNS_SERVER2, server: '1.1.1.1' }
      ],
      rules: [
        ...(localDomains.length ? [{ domain: localDomains, server: 'local' }] : []),
        // «Напрямую»: nothing goes through the tunnel, DNS included
        { clash_mode: CLASH_MODE.direct, server: 'local' },
        { clash_mode: CLASH_MODE.global, server: 'remote' },
        // the user's rules, same order: «напрямую» domains via the local
        // resolver, «через VPN» ones via the tunnel
        ...slots.dnsRules
      ],
      final: 'remote',
      strategy: 'ipv4_only'
    },
    // no cache_file: it would bring back the mode / selector choices of the
    // previous run for the first seconds after start (Telegram's reconnect
    // burst went «direct» there) — the config defaults are always current
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${p.clashApiPort}`,
        default_mode: CLASH_MODE[p.settings.routingMode] ?? CLASH_MODE.rule,
        ...(p.clashSecret ? { secret: p.clashSecret } : {})
      }
    },
    inbounds: inbounds(p),
    outbounds: [
      ...proxyOutbounds,
      ...groupOutbounds(nodeTags, p.activeOutboundId, p.latencies),
      ...slots.outbounds,
      { type: 'direct', tag: TAG_DIRECT }
    ],
    route: {
      // xray loop guard first, then sniff (protocol/domain detection), hijack
      // DNS in TUN mode, the routing-mode switch, then the user's rules in
      // their slots (first match wins).
      rules: [
        ...loopGuard,
        ...(p.lan ? lanRules(p.lan) : []),
        { action: 'sniff' },
        ...(tun ? [{ protocol: ['dns'], action: 'hijack-dns' as const }] : []),
        ...directRules,
        ...MODE_RULES,
        ...slots.routeRules,
        RULE_MODE_TAIL
      ],
      rule_set: slots.ruleSets,
      final: SLOT_FINAL,
      auto_detect_interface: true,
      // owning process for every connection → «Подключения» screen (works in
      // both TUN and system-proxy mode on Windows) + process rules
      find_process: true,
      // resolve outbound server domains via the local DNS server (1.12+)
      default_domain_resolver: { server: 'local' }
    }
  }
}

export interface ProbeParams {
  outbounds: OutboundConfig[]
  clashApiPort: number
  /** clash_api.secret (random per probe) */
  clashSecret?: string
  logFile: string
  xrayPorts: Record<string, number>
  /**
   * node id → loopback port of its own SOCKS5 test inbound (the keepalive ping,
   * core/latency.ts) — for the nodes sing-box carries itself (Hysteria2, VMess);
   * VLESS nodes are tested through their xray inbound
   */
  testPorts?: Record<string, number>
  /** RFC 1929 user/password of the test inbounds (random per probe) */
  testAuth?: { username: string; password: string }
}

export const PING_INBOUND_PREFIX = 'ping-'

/**
 * Throw-away instance for the latency test (while the VPN is off — and, for the
 * keepalive ping of Hysteria2 / VMess nodes, also while it is on): no TUN, no
 * system proxy. Only the nodes, the Clash API to call `/proxies/<id>/delay` on,
 * and per node an optional SOCKS5 test inbound on 127.0.0.1 (random port, with a
 * random password) routed to exactly that node. Nothing on the machine is
 * routed through it; the user's own core and its config are not touched (the
 * TUN service's allow-list — `inbound = tun only` — never sees this config).
 */
export function generateProbeConfig(p: ProbeParams): SbConfig {
  const ids = new Set(p.outbounds.map((o) => o.id))
  const tests = Object.entries(p.testPorts ?? {}).filter(([id]) => ids.has(id))
  return {
    log: { level: 'warn', output: p.logFile, timestamp: true },
    dns: {
      servers: [{ type: 'https', tag: 'local', server: '77.88.8.8' }],
      final: 'local',
      strategy: 'ipv4_only'
    },
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${p.clashApiPort}`,
        ...(p.clashSecret ? { secret: p.clashSecret } : {})
      }
    },
    inbounds: tests.map(([id, port]) => ({
      type: 'socks',
      tag: `${PING_INBOUND_PREFIX}${id}`,
      listen: '127.0.0.1',
      listen_port: port,
      ...(p.testAuth ? { users: [p.testAuth] } : {})
    })),
    outbounds: [
      ...p.outbounds.map((o) => buildOutbound(o, p.xrayPorts[o.id])),
      { type: 'direct', tag: TAG_DIRECT }
    ],
    route: {
      // one rule per test inbound: it reaches its own node and nothing else
      rules: tests.map(([id]) => ({
        inbound: [`${PING_INBOUND_PREFIX}${id}`],
        action: 'route' as const,
        outbound: id
      })),
      final: TAG_DIRECT,
      auto_detect_interface: true,
      default_domain_resolver: { server: 'local' }
    }
  }
}
