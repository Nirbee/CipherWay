import { join } from 'node:path'
import type { OutboundConfig, RoutingRule, RulesConfig } from '@shared/types'
import { parsePortSpec } from '@shared/rulesText'
import {
  TAG_DIRECT,
  TAG_PROXY_GROUP,
  type SbOutbound,
  type SbRouteRule,
  type SbRuleSet
} from '../core/sbTypes'

// ---------------------------------------------------------------------------
// User rules → sing-box, changeable WITHOUT restarting the core (0.4.2).
//
// The config only holds a fixed skeleton: G groups of three slots
//   D  {rule_set: cw-<g>-d} → direct
//   P  {rule_set: cw-<g>-p} → selector cw-<g> (proxy / a fixed node)
//   X  {rule_set: cw-<g>-x} → reject
// Every rule-set is a *local source* file in our own directory; sing-box
// re-reads a local rule-set when the file changes (checked on 1.13.14,
// ~0.3 s), and the P selectors / `cw-final` are switched over the Clash API.
// Consecutive user rules with the same action form a «run»; runs are laid
// into the slot sequence D0 P0 X0 D1 P1 X1 … in order, so the first matching
// rule still wins (an unused slot holds an empty rule-set and never matches).
// G is chosen at start with spare room; only if the rules outgrow it the
// core is restarted.
// GEOSITE / GEOIP content is merged into the slot files (headless rules
// cannot reference other rule-sets): the .srs sets are downloaded and
// decompiled once (see geo.ts).
// DNS follows the same order: domains of D slots → local DNS, of P slots →
// the tunnel (cw-<g>-dn / cw-<g>-pn hold only the domain matchers).
// Pure — unit tested in compile.test.ts.
// ---------------------------------------------------------------------------

/** One rule of a sing-box rule-set (source format, «headless rule»). */
export type HeadlessRule = Record<string, unknown>

export type RunKind = 'direct' | 'proxy' | 'reject'

export interface RuleRun {
  kind: RunKind
  /** proxy runs: TAG_PROXY_GROUP (current server) or a node id */
  target: string
  rules: HeadlessRule[]
  /** geo rule-set tags (`geosite-x` / `geoip-x`) merged in at layout time */
  geo: string[]
  /** human-readable description for the «Подключения» screen */
  label: string
  /** PROCESS-NAME values of the run, as typed — «программа chrome.exe» per connection */
  programs: string[]
}

export interface RulePlan {
  runs: RuleRun[]
  /** route.final via the `cw-final` selector */
  final: typeof TAG_PROXY_GROUP | typeof TAG_DIRECT
  /** every geo tag the runs need */
  geo: string[]
}

export const SLOT_FINAL = 'cw-final'
/** detour of the remote DNS server: the tunnel, or direct when «Всё остальное» is direct */
export const SLOT_DNS = 'cw-dns'
const SLOT_KINDS: RunKind[] = ['direct', 'proxy', 'reject']
const KIND_LETTER: Record<RunKind, string> = { direct: 'd', proxy: 'p', reject: 'x' }
export const MIN_GROUPS = 8

/** LAN ranges (GEOIP,LAN / private) — headless rules have no ip_is_private. */
export const PRIVATE_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  '255.255.255.255/32',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8'
]

/**
 * Telegram's own address list (https://core.telegram.org/resources/cidr.txt,
 * checked 05.11.2026). SagerNet has no geoip-telegram set, so GEOIP,telegram
 * is built in. Telegram Desktop connects to these IPs without DNS — a domain
 * rule never sees them.
 */
export const TELEGRAM_CIDRS = [
  '91.105.192.0/23',
  '91.108.4.0/22',
  '91.108.8.0/22',
  '91.108.12.0/22',
  '91.108.16.0/22',
  '91.108.20.0/22',
  '91.108.56.0/22',
  '149.154.160.0/20',
  '185.76.151.0/24',
  '2001:67c:4e8::/48',
  '2001:b28:f23c::/48',
  '2001:b28:f23d::/48',
  '2001:b28:f23f::/48',
  '2a0a:f280::/32'
]

/** Built-in GEOIP codes that need no download. */
const BUILTIN_GEOIP: Record<string, string[]> = {
  private: PRIVATE_CIDRS,
  lan: PRIVATE_CIDRS,
  telegram: TELEGRAM_CIDRS
}

/** `443` → port, `8000-9000` → port_range; lists split by `/`, `|` or `,`. */
export function portMatcher(value: string): HeadlessRule | null {
  const spec = parsePortSpec(value)
  if (!spec) return null
  return {
    ...(spec.ports.length ? { port: spec.ports } : {}),
    ...(spec.ranges.length ? { port_range: spec.ranges } : {})
  }
}

/** Plain IPs become single-host prefixes (sing-box wants CIDR). */
export function normalizeCidr(value: string): string {
  const v = value.trim()
  if (v.includes('/')) return v
  return v.includes(':') ? `${v}/128` : `${v}/32`
}

/** RE2 (Go regexp) literal escaping. */
export function escapeRegex(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
}

/**
 * PROCESS-NAME → process_path_regex, case-insensitive: Windows file names are
 * (Koala rules say `discord.exe`, the process is `Discord.exe`), but sing-box
 * compares process_name byte for byte. Matches the last path component.
 */
export function processNameRegex(name: string): string {
  return `(?i)(^|[\\\\/])${escapeRegex(name.trim())}$`
}

/** PROCESS-PATH → whole-path regex, case-insensitive, `\` and `/` both accepted. */
export function processPathRegex(path: string): string {
  const parts = path
    .trim()
    .split(/[\\/]+/)
    .map(escapeRegex)
  return `(?i)^${parts.join('[\\\\/]+')}$`
}

const GEO_TAG_RE = /^geo(site|ip)-[a-z0-9][a-z0-9_!-]*(\.[a-z0-9_!-]+)*$/

/** `geosite-youtube` / `geoip-ru`, or null for an unusable name (no path tricks). */
export function geoTag(kind: 'geosite' | 'geoip', value: string): string | null {
  const tag = `${kind}-${value.trim().toLowerCase()}`
  return GEO_TAG_RE.test(tag) ? tag : null
}

type Matcher = { rule: HeadlessRule } | { geo: string } | null

function matcher(rule: RoutingRule): Matcher {
  const value = rule.value.trim()
  if (!value) return null
  switch (rule.conditionType) {
    case 'Domain':
      return { rule: { domain: [value] } }
    case 'DomainSuffix':
      return { rule: { domain_suffix: [value] } }
    case 'DomainKeyword':
      return { rule: { domain_keyword: [value] } }
    case 'DomainRegex':
      return { rule: { domain_regex: [value] } }
    case 'IPCIDR':
      return { rule: { ip_cidr: [normalizeCidr(value)] } }
    case 'DstPort': {
      const m = portMatcher(value)
      return m ? { rule: m } : null
    }
    case 'ProcessName':
      return { rule: { process_path_regex: [processNameRegex(value)] } }
    case 'ProcessPath':
      return { rule: { process_path_regex: [processPathRegex(value)] } }
    case 'GeoSite': {
      const tag = geoTag('geosite', value)
      return tag ? { geo: tag } : null
    }
    case 'GeoIP': {
      const v = value.toLowerCase()
      if (BUILTIN_GEOIP[v]) return { rule: { ip_cidr: BUILTIN_GEOIP[v] } }
      const tag = geoTag('geoip', v)
      return tag ? { geo: tag } : null
    }
    default:
      return null
  }
}

const COND_LABEL: Record<RoutingRule['conditionType'], string> = {
  ProcessName: 'программа',
  ProcessPath: 'путь',
  Domain: 'домен',
  DomainSuffix: 'домен',
  DomainKeyword: 'слово в домене',
  DomainRegex: 'шаблон домена',
  GeoSite: 'набор geosite:',
  GeoIP: 'geoip:',
  IPCIDR: 'IP-подсеть',
  DstPort: 'порт'
}

/** «программа Discord.exe», «набор geosite:youtube» — as the user typed it. */
export function describeUserRule(r: RoutingRule): string {
  const label = COND_LABEL[r.conditionType] ?? 'правило'
  return label.endsWith(':') ? `${label}${r.value.trim()}` : `${label} ${r.value.trim()}`
}

/** Rule action → slot kind + selector target. */
function resolveAction(
  action: string,
  outboundsByName: Map<string, string>
): { kind: RunKind; target: string } {
  if (action === 'REJECT' || action === 'BLOCK') return { kind: 'reject', target: '' }
  if (action === 'DIRECT') return { kind: 'direct', target: TAG_DIRECT }
  if (action === 'PROXY') return { kind: 'proxy', target: TAG_PROXY_GROUP }
  return { kind: 'proxy', target: outboundsByName.get(action) ?? TAG_PROXY_GROUP }
}

/**
 * User rules → ordered runs (first match wins). Rules only apply in the
 * «Правила» routing mode — the clash_mode rules sit before the slots.
 */
export function planRules(config: RulesConfig, outbounds: OutboundConfig[]): RulePlan {
  const byName = new Map(outbounds.map((o) => [o.name, o.id]))
  const runs: (RuleRun & { count: number })[] = []
  const push = (
    kind: RunKind,
    target: string,
    m: Matcher,
    label: string,
    program?: string
  ): void => {
    if (!m) return
    let run = runs.at(-1)
    if (!run || run.kind !== kind || run.target !== target) {
      run = { kind, target, rules: [], geo: [], label, programs: [], count: 0 }
      runs.push(run)
    }
    if (program && !run.programs.includes(program)) run.programs.push(program)
    if ('rule' in m) run.rules.push(m.rule)
    else if (!run.geo.includes(m.geo)) run.geo.push(m.geo)
    run.count++
  }

  for (const rule of config.rules) {
    if (!rule.enabled) continue
    const act = resolveAction(rule.action, byName)
    push(
      act.kind,
      act.target,
      matcher(rule),
      describeUserRule(rule),
      rule.conditionType === 'ProcessName' ? rule.value.trim() : undefined
    )
  }

  // «Авто: Россия напрямую»: Russian IPs / sites direct, the rest via the VPN
  // (LAN is always direct — see MODE_RULES in configGen.ts)
  const autoLabel = 'Россия напрямую (авто)'
  if (config.defaultBehavior === 'auto') {
    push('direct', TAG_DIRECT, { geo: 'geoip-ru' }, autoLabel)
    push('direct', TAG_DIRECT, { geo: 'geosite-category-ru' }, autoLabel)
  }

  const geo = [...new Set(runs.flatMap((r) => r.geo))]
  return {
    runs: runs.map(({ count, ...r }) =>
      count > 1 && r.label !== autoLabel ? { ...r, label: `${r.label} и ещё ${count - 1}` } : r
    ),
    final: config.defaultBehavior === 'direct' ? TAG_DIRECT : TAG_PROXY_GROUP,
    geo
  }
}

/** Number of slot groups for a plan: room to grow without a restart. */
export function groupsFor(plan: RulePlan): number {
  return Math.max(MIN_GROUPS, plan.runs.length + 4)
}

export const slotFile = (tag: string): string => `${tag}.json`
const slotTag = (g: number, kind: RunKind, dns = false): string =>
  `cw-${g}-${KIND_LETTER[kind]}${dns ? 'n' : ''}`
export const slotSelector = (g: number): string => `cw-${g}`

const DOMAIN_KEYS = ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex'] as const

/** Domain-only part of a list of headless rules (for the DNS rules). */
export function domainOnly(rules: HeadlessRule[]): HeadlessRule[] {
  const out: HeadlessRule[] = []
  for (const r of rules) {
    const d: HeadlessRule = {}
    for (const k of DOMAIN_KEYS) if (Array.isArray(r[k]) && (r[k] as unknown[]).length) d[k] = r[k]
    if (Object.keys(d).length) out.push(d)
  }
  return out
}

/** Rule-set source file text. Compact, always starts with `{"version":` (the TUN broker checks that). */
export function ruleSetText(rules: HeadlessRule[]): string {
  return JSON.stringify({ version: 3, rules })
}

export interface RuleLayout {
  /** file name → rule-set source text, for every slot (empty ones included) */
  files: Record<string, string>
  /** selector tag → member to select (cw-<g>, cw-final, cw-dns) */
  selectors: Record<string, string>
  /** rule-set tag → description of the run in it («Подключения») */
  labels: Record<string, string>
  /** rule-set tag → PROCESS-NAME values of its run (only runs that have some) */
  programs: Record<string, string[]>
  /** geo sets that could not be loaded (their rules are skipped) */
  missing: string[]
}

/**
 * Lays the runs into `groups` slot groups. null = they don't fit (the core has
 * to be restarted with more groups). `geo` holds the headless rules of every
 * loaded geo set; a missing one is skipped (reported in `missing`).
 */
export function layoutRules(
  plan: RulePlan,
  groups: number,
  geo: Map<string, HeadlessRule[]>
): RuleLayout | null {
  const files: Record<string, string> = {}
  const selectors: Record<string, string> = {}
  const labels: Record<string, string> = {}
  const programs: Record<string, string[]> = {}
  const content = new Map<string, HeadlessRule[]>()
  const missing = new Set<string>()

  let pos = 0 // index in the flat slot sequence D0 P0 X0 D1 …
  for (const run of plan.runs) {
    const rules = [...run.rules]
    for (const tag of run.geo) {
      const g = geo.get(tag)
      if (g) rules.push(...g)
      else missing.add(tag)
    }
    if (rules.length === 0) continue
    const want = SLOT_KINDS.indexOf(run.kind)
    while (pos < groups * 3 && pos % 3 !== want) pos++
    if (pos >= groups * 3) return null
    const g = Math.floor(pos / 3)
    const tag = slotTag(g, run.kind)
    content.set(tag, rules)
    labels[tag] = run.label
    if (run.programs.length) programs[tag] = [...run.programs]
    if (run.kind === 'proxy') selectors[slotSelector(g)] = run.target
    pos++
  }

  for (let g = 0; g < groups; g++) {
    for (const kind of SLOT_KINDS) {
      const tag = slotTag(g, kind)
      const rules = content.get(tag) ?? []
      files[slotFile(tag)] = ruleSetText(rules)
      if (kind !== 'reject')
        files[slotFile(slotTag(g, kind, true))] = ruleSetText(domainOnly(rules))
    }
    selectors[slotSelector(g)] ??= TAG_PROXY_GROUP
  }
  selectors[SLOT_FINAL] = plan.final
  selectors[SLOT_DNS] = plan.final === TAG_DIRECT ? TAG_DIRECT : TAG_PROXY_GROUP
  return { files, selectors, labels, programs, missing: [...missing] }
}

export interface RuleSkeleton {
  ruleSets: SbRuleSet[]
  routeRules: SbRouteRule[]
  dnsRules: Record<string, unknown>[]
  /** cw-<g> + cw-final + cw-dns selectors */
  outbounds: SbOutbound[]
}

/**
 * The fixed part of the config for `groups` slot groups whose files live in
 * `dir` (absolute). `defaults` = RuleLayout.selectors, so the core starts with
 * the right choices and no Clash API call is needed at startup.
 */
export function ruleSkeleton(
  groups: number,
  dir: string,
  nodeTags: string[],
  defaults: Record<string, string>
): RuleSkeleton {
  const ruleSets: SbRuleSet[] = []
  const routeRules: SbRouteRule[] = []
  const dnsRules: Record<string, unknown>[] = []
  const outbounds: SbOutbound[] = []
  const local = (tag: string): SbRuleSet => ({
    type: 'local',
    tag,
    format: 'source',
    path: join(dir, slotFile(tag))
  })
  const proxyMembers = [TAG_PROXY_GROUP, ...nodeTags]

  for (let g = 0; g < groups; g++) {
    for (const kind of SLOT_KINDS) {
      const tag = slotTag(g, kind)
      ruleSets.push(local(tag))
      if (kind === 'direct') {
        routeRules.push({ rule_set: [tag], action: 'route', outbound: TAG_DIRECT })
      } else if (kind === 'proxy') {
        routeRules.push({ rule_set: [tag], action: 'route', outbound: slotSelector(g) })
      } else {
        routeRules.push({ rule_set: [tag], action: 'reject' })
      }
      if (kind !== 'reject') {
        const dnsTag = slotTag(g, kind, true)
        ruleSets.push(local(dnsTag))
        dnsRules.push({ rule_set: [dnsTag], server: kind === 'direct' ? 'local' : 'remote' })
      }
    }
    const sel = slotSelector(g)
    const def = defaults[sel]
    outbounds.push({
      type: 'selector',
      tag: sel,
      outbounds: proxyMembers,
      default: def && proxyMembers.includes(def) ? def : TAG_PROXY_GROUP,
      interrupt_exist_connections: false
    })
  }
  for (const tag of [SLOT_FINAL, SLOT_DNS]) {
    outbounds.push({
      type: 'selector',
      tag,
      outbounds: [TAG_PROXY_GROUP, TAG_DIRECT],
      default: defaults[tag] === TAG_DIRECT ? TAG_DIRECT : TAG_PROXY_GROUP,
      interrupt_exist_connections: false
    })
  }
  return { ruleSets, routeRules, dnsRules, outbounds }
}
