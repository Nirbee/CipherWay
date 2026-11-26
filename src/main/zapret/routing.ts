import type { ZapretServiceId, ZapretSettings } from '@shared/zapret'
import type { HeadlessRule, ZapretRouting } from '../rules/compile'
import { NO_ZAPRET } from '../rules/compile'
import { SERVICE_DEFS, YOUTUBE_VIDEO_DOMAINS } from './lists'

// ---------------------------------------------------------------------------
// Which domains / addresses of «Ускорение без VPN» go direct and which go back
// through the VPN — from the last check of every item. An item not confirmed
// to open directly (not checked yet, or failed) goes through the VPN: never
// direct on a guess. Pure — unit tested in routing.test.ts.
//
// 0.7.2 — by protocol. YouTube is three route keys checked apart:
//   youtube        its pages etc. over TCP (every domain but googlevideo.com)
//   youtube:video  the video nodes over TCP (googlevideo.com)
//   youtube:quic   QUIC (UDP) to every YouTube domain
// so «video over QUIC direct, TCP through the VPN» is two headless rules with
// `network`. And the more specific domain always wins: a direct domain whose
// subdomain goes through the VPN gets that subdomain cut out (a logical rule),
// cw-z-d being matched first; a VPN domain whose subdomain is direct needs
// nothing (the direct set is matched first).
// ---------------------------------------------------------------------------

export const customKey = (domain: string): string => `d:${domain}`

export type Net = 'tcp' | 'udp'
const NETS: readonly Net[] = ['tcp', 'udp']

/** the YouTube route keys (the item «youtube» of the screen = all three) */
export const YT_PAGES = 'youtube'
export const YT_VIDEO = 'youtube:video'
export const YT_QUIC = 'youtube:quic'

export interface RouteEntry {
  domains: readonly string[]
  /** undefined = TCP and UDP */
  net?: Net
  cidrs?: readonly string[]
}

/** The route keys of one item of the screen (a service id or customKey(domain)). */
export function routeKeysOf(item: string): string[] {
  return item === 'youtube' ? [YT_PAGES, YT_VIDEO, YT_QUIC] : [item]
}

/** What one route key covers. */
export function routeEntries(key: string): RouteEntry[] {
  if (key.startsWith('d:')) return [{ domains: [key.slice(2)] }]
  const yt = SERVICE_DEFS.youtube.domains
  const video = new Set(YOUTUBE_VIDEO_DOMAINS)
  if (key === YT_PAGES) return [{ domains: yt.filter((d) => !video.has(d)), net: 'tcp' }]
  if (key === YT_VIDEO) return [{ domains: [...YOUTUBE_VIDEO_DOMAINS], net: 'tcp' }]
  if (key === YT_QUIC) return [{ domains: [...yt], net: 'udp' }]
  const def = SERVICE_DEFS[key as ZapretServiceId]
  if (!def) return []
  return [{ domains: [...def.domains], cidrs: [...def.cidrs] }]
}

/** The rules of one route key (tests, readability). */
export function itemRules(key: string): HeadlessRule[] {
  return build(routeEntries(key), [])
}

/** Every item the settings switch on, services first (the screen's items). */
export function itemKeys(s: ZapretSettings): string[] {
  return [...s.services, ...s.custom.map(customKey)]
}

/** Every route key of the settings. */
export function routeKeys(s: ZapretSettings): string[] {
  return itemKeys(s).flatMap(routeKeysOf)
}

const under = (host: string, d: string): boolean => host === d || host.endsWith(`.${d}`)

/** domain → the networks it has in a set */
function netsOf(entries: RouteEntry[]): Map<string, Set<Net>> {
  const m = new Map<string, Set<Net>>()
  for (const e of entries) {
    for (const d of e.domains) {
      let s = m.get(d)
      if (!s) m.set(d, (s = new Set()))
      for (const n of e.net ? [e.net] : NETS) s.add(n)
    }
  }
  return m
}

const netRule = (nets: Set<Net>): HeadlessRule =>
  nets.size === 1 ? { network: [...nets] } : {}

/**
 * Headless rules of a set: domains grouped by network (one rule per group),
 * one ip_cidr rule; `others` = the other set — its strict subdomains of a
 * domain here (on a shared network) are cut out of that domain.
 */
function build(entries: RouteEntry[], others: RouteEntry[]): HeadlessRule[] {
  const mine = netsOf(entries)
  const theirs = netsOf(others)
  const groups = new Map<string, { nets: Set<Net>; domains: string[] }>()
  const logical: HeadlessRule[] = []
  for (const [d, nets] of mine) {
    const cut = [...theirs].filter(
      ([o, on]) => o !== d && under(o, d) && [...on].some((n) => nets.has(n))
    )
    if (cut.length) {
      logical.push({
        type: 'logical',
        mode: 'and',
        rules: [
          { domain_suffix: [d], ...netRule(nets) },
          { domain_suffix: cut.map(([o]) => o), invert: true }
        ]
      })
      continue
    }
    const k = [...nets].sort().join(',')
    let g = groups.get(k)
    if (!g) groups.set(k, (g = { nets, domains: [] }))
    g.domains.push(d)
  }
  const cidrs: string[] = []
  for (const e of entries) for (const c of e.cidrs ?? []) if (!cidrs.includes(c)) cidrs.push(c)
  const order = ['tcp,udp', 'tcp', 'udp']
  return [
    ...order.flatMap((k) => {
      const g = groups.get(k)
      return g ? [{ domain_suffix: g.domains, ...netRule(g.nets) }] : []
    }),
    ...logical,
    ...(cidrs.length ? [{ ip_cidr: cidrs }] : [])
  ]
}

/**
 * The zapret rule-sets: `direct` = the route keys confirmed to open directly,
 * the rest of the switched-on items through the VPN. Off → empty sets.
 */
export function zapretRouting(
  s: ZapretSettings,
  direct: ReadonlySet<string>,
  dns: 'primary' | 'fallback'
): ZapretRouting {
  if (!s.enabled) return NO_ZAPRET
  const d: RouteEntry[] = []
  const p: RouteEntry[] = []
  for (const key of routeKeys(s)) (direct.has(key) ? d : p).push(...routeEntries(key))
  return { direct: build(d, p), proxy: build(p, []), dns }
}

/** the domains of a rule (a logical rule: its first part) */
function ruleDomains(x: HeadlessRule): string[] {
  if (x.type === 'logical') {
    const first = (x.rules as HeadlessRule[] | undefined)?.[0]
    return first ? ruleDomains(first) : []
  }
  return (x.domain_suffix as string[] | undefined) ?? []
}

function ruleNets(x: HeadlessRule): Net[] {
  if (x.type === 'logical') {
    const first = (x.rules as HeadlessRule[] | undefined)?.[0]
    return first ? ruleNets(first) : [...NETS]
  }
  return ((x.network as Net[] | undefined) ?? [...NETS]).filter((n) => NETS.includes(n))
}

/** Every domain of the zapret items. */
export function routingDomains(r: ZapretRouting): string[] {
  const out: string[] = []
  for (const x of [...r.direct, ...r.proxy]) {
    for (const d of ruleDomains(x)) if (!out.includes(d)) out.push(d)
  }
  return out
}

/** `domain|net` → 'd' / 'p' */
function sides(r: ZapretRouting): Map<string, string> {
  const m = new Map<string, string>()
  for (const [rules, side] of [
    [r.proxy, 'p'],
    [r.direct, 'd']
  ] as const) {
    for (const x of rules) {
      for (const d of ruleDomains(x)) for (const n of ruleNets(x)) m.set(`${d}|${n}`, side)
    }
  }
  return m
}

const cidrSides = (r: ZapretRouting): Map<string, string> => {
  const m = new Map<string, string>()
  for (const x of r.direct) for (const c of (x.ip_cidr as string[] | undefined) ?? []) m.set(c, 'd')
  for (const x of r.proxy) for (const c of (x.ip_cidr as string[] | undefined) ?? []) m.set(c, 'p')
  return m
}

export interface RoutingChange {
  /** domains whose way changed on some network */
  domains: string[]
  /** an address range moved (the zapret connections without a domain) */
  cidrs: boolean
  /**
   * Is an open connection affected (closed so it reconnects the new way)?
   * Only when the MOST SPECIFIC zapret domain of its host changed its way on
   * its network: a ✓ subdomain is never cut off because its parent moved.
   */
  affects: (host: string, network: string, rule: string) => boolean
}

/** what changed its way between two sets */
export function routingChange(prev: ZapretRouting, next: ZapretRouting): RoutingChange {
  const a = sides(prev)
  const b = sides(next)
  const changed = new Set(
    [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k))
  )
  const domains = [...new Set([...changed].map((k) => k.split('|')[0]))]
  const ca = cidrSides(prev)
  const cb = cidrSides(next)
  const cidrs = [...new Set([...ca.keys(), ...cb.keys()])].some((k) => ca.get(k) !== cb.get(k))
  const all = [...new Set([...routingDomains(prev), ...routingDomains(next)])]
  return {
    domains,
    cidrs,
    affects: (rawHost, network, rule) => {
      const host = rawHost.toLowerCase()
      if (!host) return cidrs && /rule_set=\[?cw-z-/.test(rule)
      let best = ''
      for (const d of all) if (under(host, d) && d.length > best.length) best = d
      if (!best) return false
      const n: Net = network === 'udp' ? 'udp' : 'tcp'
      return changed.has(`${best}|${n}`)
    }
  }
}

/**
 * Which route key a connection belongs to (the live fallback): the most
 * specific switched-on domain of its host, then its network.
 */
export function routeKeyOf(s: ZapretSettings, rawHost: string, network: string): string | null {
  const host = rawHost.toLowerCase()
  if (!host) return null
  const n: Net = network === 'udp' ? 'udp' : 'tcp'
  let best: { key: string; len: number } | null = null
  for (const key of routeKeys(s)) {
    for (const e of routeEntries(key)) {
      if (e.net && e.net !== n) continue
      for (const d of e.domains) {
        if (under(host, d) && (!best || d.length > best.len)) best = { key, len: d.length }
      }
    }
  }
  return best?.key ?? null
}
