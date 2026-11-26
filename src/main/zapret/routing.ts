import type { ZapretServiceId, ZapretSettings } from '@shared/zapret'
import type { HeadlessRule, ZapretRouting } from '../rules/compile'
import { NO_ZAPRET } from '../rules/compile'
import { SERVICE_DEFS } from './lists'

// ---------------------------------------------------------------------------
// Which domains / addresses of «Ускорение без VPN» go direct and which go back
// through the VPN — from the last check of every item. An item not confirmed
// to open directly (not checked yet, or failed) goes through the VPN: never
// direct on a guess. Pure — unit tested in routing.test.ts.
// ---------------------------------------------------------------------------

export const customKey = (domain: string): string => `d:${domain}`

/** The rules of one item (a service id or customKey(domain)). */
export function itemRules(key: string): HeadlessRule[] {
  if (key.startsWith('d:')) return [{ domain_suffix: [key.slice(2)] }]
  const def = SERVICE_DEFS[key as ZapretServiceId]
  if (!def) return []
  return [
    { domain_suffix: [...def.domains] },
    ...(def.cidrs.length ? [{ ip_cidr: [...def.cidrs] }] : [])
  ]
}

/** Every item the settings switch on, services first. */
export function itemKeys(s: ZapretSettings): string[] {
  return [...s.services, ...s.custom.map(customKey)]
}

/** Two headless rules of the same kind are merged (fewer rules for sing-box to walk). */
function merge(rules: HeadlessRule[]): HeadlessRule[] {
  const domains: string[] = []
  const cidrs: string[] = []
  for (const r of rules) {
    for (const d of (r.domain_suffix as string[] | undefined) ?? []) {
      if (!domains.includes(d)) domains.push(d)
    }
    for (const c of (r.ip_cidr as string[] | undefined) ?? []) if (!cidrs.includes(c)) cidrs.push(c)
  }
  return [
    ...(domains.length ? [{ domain_suffix: domains }] : []),
    ...(cidrs.length ? [{ ip_cidr: cidrs }] : [])
  ]
}

/**
 * The zapret rule-sets: `direct` = the keys confirmed to open directly, the
 * rest of the switched-on items through the VPN. Off / no VPN → empty sets.
 */
export function zapretRouting(
  s: ZapretSettings,
  direct: ReadonlySet<string>,
  dns: 'primary' | 'fallback'
): ZapretRouting {
  if (!s.enabled) return NO_ZAPRET
  const d: HeadlessRule[] = []
  const p: HeadlessRule[] = []
  for (const key of itemKeys(s)) (direct.has(key) ? d : p).push(...itemRules(key))
  return { direct: merge(d), proxy: merge(p), dns }
}

/** Every domain of the zapret items (closing the connections that changed route). */
export function routingDomains(r: ZapretRouting): string[] {
  const out: string[] = []
  for (const x of [...r.direct, ...r.proxy]) out.push(...((x.domain_suffix as string[]) ?? []))
  return out
}

/** what changed its way between two sets: the domains, and whether any address range moved */
export function routingChange(
  prev: ZapretRouting,
  next: ZapretRouting
): { domains: string[]; cidrs: boolean } {
  const side = (r: ZapretRouting, key: 'domain_suffix' | 'ip_cidr'): Map<string, string> => {
    const m = new Map<string, string>()
    for (const x of r.direct) for (const v of (x[key] as string[] | undefined) ?? []) m.set(v, 'd')
    for (const x of r.proxy) for (const v of (x[key] as string[] | undefined) ?? []) m.set(v, 'p')
    return m
  }
  const diff = (a: Map<string, string>, b: Map<string, string>): string[] =>
    [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k))
  return {
    domains: diff(side(prev, 'domain_suffix'), side(next, 'domain_suffix')),
    cidrs: diff(side(prev, 'ip_cidr'), side(next, 'ip_cidr')).length > 0
  }
}
