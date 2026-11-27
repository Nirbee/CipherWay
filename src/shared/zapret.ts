// ---------------------------------------------------------------------------
// «Ускорение без VPN (zapret)» (0.7.0): the chosen services (YouTube, Discord)
// and the user's own domains go DIRECTLY, past the VPN; zapret (winws through
// the SYSTEM service, src/main/zapret) removes the provider's DPI throttling for
// them. Everything else goes through the VPN as before. Every item is checked
// directly after the start, every ~10 minutes and on a network change; one
// that does not open directly goes back through the VPN at once.
// Shared by main and the renderer — pure, unit tested in zapret.test.ts.
// ---------------------------------------------------------------------------

import { TLDS } from './tlds'

export type ZapretServiceId = 'youtube' | 'discord'

export const ZAPRET_SERVICES: readonly { id: ZapretServiceId; name: string }[] = [
  { id: 'youtube', name: 'YouTube' },
  { id: 'discord', name: 'Discord' }
]

export const ZAPRET_SERVICE_IDS = ZAPRET_SERVICES.map((s) => s.id) as readonly ZapretServiceId[]

/** at most this many own domains */
export const ZAPRET_CUSTOM_MAX = 200

/** What the user chose (stored; off by default). */
export interface ZapretSettings {
  enabled: boolean
  services: ZapretServiceId[]
  /** own domains, normalized (normalizeZapretDomain) */
  custom: string[]
  /** the one-time warning (real IP, antivirus, admin rights) was accepted */
  warned: boolean
}

export const DEFAULT_ZAPRET: ZapretSettings = {
  enabled: false,
  services: ['youtube', 'discord'],
  custom: [],
  warned: false
}

/**
 * direct   — opens directly (zapret on): goes past the VPN
 * partial  — a part opens directly, the rest through the VPN (YouTube: the
 *            video over QUIC only, 0.7.2) — `note` says which
 * vpn      — did not open directly: through the VPN, tried again later
 * checking — the first check is running
 * idle     — the VPN is off / the feature is off
 */
export type ZapretItemState = 'direct' | 'partial' | 'vpn' | 'checking' | 'idle'

export interface ZapretItem {
  /** a service id, or `d:<domain>` for an own domain */
  key: string
  kind: 'service' | 'custom'
  name: string
  state: ZapretItemState
  /** why it is through the VPN («нет ответа от youtube.com») */
  detail?: string
  /** a short addition to the state: «видео по QUIC», «нет адреса — проверяется по поддоменам» */
  note?: string
}

/** The state of a user rule «Напрямую + zapret» (0.7.2), by rule id. */
export interface ZapretRuleState {
  /**
   * direct — direct, zapret on, opens; vpn — did not open: through the VPN
   * (the fallback is on); plain — direct WITHOUT zapret (zapret off / broken /
   * the VPN off / the condition can't be given to zapret); checking
   */
  state: 'direct' | 'vpn' | 'plain' | 'checking'
  detail?: string
  /** «проверяется по трафику» (an address range: nothing to aim a check at) */
  note?: string
}

export type ZapretPhase =
  /** the feature is off */
  | 'off'
  /** on, the VPN is off: nothing runs */
  | 'idle'
  /** zapret is being started / the first check runs */
  | 'starting'
  | 'running'
  /** looking for a strategy that works on this network */
  | 'picking'
  | 'error'

export interface ZapretView {
  /** this build ships zapret (cipherway-dpi.exe) */
  available: boolean
  settings: ZapretSettings
  phase: ZapretPhase
  items: ZapretItem[]
  /** the strategy in use on this network (null = none works / not chosen yet) */
  strategy: { id: string; name: string } | null
  /** while picking: strategies tried / total */
  picking?: { done: number; total: number }
  /** a check is running right now (the states above are the last ones known) */
  checking: boolean
  /** ms epoch of the last finished check */
  checkedAt?: number
  /** a readable reason (phase 'error', or the feature could not be switched on) */
  error?: string
  /** a readable warning: another zapret / GoodbyeDPI runs, ours does not */
  warning?: string
  /** the user's rules «Напрямую + zapret», by rule id (0.7.2) */
  rules?: Record<string, ZapretRuleState>
}

/** Something in the domain field was not accepted — the text says why. */
export type DomainCheck = { ok: true; domain: string } | { ok: false; error: string }

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
/** what a program's file name ends with — never a site (wardogsclient-win64-shipping.exe) */
const PROGRAM_EXT_RE = /\.(?:exe|bat|cmd|msi|dll|scr|lnk|ps1|vbs|sys)$/i
export const PROGRAM_HINT =
  'Это программа, а не сайт. Игры по программе появятся позже; пока впишите домены игры'
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
/** names that never leave the computer / the local network */
const LOCAL_SUFFIXES = [
  'localhost',
  'local',
  'lan',
  'home',
  'internal',
  'intranet',
  'corp',
  'home.arpa',
  'arpa',
  'test',
  'invalid',
  'example',
  'onion'
]
/** our own domains: the app's own requests already know their way */
export const OWN_DOMAINS = ['cipherway.ru', 'cipherway.net.ru']

/**
 * Public suffixes: names under which DIFFERENT owners register their sites
 * (a short built-in part of the Public Suffix List — the Russian / Ukrainian
 * regional zones, the usual second-level zones, popular free hostings). Such a
 * name itself is never accepted: it would send every site under it past the
 * VPN. A site under it (example.com.ru, user.github.io) is fine. The SYSTEM
 * broker refuses them too (dpiBroker.ts).
 */
export const PUBLIC_SUFFIXES: readonly string[] = [
  // Russia
  'com.ru',
  'net.ru',
  'org.ru',
  'pp.ru',
  'msk.ru',
  'spb.ru',
  'nov.ru',
  'msk.su',
  'spb.su',
  'ru.com',
  'ru.net',
  'su',
  'xn--p1acf',
  'com.su',
  'net.su',
  'org.su',
  // Ukraine, Kazakhstan, Belarus
  'com.ua',
  'net.ua',
  'org.ua',
  'in.ua',
  'kiev.ua',
  'pp.ua',
  'co.ua',
  'com.kz',
  'org.kz',
  'com.by',
  // the usual second-level zones
  'co.uk',
  'org.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.nz',
  'co.za',
  'co.in',
  'co.il',
  'co.kr',
  'com.br',
  'com.cn',
  'com.tr',
  'com.mx',
  'com.ar',
  'com.pl',
  'com.de',
  'com.es',
  'com.tw',
  'com.hk',
  'com.sg',
  'eu.org',
  // free hostings / dynamic DNS
  'github.io',
  'gitlab.io',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'appspot.com',
  'blogspot.com',
  'web.app',
  'firebaseapp.com',
  'azurewebsites.net',
  'cloudfront.net',
  'amazonaws.com',
  'onrender.com',
  'fly.dev',
  'ngrok.io',
  'ngrok-free.app',
  'duckdns.org',
  'no-ip.org',
  'ddns.net',
  'dyndns.org',
  'narod.ru',
  'ucoz.ru',
  'tilda.ws',
  'wixsite.com',
  'myshopify.com'
]

const under = (domain: string, suffix: string): boolean =>
  domain === suffix || domain.endsWith(`.${suffix}`)

/**
 * The domain the user typed → the form zapret and sing-box take (lower-case,
 * punycode, no scheme / path / port / `*.` / trailing dot), or why not.
 * `reserved`: more names that are not allowed (the subscription host, the
 * servers' host names), with their subdomains.
 */
export function normalizeZapretDomain(raw: string, reserved: string[] = []): DomainCheck {
  let s = raw.trim().toLowerCase()
  if (!s) return { ok: false, error: 'Введите домен, например example.com' }
  if (s.length > 300) return { ok: false, error: 'Слишком длинный домен' }
  // a program (its name or its path), not a site
  if (PROGRAM_EXT_RE.test(s.replace(/["']/g, '')) || /^[a-z]:\\/.test(s) || s.includes('\\')) {
    return { ok: false, error: PROGRAM_HINT }
  }
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split(/[/?#]/)[0]
  if (s.includes('@')) return { ok: false, error: 'Нужен только домен, без логина' }
  // [2001:db8::1]:443, 2001:db8::1 — an IPv6 address has two colons or more
  if (s.startsWith('[') || s.split(':').length > 2) {
    return { ok: false, error: 'Нужен домен, а не IP-адрес' }
  }
  s = s.replace(/:\d{1,5}$/, '')
  s = s.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.$/, '')
  if (!s) return { ok: false, error: 'Введите домен, например example.com' }
  if (IPV4_RE.test(s)) return { ok: false, error: 'Нужен домен, а не IP-адрес' }
  // IDN (кириллица) → punycode, the same in main and in the renderer
  let ascii: string
  try {
    ascii = new URL(`http://${s}/`).hostname
  } catch {
    return { ok: false, error: 'Это не похоже на домен' }
  }
  if (IPV4_RE.test(ascii) || ascii.includes(':') || ascii.startsWith('[')) {
    return { ok: false, error: 'Нужен домен, а не IP-адрес' }
  }
  if (ascii.length > 253) return { ok: false, error: 'Слишком длинный домен' }
  const labels = ascii.split('.')
  if (labels.length < 2) return { ok: false, error: 'Нужен домен с точкой, например example.com' }
  if (!labels.every((l) => LABEL_RE.test(l)) || !TLD_RE.test(labels[labels.length - 1])) {
    return { ok: false, error: 'Это не похоже на домен' }
  }
  // the last part must be a real top-level domain (IANA): «.exe», «.txt» are not
  const tld = labels[labels.length - 1]
  if (!TLDS.has(tld) && !LOCAL_SUFFIXES.includes(tld)) {
    return { ok: false, error: `Такой доменной зоны нет (.${tld}) — проверьте адрес` }
  }
  if (PUBLIC_SUFFIXES.includes(ascii)) {
    return { ok: false, error: 'Это общая зона, а не сайт — укажите конкретный домен в ней' }
  }
  if (LOCAL_SUFFIXES.some((x) => under(ascii, x))) {
    return { ok: false, error: 'Это адрес локальной сети — он и так идёт напрямую' }
  }
  const own = [...OWN_DOMAINS, ...reserved.map((r) => r.trim().toLowerCase()).filter(Boolean)]
  if (own.some((x) => under(ascii, x))) {
    return { ok: false, error: 'Этот домен нужен самому VPN — его нельзя добавить' }
  }
  return { ok: true, domain: ascii }
}

/** Adds a domain to the list (normalized, no duplicates, the limit kept). */
export function addZapretDomain(
  list: string[],
  raw: string,
  reserved: string[] = []
): { ok: true; list: string[] } | { ok: false; error: string } {
  const r = normalizeZapretDomain(raw, reserved)
  if (!r.ok) return r
  if (list.includes(r.domain)) return { ok: false, error: 'Этот домен уже в списке' }
  if (list.length >= ZAPRET_CUSTOM_MAX) {
    return { ok: false, error: `Не больше ${ZAPRET_CUSTOM_MAX} доменов` }
  }
  return { ok: true, list: [...list, r.domain] }
}

/** Settings from the store / IPC → only known services, valid domains, the limit kept. */
export function sanitizeZapretSettings(
  s: Partial<ZapretSettings> | null | undefined
): ZapretSettings {
  const services = ZAPRET_SERVICE_IDS.filter((id) => s?.services?.includes(id))
  const custom: string[] = []
  for (const d of s?.custom ?? []) {
    if (custom.length >= ZAPRET_CUSTOM_MAX) break
    const r = normalizeZapretDomain(String(d))
    if (r.ok && !custom.includes(r.domain)) custom.push(r.domain)
  }
  return {
    enabled: s?.enabled === true,
    services: s?.services ? services : [...DEFAULT_ZAPRET.services],
    custom,
    warned: s?.warned === true
  }
}

/** The text of an item's state for the screen. */
export function zapretStateText(item: Pick<ZapretItem, 'state'>): string {
  switch (item.state) {
    case 'direct':
      return 'напрямую ✓'
    case 'vpn':
      return 'через VPN — напрямую не открылся'
    case 'checking':
      return 'проверяется'
    default:
      return 'выключено'
  }
}

// ---------------------------------------------------------------------------
// «Правила» (0.7.1): how each service / own site goes right now. The user's
// rules are checked before the zapret sets (rules/compile.ts), so a rule that
// matches the service's domains wins — shown as such.
// ---------------------------------------------------------------------------

/** domains a user rule is compared with, and the geosite sets that hold the service */
const SERVICE_MATCH: Record<ZapretServiceId, { domains: string[]; geosite: string[] }> = {
  youtube: {
    domains: ['youtube.com', 'googlevideo.com', 'ytimg.com', 'youtu.be', 'ggpht.com'],
    geosite: ['youtube', 'google']
  },
  discord: {
    domains: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media'],
    geosite: ['discord']
  }
}

/** the subset of a routing rule this needs (no import of the rules types into the renderer bundle twice) */
export interface RuleLike {
  enabled: boolean
  conditionType: string
  value: string
  action: string
}

function ruleHits(r: RuleLike, domains: string[], geosite: string[]): boolean {
  const v = r.value.trim().toLowerCase()
  if (!v) return false
  switch (r.conditionType) {
    case 'Domain':
      return domains.includes(v)
    case 'DomainSuffix':
      return domains.some((d) => d === v || d.endsWith(`.${v}`) || v.endsWith(`.${d}`))
    case 'DomainKeyword':
      return domains.some((d) => d.includes(v))
    case 'DomainRegex':
      try {
        const re = new RegExp(r.value)
        return domains.some((d) => re.test(d))
      } catch {
        return false
      }
    case 'GeoSite':
      return geosite.includes(v)
    default:
      return false
  }
}

/** The first enabled user rule that catches this item: its action, else null. */
export function userRuleFor(key: string, rules: readonly RuleLike[]): string | null {
  const domains = key.startsWith('d:')
    ? [key.slice(2)]
    : (SERVICE_MATCH[key as ZapretServiceId]?.domains ?? [])
  const geosite = key.startsWith('d:') ? [] : (SERVICE_MATCH[key as ZapretServiceId]?.geosite ?? [])
  for (const r of rules) {
    if (r.enabled && ruleHits(r, domains, geosite)) return r.action
  }
  return null
}

export type ZapretRoute =
  | 'direct'
  | 'partial'
  | 'vpn_failed'
  | 'vpn_off'
  | 'user_vpn'
  | 'user_direct'
  | 'user_block'
  | 'user_zapret'
  | 'checking'
  | 'waiting'

/** How an item goes now: the user's rules first, then zapret's state. */
export function zapretRoute(
  item: Pick<ZapretItem, 'key' | 'state'>,
  phase: ZapretPhase,
  rules: readonly RuleLike[]
): ZapretRoute {
  const rule = userRuleFor(item.key, rules)
  if (rule === 'DIRECT') return 'user_direct'
  if (rule === ZAPRET_ACTION) return 'user_zapret'
  if (rule === 'REJECT' || rule === 'BLOCK') return 'user_block'
  if (rule) return 'user_vpn'
  if (phase === 'off') return 'vpn_off'
  if (phase === 'idle') return 'waiting'
  if (item.state === 'direct') return 'direct'
  if (item.state === 'partial') return 'partial'
  if (item.state === 'vpn') return 'vpn_failed'
  return 'checking'
}

/** The pill's text: the route + the item's note («Напрямую + zapret ✓ (видео по QUIC)»). */
export function zapretRouteText(route: ZapretRoute, note?: string): string {
  const base = ZAPRET_ROUTE_TEXT[route]
  if (!note || (route !== 'direct' && route !== 'partial')) return base
  return route === 'partial' ? `${base}: ${note}` : `${base} (${note})`
}

export const ZAPRET_ROUTE_TEXT: Record<ZapretRoute, string> = {
  direct: 'Напрямую + zapret ✓',
  partial: 'Частично напрямую',
  vpn_failed: 'Через VPN — напрямую не открылся',
  vpn_off: 'Через VPN — zapret выключен',
  user_vpn: 'Ваше правило важнее: VPN',
  user_direct: 'Ваше правило: напрямую',
  user_block: 'Ваше правило: заблокировано',
  user_zapret: 'Ваше правило: напрямую + zapret',
  checking: 'Проверяется…',
  waiting: 'Включится вместе с VPN'
}

// ---------------------------------------------------------------------------
// The rule action «Напрямую + zapret» (0.7.2): the traffic of the rule goes
// direct, its domains / addresses are given to zapret (winws), it is checked
// like an own site (a TLS handshake = reachable) and goes back through the VPN
// when it does not open — unless the user turned that off (`zapretFallback`).
// zapret off / broken → the rule is plain «Напрямую». Not every condition can
// be given to zapret: winws filters by a host name list or an address list.
// ---------------------------------------------------------------------------

export const ZAPRET_ACTION = 'ZAPRET'

/** what zapret gets from a rule, or why it can't take it */
export type ZapretRuleTarget =
  | { ok: true; kind: 'domain'; value: string }
  | { ok: true; kind: 'ip'; value: string }
  | { ok: true; kind: 'service'; value: ZapretServiceId }
  /**
   * 0.7.4: a program — its traffic goes direct, the addresses it talks to on
   * TCP 80/443 and QUIC 443 are given to zapret (ZapretService, processIps.ts);
   * nothing is checked, never back to the VPN
   */
  | { ok: true; kind: 'process'; value: string }
  | { ok: false; reason: string }

/** what zapret does for a program (the rule list, the rule editor) */
export const ZAPRET_PROCESS_NOTE = 'порты 80/443'
export const ZAPRET_PROCESS_HINT =
  'Программа идёт напрямую, а zapret снимает замедление провайдера с её трафика на портах 80 и 443 (TCP и QUIC). Остальное — например игровой UDP на других портах — идёт просто напрямую, без zapret. Откат в VPN для программ не делается.'


/** the widest range zapret takes from a rule: /8 (IPv4), /32 (IPv6) — the broker refuses wider */
export const ZAPRET_MIN_MASK4 = 8
export const ZAPRET_MIN_MASK6 = 32

const DEC_RE = /^(?:0|[1-9][0-9]{0,2})$/

/**
 * An IPv4 / IPv6 address or range in the canonical form the broker takes
 * (dpiBroker.ts Test-UserIp): no leading zeros, IPv6 compressed lower case,
 * not wider than /8 · /32 — or why not.
 */
export function zapretCidrCheck(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const bad = { ok: false as const, reason: 'Нужен IP-адрес или подсеть, например 203.0.113.0/24' }
  const s = raw.trim().toLowerCase()
  const [addr, mask, extra] = s.split('/')
  if (extra !== undefined || !addr) return bad
  if (mask !== undefined && !DEC_RE.test(mask)) return bad
  const bits = mask === undefined ? null : Number(mask)
  const parts = addr.split('.')
  if (!addr.includes(':')) {
    if (parts.length !== 4 || !parts.every((x) => DEC_RE.test(x) && Number(x) <= 255)) return bad
    if (bits !== null && bits > 32) return bad
    if (bits !== null && bits < ZAPRET_MIN_MASK4) {
      return { ok: false, reason: `Слишком широкая подсеть для zapret — не шире /${ZAPRET_MIN_MASK4}` }
    }
    return { ok: true, value: s }
  }
  if (!/^[0-9a-f:.]{2,45}$/.test(addr)) return bad
  let canon: string
  try {
    // the URL parser is in main and in the renderer: it gives the canonical form
    canon = new URL(`http://[${addr}]/`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return bad
  }
  if (bits !== null && bits > 128) return bad
  if (bits !== null && bits < ZAPRET_MIN_MASK6) {
    return { ok: false, reason: `Слишком широкая подсеть для zapret — не шире /${ZAPRET_MIN_MASK6}` }
  }
  return { ok: true, value: bits === null ? canon : `${canon}/${bits}` }
}

/** zapretCidrCheck: the canonical value, else null */
export function zapretCidr(raw: string): string | null {
  const r = zapretCidrCheck(raw)
  return r.ok ? r.value : null
}

/** The part of a rule zapret can take («Напрямую + zapret»), or the reason it can't. */
export function zapretRuleTarget(r: Pick<RuleLike, 'conditionType' | 'value'>): ZapretRuleTarget {
  const v = r.value.trim()
  switch (r.conditionType) {
    case 'Domain':
    case 'DomainSuffix': {
      const d = normalizeZapretDomain(v)
      return d.ok ? { ok: true, kind: 'domain', value: d.domain } : { ok: false, reason: d.error }
    }
    case 'IPCIDR': {
      const c = zapretCidrCheck(v)
      return c.ok ? { ok: true, kind: 'ip', value: c.value } : { ok: false, reason: c.reason }
    }
    case 'GeoSite': {
      const id = v.toLowerCase()
      if (id === 'youtube' || id === 'discord') return { ok: true, kind: 'service', value: id }
      return {
        ok: false,
        reason:
          'zapret знает только наборы youtube и discord — для других впишите домены правилом «Домен»'
      }
    }
    case 'DomainKeyword':
      return {
        ok: false,
        reason: 'Слово в домене нельзя передать zapret — укажите сам домен правилом «Домен»'
      }
    case 'DomainRegex':
      return { ok: false, reason: 'Шаблон нельзя передать zapret — укажите сами домены' }
    case 'ProcessName':
    case 'ProcessPath':
      return v ? { ok: true, kind: 'process', value: v } : { ok: false, reason: 'Укажите программу' }
    case 'GeoIP':
      return { ok: false, reason: 'Набор geoip слишком велик для zapret — укажите подсети' }
    case 'DstPort':
      return { ok: false, reason: 'По порту zapret не работает — укажите домен или IP' }
    default:
      return { ok: false, reason: 'Это условие нельзя передать zapret' }
  }
}

/** Russian text of a «Напрямую + zapret» rule's state (the rule list). */
export function zapretRuleText(s: ZapretRuleState | undefined): string {
  switch (s?.state) {
    case 'direct':
      return s.note ? `Напрямую + zapret — ${s.note}` : 'Напрямую + zapret ✓'
    case 'vpn':
      return 'Напрямую не открылся — через VPN'
    case 'checking':
      return 'zapret: проверяется…'
    default:
      return 'Напрямую (без zapret)'
  }
}
