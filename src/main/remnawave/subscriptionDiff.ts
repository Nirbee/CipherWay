import { AUTO_OUTBOUND_ID, type OutboundConfig } from '@shared/types'

// ---------------------------------------------------------------------------
// What changed between two versions of the subscription, and what that means
// for the running core and the selected server. Pure — unit tested.
//
// Remnawave may hand out a different shortId / fingerprint on every request
// (it picks from the inbound's list), so those are "soft": remembered for the
// next start, but no reason to break the user's connections. The automatic
// reaction to a REALITY error compares the fresh list with what the core is
// RUNNING (runningChanges) and applies any difference of the failing server,
// soft fields included (0.5.2, see SubscriptionSync).
// ---------------------------------------------------------------------------

const HARD_FIELDS: (keyof OutboundConfig)[] = [
  'protocol',
  'server',
  'port',
  'uuid',
  'flow',
  'encryption',
  'security',
  'publicKey',
  'serverName',
  'network',
  'path',
  'host',
  'password',
  'sni',
  'obfs',
  'obfsPassword',
  'insecure'
]
const SOFT_FIELDS: (keyof OutboundConfig)[] = ['shortId', 'fingerprint', 'spiderX']

const differs = (a: OutboundConfig, b: OutboundConfig, fields: (keyof OutboundConfig)[]): boolean =>
  fields.some((f) => (a[f] ?? '') !== (b[f] ?? ''))

/** name → outbound; a repeated name gets «name#2» so nothing is lost. */
function byName(list: OutboundConfig[]): Map<string, OutboundConfig> {
  const map = new Map<string, OutboundConfig>()
  const seen = new Map<string, number>()
  for (const o of list) {
    const n = (seen.get(o.name) ?? 0) + 1
    seen.set(o.name, n)
    map.set(n === 1 ? o.name : `${o.name}#${n}`, o)
  }
  return map
}

export interface OutboundsDiff {
  added: string[]
  removed: string[]
  /** connection parameters changed */
  modified: string[]
  /** only shortId / fingerprint / spiderX changed */
  softOnly: string[]
  /** the running core no longer matches the subscription */
  restartNeeded: boolean
}

export function diffOutbounds(prev: OutboundConfig[], next: OutboundConfig[]): OutboundsDiff {
  const before = byName(prev)
  const after = byName(next)
  const added = [...after.keys()].filter((n) => !before.has(n))
  const removed = [...before.keys()].filter((n) => !after.has(n))
  const modified: string[] = []
  const softOnly: string[] = []
  let idsMoved = false
  for (const [name, b] of after) {
    const a = before.get(name)
    if (!a) continue
    if (a.id !== b.id) idsMoved = true
    if (differs(a, b, HARD_FIELDS)) modified.push(name)
    else if (differs(a, b, SOFT_FIELDS)) softOnly.push(name)
  }
  return {
    added,
    removed,
    modified,
    softOnly,
    restartNeeded: added.length > 0 || removed.length > 0 || modified.length > 0 || idsMoved
  }
}

/** Field names for the log («Финляндия: отпечаток qq → firefox»). */
const FIELD_LABEL: Partial<Record<keyof OutboundConfig, string>> = {
  protocol: 'протокол',
  server: 'адрес',
  port: 'порт',
  uuid: 'UUID',
  flow: 'flow',
  encryption: 'шифрование',
  security: 'защита',
  publicKey: 'ключ REALITY',
  shortId: 'shortId',
  fingerprint: 'отпечаток',
  spiderX: 'spiderX',
  serverName: 'SNI',
  network: 'транспорт',
  path: 'путь',
  host: 'host',
  password: 'пароль',
  sni: 'SNI',
  obfs: 'obfs',
  obfsPassword: 'пароль obfs',
  insecure: 'insecure'
}
/** values that are neither credentials nor addresses — shown in the log as «было → стало» */
const SHOWN_VALUES = new Set<keyof OutboundConfig>([
  'protocol',
  'port',
  'flow',
  'encryption',
  'security',
  'fingerprint',
  'network',
  'obfs',
  'insecure'
])

export interface FieldChange {
  field: keyof OutboundConfig
  from: string
  to: string
}

/** Every connection field (hard and soft) that differs between two copies of a server. */
export function fieldChanges(a: OutboundConfig, b: OutboundConfig): FieldChange[] {
  return [...HARD_FIELDS, ...SOFT_FIELDS]
    .filter((f) => String(a[f] ?? '') !== String(b[f] ?? ''))
    .map((f) => ({ field: f, from: String(a[f] ?? ''), to: String(b[f] ?? '') }))
}

/**
 * «Финляндия: отпечаток qq → firefox, ключ REALITY» — keys, ids, passwords and
 * addresses are named, never printed.
 */
export function describeFieldChanges(name: string, changes: FieldChange[]): string {
  const parts = changes.map((c) => {
    const label = FIELD_LABEL[c.field] ?? String(c.field)
    return SHOWN_VALUES.has(c.field) ? `${label} ${c.from || '—'} → ${c.to || '—'}` : label
  })
  return `${name}: ${parts.join(', ')}`
}

export interface ServerChange {
  /** id in the new list */
  id: string
  name: string
  changes: FieldChange[]
}

/**
 * The servers of `running` (what the core was started with) whose copy in the
 * fresh subscription differs in ANY field, soft ones included. Matched by name
 * like diffOutbounds; `only` = ids (of either list) to look at, empty = all.
 */
export function runningChanges(
  running: OutboundConfig[],
  next: OutboundConfig[],
  only: string[] = []
): ServerChange[] {
  const before = byName(running)
  const after = byName(next)
  const out: ServerChange[] = []
  for (const [name, b] of after) {
    const a = before.get(name)
    if (!a) continue
    if (only.length && !only.includes(a.id) && !only.includes(b.id)) continue
    const changes = fieldChanges(a, b)
    if (changes.length) out.push({ id: b.id, name: b.name, changes })
  }
  return out
}

/** Readable summary for the log: names only, no addresses. */
export function describeDiff(d: OutboundsDiff): string {
  const parts: string[] = []
  if (d.added.length) parts.push(`новые: ${d.added.join(', ')}`)
  if (d.removed.length) parts.push(`удалены: ${d.removed.join(', ')}`)
  if (d.modified.length) parts.push(`изменились: ${d.modified.join(', ')}`)
  return parts.join('; ')
}

export interface ActiveChoice {
  id: string
  /** differs from what was selected */
  changed: boolean
  /** the selected server's name, when it is no longer in the subscription */
  lost?: string
}

/**
 * The selected server follows its *name*; if it is gone — «Лучший сервер».
 * An id unknown to both lists (e.g. the hidden «⚡ Автовыбор») also goes to auto.
 */
export function reconcileActive(
  activeId: string | null | undefined,
  prev: OutboundConfig[],
  next: OutboundConfig[]
): ActiveChoice {
  if (!activeId || activeId === AUTO_OUTBOUND_ID) {
    return { id: AUTO_OUTBOUND_ID, changed: false }
  }
  if (next.some((o) => o.id === activeId)) return { id: activeId, changed: false }
  const name = prev.find((o) => o.id === activeId)?.name
  const same = name === undefined ? undefined : next.find((o) => o.name === name)
  if (same) return { id: same.id, changed: true }
  return { id: AUTO_OUTBOUND_ID, changed: true, ...(name ? { lost: name } : {}) }
}

/** Latency history keyed by the ids of the new list (matched by name). */
export function remapLatencies(
  cache: Record<string, number | null>,
  prev: OutboundConfig[],
  next: OutboundConfig[]
): Record<string, number | null> {
  const nameOf = new Map(prev.map((o) => [o.id, o.name]))
  const idOf = new Map(next.map((o) => [o.name, o.id]))
  const known = new Set(next.map((o) => o.id))
  const out: Record<string, number | null> = {}
  for (const [id, v] of Object.entries(cache)) {
    const name = nameOf.get(id)
    const target = known.has(id) ? id : name === undefined ? undefined : idOf.get(name)
    if (target) out[target] = v
  }
  return out
}

const HOUR_MS = 60 * 60_000
const MIN_INTERVAL_HOURS = 1
const MAX_INTERVAL_HOURS = 168

/** `profile-update-interval` of the panel if it sent one, else the setting. */
export function refreshIntervalMs(headerHours: number | undefined, settingHours: number): number {
  const hours = headerHours && headerHours > 0 ? headerHours : settingHours
  return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, hours)) * HOUR_MS
}
