import type { DefaultBehavior, RoutingRule, RuleConditionType, RulesConfig } from './types'

// ---------------------------------------------------------------------------
// Text import / export of routing rules (moving over from Koala Clash /
// Clash Verge / mihomo). Accepts:
//  (а) Clash rule lines:  TYPE,value,ACTION[,no-resolve]
//  (б) YAML with `prepend:` / `append:` / `delete:` lists (Clash Verge «Rules»
//      enhancement), a `rules:` block of a full config, or a `payload:` list
//  (в) our own JSON export ({ defaultBehavior, rules })
// Nothing is dropped silently: every line that can't be used ends up in
// `skipped` with its line number and a reason (shown in the editor).
// Pure, no Node/DOM APIs — used by the renderer, tested in rulesText.test.ts.
// ---------------------------------------------------------------------------

export type DraftRule = Omit<RoutingRule, 'id'>
export type ImportSection = 'prepend' | 'main' | 'append'

export interface ImportItem {
  /** 1-based line in the source text */
  line: number
  section: ImportSection
  rule: DraftRule
}

export interface SkippedLine {
  line: number
  text: string
  reason: string
}

export interface ParseResult {
  format: 'empty' | 'clash' | 'yaml' | 'json'
  items: ImportItem[]
  /** Clash Verge `delete:` — existing rules to remove */
  deletions: DraftRule[]
  /** from MATCH / FINAL, or the JSON export */
  defaultBehavior?: DefaultBehavior
  skipped: SkippedLine[]
}

const CLASH_TYPES: Record<string, RuleConditionType> = {
  DOMAIN: 'Domain',
  'DOMAIN-SUFFIX': 'DomainSuffix',
  'DOMAIN-KEYWORD': 'DomainKeyword',
  'DOMAIN-REGEX': 'DomainRegex',
  GEOSITE: 'GeoSite',
  GEOIP: 'GeoIP',
  'IP-CIDR': 'IPCIDR',
  'IP-CIDR6': 'IPCIDR',
  'PROCESS-NAME': 'ProcessName',
  'PROCESS-PATH': 'ProcessPath',
  'DST-PORT': 'DstPort'
}

const TO_CLASH: Record<RuleConditionType, string> = {
  Domain: 'DOMAIN',
  DomainSuffix: 'DOMAIN-SUFFIX',
  DomainKeyword: 'DOMAIN-KEYWORD',
  DomainRegex: 'DOMAIN-REGEX',
  GeoSite: 'GEOSITE',
  GeoIP: 'GEOIP',
  IPCIDR: 'IP-CIDR',
  ProcessName: 'PROCESS-NAME',
  ProcessPath: 'PROCESS-PATH',
  DstPort: 'DST-PORT'
}

export const CONDITION_TYPE_LIST = Object.keys(TO_CLASH) as RuleConditionType[]

/** trailing rule options we accept and ignore */
const OPTIONS = new Set(['no-resolve', 'src', 'dst'])

// ---- value validation ------------------------------------------------------

export interface PortSpec {
  ports: number[]
  /** "from:to" (sing-box port_range syntax) */
  ranges: string[]
}

/** `443`, `8000-9000`, `80/443`, `53|853`, `80,443` → ports + ranges; null if invalid. */
export function parsePortSpec(value: string): PortSpec | null {
  const ports: number[] = []
  const ranges: string[] = []
  for (const part of value.split(/[/|,]/)) {
    const t = part.trim()
    if (!t) continue
    const m = /^(\d{1,5})(?:\s*[-:]\s*(\d{1,5}))?$/.exec(t)
    if (!m) return null
    const a = Number(m[1])
    const b = m[2] !== undefined ? Number(m[2]) : undefined
    if (a < 1 || a > 65535 || (b !== undefined && (b < a || b > 65535))) return null
    if (b === undefined || b === a) ports.push(a)
    else ranges.push(`${a}:${b}`)
  }
  return ports.length || ranges.length ? { ports, ranges } : null
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

export function isValidCidr(value: string): boolean {
  const [ip, bits, extra] = value.trim().split('/')
  if (extra !== undefined || !ip) return false
  if (IPV4.test(ip)) return bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32)
  // IPv6: hex groups, at most one "::"
  if (!/^[0-9a-f:.]+$/i.test(ip) || !ip.includes(':')) return false
  if ((ip.match(/::/g) ?? []).length > 1) return false
  const groups = ip.split(':')
  if (groups.length > 8 || groups.some((g) => g.length > 4 && !IPV4.test(g))) return false
  return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128)
}

const DOMAIN_RE = /^[a-z0-9_*-]+(\.[a-z0-9_*-]+)*\.?$/i

/** Normalised value for a condition, or a human-readable reason it's unusable. */
export function validateValue(
  type: RuleConditionType,
  raw: string
): { ok: true; value: string } | { ok: false; reason: string } {
  let v = raw.trim()
  if (!v) return { ok: false, reason: 'пустое значение' }
  switch (type) {
    case 'Domain':
    case 'DomainSuffix':
      v = v.replace(/^\+\./, '').replace(/^\./, '').toLowerCase()
      return DOMAIN_RE.test(v) ? { ok: true, value: v } : { ok: false, reason: 'неверный домен' }
    case 'DomainKeyword':
      return /\s/.test(v) ? { ok: false, reason: 'пробел в слове' } : { ok: true, value: v.toLowerCase() }
    case 'DomainRegex':
      try {
        new RegExp(v)
        return { ok: true, value: v }
      } catch {
        return { ok: false, reason: 'неверное регулярное выражение' }
      }
    case 'GeoSite':
      if (v.includes('@')) return { ok: false, reason: 'атрибуты «@» в GEOSITE не поддерживаются' }
      if (v.startsWith('!')) return { ok: false, reason: 'отрицание «!» не поддерживается' }
      v = v.toLowerCase()
      return /^[a-z0-9][a-z0-9_.!-]*$/.test(v)
        ? { ok: true, value: v }
        : { ok: false, reason: 'неверная категория GEOSITE' }
    case 'GeoIP':
      v = v.toLowerCase()
      if (v === 'lan') v = 'private'
      return /^[a-z0-9-]{2,32}$/.test(v)
        ? { ok: true, value: v }
        : { ok: false, reason: 'неверный код страны GEOIP' }
    case 'IPCIDR':
      return isValidCidr(v) ? { ok: true, value: v } : { ok: false, reason: 'неверный IP/подсеть' }
    case 'DstPort':
      return parsePortSpec(v)
        ? { ok: true, value: v.replace(/\s+/g, '') }
        : { ok: false, reason: 'неверный порт (1–65535 или диапазон 1000-2000)' }
    case 'ProcessName':
    case 'ProcessPath':
      return { ok: true, value: v }
  }
}

/** DIRECT / REJECT stay, everything else (PROXY, group or node names) → PROXY. */
export function mapAction(raw: string): { ok: true; action: string } | { ok: false; reason: string } {
  const a = raw.trim()
  const up = a.toUpperCase()
  if (!a) return { ok: false, reason: 'не указано действие (DIRECT / PROXY / REJECT)' }
  if (up === 'DIRECT') return { ok: true, action: 'DIRECT' }
  if (up.startsWith('REJECT') || up === 'BLOCK') return { ok: true, action: 'REJECT' }
  if (up === 'PASS') return { ok: false, reason: 'действие PASS не поддерживается' }
  return { ok: true, action: 'PROXY' }
}

function behaviorFromAction(action: string): DefaultBehavior | null {
  if (action === 'DIRECT') return 'direct'
  if (action === 'PROXY') return 'proxy'
  return null
}

// ---- Clash line ------------------------------------------------------------

export type LineResult =
  | { kind: 'rule'; rule: DraftRule }
  | { kind: 'match'; behavior: DefaultBehavior }
  | { kind: 'comment' }
  | { kind: 'skip'; reason: string }

/** Strips a YAML list dash, quotes and an inline ` # comment`. */
function cleanLine(raw: string): string {
  let t = raw.trim()
  if (t === '-') return ''
  if (t.startsWith('- ')) t = t.slice(2).trim()
  const q = t[0]
  if ((q === "'" || q === '"') && t.length >= 2) {
    const end = t.lastIndexOf(q)
    if (end > 0) {
      const inner = t.slice(1, end)
      return (
        q === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(["\\])/g, '$1')
      ).trim()
    }
  }
  return t.replace(/\s+#.*$/, '').trim()
}

export function parseClashLine(raw: string): LineResult {
  const t = cleanLine(raw)
  if (!t || t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) return { kind: 'comment' }
  const parts = t.split(',').map((p) => p.trim())
  const type = parts[0].toUpperCase()

  if (type === 'MATCH' || type === 'FINAL') {
    const act = mapAction(parts[1] ?? '')
    if (!act.ok) return { kind: 'skip', reason: act.reason }
    const b = behaviorFromAction(act.action)
    return b ? { kind: 'match', behavior: b } : { kind: 'skip', reason: 'MATCH,REJECT не поддерживается' }
  }

  const cond = CLASH_TYPES[type]
  if (!cond) {
    if (!/^[A-Z0-9-]+$/.test(type)) return { kind: 'skip', reason: 'не похоже на правило Clash' }
    return { kind: 'skip', reason: `тип ${type} не поддерживается` }
  }
  // trailing options (no-resolve…) are ignored; DOMAIN-REGEX may contain commas
  const rest = parts.slice(1)
  while (rest.length > 2 && OPTIONS.has(rest[rest.length - 1].toLowerCase())) rest.pop()
  if (rest.length < 2) return { kind: 'skip', reason: 'не указано действие (DIRECT / PROXY / REJECT)' }
  const actionRaw = rest.pop() as string
  const value = rest.join(',')

  if (type === 'IP-CIDR6' && !value.includes(':')) return { kind: 'skip', reason: 'IP-CIDR6 без IPv6-адреса' }
  const val = validateValue(cond, value)
  if (!val.ok) return { kind: 'skip', reason: val.reason }
  const act = mapAction(actionRaw)
  if (!act.ok) return { kind: 'skip', reason: act.reason }
  return { kind: 'rule', rule: { enabled: true, conditionType: cond, value: val.value, action: act.action } }
}

// ---- YAML subset ------------------------------------------------------------

const YAML_KEYS: Record<string, ImportSection | 'delete'> = {
  prepend: 'prepend',
  append: 'append',
  delete: 'delete',
  rules: 'main',
  payload: 'main'
}

function looksLikeYaml(text: string): boolean {
  return /^(prepend|append|delete|rules|payload)\s*:/m.test(text)
}

/** `['a,b,c', "d", e]` → items (commas inside quotes kept). */
function parseFlowList(s: string): string[] | null {
  const t = s.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return null
  const body = t.slice(1, -1)
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && body[i + 1] === "'") {
          cur += "'"
          i++
        } else quote = null
      } else cur += ch
    } else if (ch === "'" || ch === '"') quote = ch
    else if (ch === ',') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

interface RawEntry {
  line: number
  text: string
  section: ImportSection | 'delete'
}

function yamlEntries(text: string, skipped: SkippedLine[]): RawEntry[] {
  const out: RawEntry[] = []
  let section: ImportSection | 'delete' | null = null
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = i + 1
    const t = raw.trim()
    if (!t || t.startsWith('#')) return
    const top = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw)
    if (top) {
      section = YAML_KEYS[top[1]] ?? null
      const inline = top[2].replace(/\s+#.*$/, '').trim()
      if (section && inline) {
        const items = parseFlowList(inline)
        if (items) for (const it of items) out.push({ line, text: it, section })
        else if (inline !== '[]') skipped.push({ line, text: t, reason: 'ожидался список строк' })
      }
      return
    }
    if (!section) return // proxies:, proxy-groups: … — not ours, ignore
    if (/^\s*-(\s|$)/.test(raw)) out.push({ line, text: raw, section })
    else skipped.push({ line, text: t, reason: 'не строка правила' })
  })
  return out
}

// ---- JSON (our export) --------------------------------------------------------

function parseJson(text: string, res: ParseResult): void {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    res.skipped.push({ line: 1, text: text.slice(0, 80), reason: `ошибка JSON: ${(e as Error).message}` })
    return
  }
  const obj = data as Partial<RulesConfig> | unknown[]
  const list = Array.isArray(obj) ? obj : Array.isArray(obj?.rules) ? obj.rules : null
  if (!list) {
    res.skipped.push({ line: 1, text: text.slice(0, 80), reason: 'в JSON нет списка rules' })
    return
  }
  if (!Array.isArray(obj) && ['proxy', 'direct', 'auto'].includes(String(obj.defaultBehavior))) {
    res.defaultBehavior = obj.defaultBehavior as DefaultBehavior
  }
  list.forEach((entry, i) => {
    const line = i + 1
    if (typeof entry === 'string') {
      const r = parseClashLine(entry)
      if (r.kind === 'rule') res.items.push({ line, section: 'main', rule: r.rule })
      else if (r.kind === 'match') res.defaultBehavior = r.behavior
      else if (r.kind === 'skip') res.skipped.push({ line, text: entry, reason: r.reason })
      return
    }
    const e = entry as Partial<RoutingRule>
    const type = e?.conditionType
    if (!type || !CONDITION_TYPE_LIST.includes(type) || typeof e.value !== 'string') {
      res.skipped.push({ line, text: JSON.stringify(entry).slice(0, 80), reason: 'неизвестный тип правила' })
      return
    }
    const val = validateValue(type, e.value)
    if (!val.ok) {
      res.skipped.push({ line, text: `${type} ${e.value}`, reason: val.reason })
      return
    }
    const action = typeof e.action === 'string' && e.action ? e.action : 'PROXY'
    res.items.push({
      line,
      section: 'main',
      rule: { enabled: e.enabled !== false, conditionType: type, value: val.value, action }
    })
  })
}

// ---- entry point ------------------------------------------------------------

export function parseRulesText(text: string): ParseResult {
  const res: ParseResult = { format: 'empty', items: [], deletions: [], skipped: [] }
  const trimmed = text.trim()
  if (!trimmed) return res

  if (trimmed.startsWith('{') || (trimmed.startsWith('[') && !looksLikeYaml(trimmed))) {
    res.format = 'json'
    parseJson(trimmed, res)
    return res
  }

  const yaml = looksLikeYaml(text)
  res.format = yaml ? 'yaml' : 'clash'
  const entries: RawEntry[] = yaml
    ? yamlEntries(text, res.skipped)
    : text.split(/\r?\n/).map((t, i) => ({ line: i + 1, text: t, section: 'main' as const }))

  for (const e of entries) {
    const r = parseClashLine(e.text)
    if (r.kind === 'comment') continue
    if (r.kind === 'skip') {
      res.skipped.push({ line: e.line, text: cleanLine(e.text).slice(0, 120), reason: r.reason })
    } else if (r.kind === 'match') {
      if (e.section === 'delete') continue
      res.defaultBehavior = r.behavior
    } else if (e.section === 'delete') {
      res.deletions.push(r.rule)
    } else {
      res.items.push({ line: e.line, section: e.section, rule: r.rule })
    }
  }
  res.skipped.sort((a, b) => a.line - b.line)
  return res
}

// ---- applying an import -------------------------------------------------------

export type ImportPosition = 'start' | 'end' | 'replace'

const ruleKey = (r: DraftRule): string =>
  `${r.conditionType}|${r.value.toLowerCase()}|${r.action.toUpperCase()}`

/**
 * New rule list. `prepend:` items always go first and `append:` items last;
 * plain lines / `rules:` go where the user asked. `delete:` removes matching
 * existing rules. Ids for new rules come from `newId`.
 */
export function applyImport(
  existing: RoutingRule[],
  parsed: ParseResult,
  position: ImportPosition,
  newId: () => string
): RoutingRule[] {
  const make = (s: ImportSection): RoutingRule[] =>
    parsed.items.filter((i) => i.section === s).map((i) => ({ ...i.rule, id: newId() }))
  const pre = make('prepend')
  const main = make('main')
  const post = make('append')
  const dels = new Set(parsed.deletions.map(ruleKey))
  const kept = position === 'replace' ? [] : existing.filter((r) => !dels.has(ruleKey(r)))
  if (position === 'start') return [...pre, ...main, ...kept, ...post]
  return [...pre, ...kept, ...main, ...post]
}

// ---- export ------------------------------------------------------------------------

function clashAction(action: string): string {
  if (action === 'DIRECT' || action === 'REJECT' || action === 'PROXY') return action
  if (action === 'BLOCK') return 'REJECT'
  return action.replace(/,/g, ' ') // a server name — Clash would read it as a group name
}

function clashValue(r: RoutingRule): string {
  if (r.conditionType === 'GeoIP') {
    const v = r.value.toLowerCase()
    return v === 'private' ? 'LAN' : v.toUpperCase()
  }
  return r.value
}

/** Rules as Clash lines (disabled ones commented out) + MATCH for the default. */
export function toClashLines(config: RulesConfig): string {
  const lines = ['# CipherWay VPN — правила в формате Clash', '']
  for (const r of config.rules) {
    const type = TO_CLASH[r.conditionType]
    if (!type) continue
    const extra = r.conditionType === 'IPCIDR' && r.value.includes(':') ? 'IP-CIDR6' : type
    const line = `${extra},${clashValue(r)},${clashAction(r.action)}`
    lines.push(r.enabled ? line : `# ${line}`)
  }
  if (config.defaultBehavior === 'auto') {
    lines.push('', '# по умолчанию: «Авто» — локальная сеть и Россия напрямую')
    lines.push('GEOIP,LAN,DIRECT', 'GEOIP,RU,DIRECT', 'GEOSITE,category-ru,DIRECT', 'MATCH,PROXY')
  } else {
    lines.push('', `MATCH,${config.defaultBehavior === 'direct' ? 'DIRECT' : 'PROXY'}`)
  }
  return lines.join('\n') + '\n'
}
