import { setMaxListeners } from 'node:events'
import { BlockList, isIP } from 'node:net'
import type { RoutingRule, TunServiceInfo } from '@shared/types'
import {
  ZAPRET_ACTION,
  ZAPRET_CUSTOM_MAX,
  ZAPRET_SERVICES,
  addZapretDomain,
  zapretRuleTarget,
  type ZapretItem,
  type ZapretPhase,
  type ZapretRuleState,
  type ZapretRuleTarget,
  type ZapretServiceId,
  type ZapretSettings,
  type ZapretView
} from '@shared/zapret'
import { NO_ZAPRET, type ZapretRouting } from '../rules/compile'
import { customTargets, SERVICE_DEFS, type CheckTarget } from './lists'
import { STRATEGIES, strategyById } from './strategies'
import {
  customKey,
  itemKeys,
  routeKeyOf,
  routeKeys,
  routeKeysOf,
  YT_PAGES,
  YT_QUIC,
  YT_VIDEO,
  zapretRouting
} from './routing'
import type { DirectPath, DohServer, NetworkInfo, TargetResult } from './checks'
import { DpiStartError, type DpiDaemonLike, type DpiRequest } from './DpiDaemon'

// ---------------------------------------------------------------------------
// «Ускорение без VPN (zapret)» on the app side:
//   VPN connected + switched on → every item goes through the VPN first; the
//     strategy remembered for this network starts (first time here: a pick);
//     every item is checked directly → the ones that open go direct;
//   every ~10 min, and when the network changes → checked again; an item
//     that stops opening goes back through the VPN at once; if one that worked
//     stops (and fails once more a few seconds later), the strategy is picked
//     again (at most every 30 min per network);
//   0.7.3: a check is light — the current strategy only, ≤ 2 connections at a
//     time, one video node (the ones found are reused for hours), every probe
//     aborted the moment zapret / the VPN goes off; its log line names the
//     time, the duration and the connections it opened (to line up with lags);
//   «Подобрать заново» → a pick by hand;
//   VPN off / switched off / app quit → winws stops, the sets are emptied.
// A pick (like utils\test zapret.ps1, lighter): the strategies in order, each
// checked; the first that opens every item wins, else the one that opens the
// most; ~2 minutes at most. Remembered per network (checks.ts currentNetwork).
// Every dependency is injected — unit tested with mocks in ZapretService.test.ts.
// ---------------------------------------------------------------------------

export interface StrategyMemo {
  /** null = nothing worked on this network */
  id: string | null
  at: number
  /**
   * 2 = picked with the check of a real YouTube video node (0.7.1); a memo of
   * 0.7.0 (no `v`) is picked again — its «2 из 2» never saw the video
   */
  v?: number
  /** the items this strategy opened when it was picked */
  ok?: string[]
  /**
   * 0.7.2: the last strategies that opened YouTube's video on this network
   * (newest first, ≤ 3) — a pick checks them first and prefers them
   */
  good?: { id: string; at: number; ok: string[] }[]
}

const MEMO_VERSION = 2

export interface ZapretDeps {
  /** this build ships cipherway-dpi.exe and its files */
  available: boolean
  getSettings: () => ZapretSettings
  setSettings: (s: ZapretSettings) => void
  getMemory: () => Record<string, StrategyMemo>
  setMemory: (m: Record<string, StrategyMemo>) => void
  /** the VPN is connected, and in which mode */
  vpn: () => { running: boolean; tun: boolean }
  service: {
    status(): Promise<TunServiceInfo>
    install(): Promise<'ok' | 'cancelled' | 'failed'>
  }
  daemon: () => Promise<DpiDaemonLike>
  network: () => Promise<NetworkInfo | null>
  pickDoh: (path: DirectPath, signal?: AbortSignal) => Promise<DohServer | null>
  checkTarget: (
    t: CheckTarget,
    doh: DohServer,
    path: DirectPath,
    timeoutMs?: number,
    signal?: AbortSignal
  ) => Promise<TargetResult>
  /**
   * YouTube's video nodes for this client (videoNodes.ts findVideoNodes).
   * Absent (tests) = no video check; [] = none found → YouTube not verified.
   */
  videoNodes?: (doh: DohServer, path: DirectPath, signal?: AbortSignal) => Promise<string[]>
  /** connections the checks opened since the start (probeNet.ts) — for the log */
  connections?: () => number
  /** our VPN servers' addresses (never touched by zapret) */
  excludeIps: () => Promise<string[]>
  /** the subscription has servers (their addresses must be known before IP rules go to zapret) */
  hasServers?: () => boolean
  /** the user's routing rules (their «Напрямую + zapret» ones, 0.7.2) */
  rules?: () => readonly RoutingRule[]
  /** the way of a «Напрямую + zapret» rule changed: the rules go to the core again */
  rulesChanged?: () => void
  /** names an own domain may not be (the subscription host, the servers) */
  reserved: () => string[]
  /** puts the sets into the running core (no-op while disconnected) */
  applyRouting: (r: ZapretRouting) => Promise<void>
  /** another DPI bypass runs (readable name), null = none */
  foreignDpi: () => Promise<string | null>
  /** a winws of ours outlived its broker (app crash) */
  orphanRunning?: () => Promise<boolean>
  publish: (v: ZapretView) => void
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  now?: () => number
  /** ms; tests make them short */
  checkEveryMs?: number
  netPollMs?: number
  pickBudgetMs?: number
  settleMs?: number
  /** the whole direct check of all items */
  checkBudgetMs?: number
  /** a failure of the current strategy is checked once more after this long */
  confirmMs?: number
}

/** how often a broken strategy may be re-picked by itself, per network */
const AUTO_PICK_GAP_MS = 30 * 60_000
/** «nothing works here» is retried after this long */
const NOTHING_RETRY_MS = 6 * 60 * 60_000
/** own domains checked during a pick (all of them in the regular checks) */
const PICK_CUSTOM_MAX = 8
const MEMORY_MAX = 30
/** a target of a pick gets this long (failing strategies are many, the budget ~3 min) */
const PICK_TARGET_MS = 5000
/** a whole pick, re-checks of the best included (0.7.2) */
const PICK_BUDGET_MS = 170_000
/** the first pass of a pick leaves this much for re-checking the best ones */
const CONFIRM_RESERVE_MS = 40_000
/** this many of the best strategies of the first pass are checked once more */
const CONFIRM_TOP = 3
/** a strategy that opened YouTube's video here is tried first this long */
const GOOD_TTL_MS = 7 * 24 * 60 * 60_000
/** own domains / «Напрямую + zapret» rules given to zapret at most */
const RULE_CHECK_MAX = 50
/** the video nodes found are reused this long by a pick (per network) */
const NODES_TTL_MS = 30 * 60_000
/** … and by the regular check (0.7.3: the watch page is ~1 MB — not every 30 min) */
const NODES_KEEP_MS = 6 * 60 * 60_000
/** the regular check: at most this many connections at a time (0.7.3; 12 before) */
const CHECK_PARALLEL = 2
/** … a target this long at most */
const CHECK_TARGET_MS = 6000
/** … the whole check at most (scaled to the number of targets, at least a minute) */
const CHECK_BUDGET_MAX_MS = 5 * 60_000
/** a failure of the current strategy is checked once more after this long, before a re-pick */
const CONFIRM_MS = 5000

// --- the fallback by live traffic (0.7.1) -----------------------------------
// A connection the zapret set sent direct that got NOTHING back for this long
// counts as «no answer» (the monitor's «Нет ответа» uses 4 s; a TLS ClientHello
// eaten by DPI never gets an answer, a slow server answers well within 5 s).
export const LIVE_STALL_MS = 5000
/**
 * this many such connections of one item within LIVE_WINDOW_MS → it goes back
 * through the VPN at once. One stalled connection is a dead server or a lost
 * packet; three different ones within a minute (a video page opens dozens) is
 * the DPI. Not 2: a page with two dead trackers must not flip YouTube.
 */
export const LIVE_STALLS = 3
export const LIVE_WINDOW_MS = 60_000
/**
 * 0.7.2: connections closed by OUR reconnection (new rules, the sets changed,
 * another server) time out right after it — for this long after such a moment
 * nothing counts as «no answer» (the log of 0.7.1: «переподключено
 * соединений: 1» and the fallback in the same second)
 */
export const LIVE_QUIET_MS = 15_000
/** re-checked this long after such a fallback (not at once: no flip-flop) */
export const LIVE_RECHECK_MS = 3 * 60_000
/** a second fallback of the same item within this time keeps it in the VPN this long */
export const LIVE_REPEAT_MS = 30 * 60_000

// --- DNS: the app switches the direct DoH when the core says it fails -------
// sing-box has no fallback between DNS servers: «dns: exchange failed for x:
// dial tcp 8.8.8.8:443: i/o timeout» → after this many in a minute the zapret
// domains move to the other DoH (the rule-sets cw-z-dn / cw-z-dn2) and stay
// there for DNS_HOLD_MS (the periodic check does not switch back meanwhile).
export const DNS_FAILS = 2
export const DNS_HOLD_MS = 30 * 60_000
const DNS_FAIL_RE = /exchange failed for .*?\b(8\.8\.8\.8|1\.1\.1\.1):(?:443|853)\b/

/** waits `ms`, or less: the signal aborting ends it at once */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** «14:03:27» — the log line of a check / a pick */
const clock = (ms: number): string => new Date(ms).toLocaleTimeString('ru-RU', { hour12: false })

function deadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(fallback)
      }
    )
  })
}

const ERROR_WORDS: Record<string, string> = {
  dns: 'не удалось узнать адрес',
  timeout: 'нет ответа',
  'http:closed': 'соединение оборвалось',
  'http:bad': 'странный ответ',
  'tls:ECONNRESET': 'соединение сброшено',
  'tls:ECONNREFUSED': 'соединение отклонено',
  'tls:ETIMEDOUT': 'нет ответа',
  'tls:EADDRNOTAVAIL': 'сеть сменилась'
}

export function failureText(r: TargetResult): string {
  const why = ERROR_WORDS[r.error ?? ''] ?? (r.error?.startsWith('tls:') ? 'ошибка TLS' : 'ошибка')
  return `${r.host}: ${why}`
}

/** Russian text of a broker refusal / failure. */
export function dpiErrorText(err: unknown): string {
  if (err instanceof DpiStartError) {
    switch (err.code) {
      case 'foreign_dpi':
        if (err.detail?.includes('WinDivert')) {
          return 'В Windows работает драйвер WinDivert другой программы (GoodbyeDPI, другой zapret и т. п.) — закройте её или перезагрузите компьютер. До тех пор zapret CipherWay не запускается, чтобы они не мешали друг другу.'
        }
        return `Запущен другой обход блокировок (${err.detail ?? 'zapret / GoodbyeDPI'}) — zapret CipherWay не запускается, чтобы они не мешали друг другу.`
      case 'dpi_busy':
        return 'zapret CipherWay уже работает у другого пользователя Windows.'
      case 'bad_request':
        return 'Служба отклонила список доменов — удалите последние добавленные.'
      case 'task':
      case 'timeout':
        return 'Служба CipherWay не отвечает — обновите её в «Настройках» (кнопка «Обновить службу»).'
      default:
        return `zapret не запустился: ${err.detail || err.message}`
    }
  }
  return `zapret не запустился: ${err instanceof Error ? err.message : String(err)}`
}

/** the part of a Clash API connection the live fallback reads */
export interface LiveConnection {
  id: string
  rule?: string
  start?: string
  download?: number
  metadata?: { host?: string; network?: string; destinationIP?: string }
}

interface ItemState {
  state: ZapretItem['state']
  detail?: string
  note?: string
}

/** a probe's verdict for one route key */
interface KeyResult {
  ok: boolean
  detail?: string
  note?: string
  /** an own domain without an address (its subdomains decide) */
  noaddr?: boolean
}

/** a «Напрямую + zapret» rule zapret can take */
interface ZRule {
  key: string
  rule: RoutingRule
  target: Extract<ZapretRuleTarget, { ok: true }>
}

const ruleKey = (id: string): string => `r:${id}`

/**
 * An address / range of a rule as node:net sees it: canonical (the form
 * zapretCidr gave, re-checked here), its BlockList; null = not sent anywhere.
 */
export function ipRange(v: string): { value: string; list: BlockList } | null {
  const [addr, mask] = v.split('/')
  const fam = isIP(addr)
  if (fam === 0) return null
  const type = fam === 6 ? 'ipv6' : 'ipv4'
  const bits = mask === undefined ? (fam === 6 ? 128 : 32) : Number(mask)
  if (!/^[0-9]{1,3}$/.test(String(bits))) return null
  // leading zeros / another spelling: not the canonical form → not sent
  if (fam === 4 && addr.split('.').some((x) => x.length > 1 && x.startsWith('0'))) return null
  try {
    const list = new BlockList()
    list.addSubnet(addr, bits, type)
    return { value: v, list }
  } catch {
    return null
  }
}

/** a pick's score of one strategy: more is better, in this order */
function score(ok: ReadonlySet<string>, sample: string[]): number[] {
  const usable = sample.filter((k) =>
    k === 'youtube' ? ok.has(YT_PAGES) && (ok.has(YT_VIDEO) || ok.has(YT_QUIC)) : ok.has(k)
  ).length
  const video = (ok.has(YT_VIDEO) ? 1 : 0) + (ok.has(YT_QUIC) ? 1 : 0)
  return [usable, video, ok.size]
}

function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

const detailOf = (s: ItemState | undefined): { detail?: string } =>
  s?.detail ? { detail: s.detail } : {}

export class ZapretService {
  private phase: ZapretPhase = 'off'
  private items = new Map<string, ItemState>()
  private direct = new Set<string>()
  private dns: DohServer = 'primary'
  private strategyId: string | null = null
  private netId: string | null = null
  private source: string | null = null
  private active = false
  /** bumped by every activation / deactivation: old work gives up */
  private gen = 0
  private queue: Promise<unknown> = Promise.resolve()
  private checking = false
  private checkedAt: number | undefined
  private picking: { done: number; total: number } | undefined
  private error: string | undefined
  private warning: string | undefined
  /** our winws is up (the broker runs it) */
  private dpiUp = false
  /** the service has its zapret task (checked once per activation) */
  private serviceOk = false
  private daemonRef: DpiDaemonLike | null = null
  private lastAutoPick = new Map<string, number>()
  private timers: NodeJS.Timeout[] = []
  private lastRouting: string = JSON.stringify(NO_ZAPRET)
  private nodes: { net: string | null; at: number; list: string[] } | null = null
  /** live fallback: item → connection id → when it was seen stalled */
  private stalls = new Map<string, Map<string, number>>()
  /** item → direct is not trusted again before this time (after a live fallback) */
  private liveHold = new Map<string, number>()
  private lastLive = new Map<string, number>()
  private dnsFails: number[] = []
  private dnsHoldUntil = 0
  /** live fallback: nothing counts before this (our own reconnection, LIVE_QUIET_MS) */
  private quietUntil = 0
  /** the ways of the «Напрямую + zapret» rules last given to the core */
  private lastRuleWays = ''
  /** the «Напрямую + zapret» rules zapret last got (rulesUpdated) */
  private lastRulesSig = JSON.stringify([])
  /** which video node a check / a try of a pick uses (alternated) */
  private nodeTurn = 0
  /** aborted by every deactivation: the probes in flight close their sockets at once */
  private ac = new AbortController()
  /** the broker's WinDivert filter: how many of our servers it leaves out (logged on change) */
  private lastWfExcl: number | undefined

  constructor(private d: ZapretDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  // --- view ------------------------------------------------------------------

  view(): ZapretView {
    const s = this.d.getSettings()
    const strategy = strategyById(this.strategyId)
    const items: ZapretItem[] = [
      ...ZAPRET_SERVICES.filter((x) => s.services.includes(x.id)).map((x) => ({
        key: x.id,
        kind: 'service' as const,
        name: x.name,
        ...this.itemState(x.id)
      })),
      ...s.custom.map((dom) => ({
        key: customKey(dom),
        kind: 'custom' as const,
        name: dom,
        ...this.itemState(customKey(dom))
      }))
    ]
    return {
      available: this.d.available,
      settings: s,
      phase: s.enabled ? (this.active ? this.phase : 'idle') : 'off',
      items,
      strategy: strategy ? { id: strategy.id, name: strategy.name } : null,
      checking: this.checking,
      ...(this.picking ? { picking: this.picking } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.warning ? { warning: this.warning } : {}),
      ...(this.zrules().length ? { rules: this.ruleStates() } : {})
    }
  }

  /** an item of the screen: YouTube is three route keys (pages, video TCP, video QUIC) */
  private itemState(key: string): ItemState {
    if (!this.active) return { state: 'idle' }
    if (key !== 'youtube') return this.items.get(key) ?? { state: 'checking' }
    const [p, v, q] = [YT_PAGES, YT_VIDEO, YT_QUIC].map((k) => this.items.get(k))
    if (!p || !v || !q) return { state: 'checking' }
    const P = this.direct.has(YT_PAGES)
    const V = this.direct.has(YT_VIDEO)
    const Q = this.direct.has(YT_QUIC)
    if (P && (V || Q)) {
      return { state: 'direct', ...(V && Q ? {} : { note: V ? 'видео по TCP' : 'видео по QUIC' }) }
    }
    if (P) return { state: 'partial', note: 'сайт напрямую, видео через VPN', ...detailOf(v) }
    if (V || Q) {
      return {
        state: 'partial',
        note: `видео напрямую${V ? '' : ' по QUIC'}, остальное через VPN`,
        ...detailOf(p)
      }
    }
    return { state: 'vpn', ...detailOf(p.detail ? p : v.detail ? v : q) }
  }

  /** the «Напрямую + zapret» rules zapret can take (enabled, a known condition) */
  private zrules(): ZRule[] {
    const out: ZRule[] = []
    for (const rule of this.d.rules?.() ?? []) {
      if (!rule.enabled || rule.action !== ZAPRET_ACTION) continue
      const target = zapretRuleTarget(rule)
      if (target.ok) out.push({ key: ruleKey(rule.id), rule, target })
      if (out.length >= RULE_CHECK_MAX) break
    }
    return out
  }

  /** the state of every «Напрямую + zapret» rule for the rule list */
  private ruleStates(): Record<string, ZapretRuleState> {
    const out: Record<string, ZapretRuleState> = {}
    const s = this.d.getSettings()
    const on = s.enabled && this.active && this.dpiUp
    for (const rule of this.d.rules?.() ?? []) {
      if (!rule.enabled || rule.action !== ZAPRET_ACTION) continue
      const target = zapretRuleTarget(rule)
      if (!target.ok) {
        out[rule.id] = { state: 'plain', detail: target.reason }
        continue
      }
      if (!s.enabled) {
        out[rule.id] = { state: 'plain', detail: 'zapret выключен в «Ускорении без VPN»' }
        continue
      }
      if (!this.active) {
        out[rule.id] = { state: 'plain', detail: 'zapret включится вместе с VPN' }
        continue
      }
      const key = ruleKey(rule.id)
      const it = this.items.get(key)
      if (this.direct.has(key)) {
        out[rule.id] = on
          ? { state: 'direct', ...(it?.note ? { note: it.note } : {}) }
          : { state: 'plain', detail: 'zapret сейчас не работает — напрямую без него' }
      } else if (!it) out[rule.id] = { state: 'checking' }
      else if (rule.zapretFallback === false) {
        out[rule.id] = { state: 'plain', detail: it.detail ?? 'напрямую не открылся' }
      } else out[rule.id] = { state: 'vpn', ...(it.detail ? { detail: it.detail } : {}) }
    }
    return out
  }

  /**
   * The user's rules with «Напрямую + zapret» resolved for the core: «Через
   * VPN» while it does not open directly (and the fallback is on), else
   * «Напрямую» — zapret off / broken / the condition not for zapret included.
   */
  effectiveRules(rules: readonly RoutingRule[]): RoutingRule[] {
    return rules.map((r) => {
      if (r.action !== ZAPRET_ACTION) return r
      return { ...r, action: this.ruleToVpn(r) ? 'PROXY' : 'DIRECT' }
    })
  }

  private ruleToVpn(r: RoutingRule): boolean {
    if (!this.active || r.zapretFallback === false || !zapretRuleTarget(r).ok) return false
    const key = ruleKey(r.id)
    return this.items.has(key) && !this.direct.has(key)
  }

  /** the rules' ways changed → the core gets them again (handlers.ts) */
  private syncRules(): void {
    // only the rules sent through the VPN differ from what the core has (the
    // others are «Напрямую» there anyway; edits of the list apply by themselves)
    const ways = (this.d.rules?.() ?? [])
      .filter((r) => r.action === ZAPRET_ACTION && this.ruleToVpn(r))
      .map((r) => r.id)
      .join(',')
    if (ways === this.lastRuleWays) return
    this.lastRuleWays = ways
    this.noteReconnect()
    this.d.rulesChanged?.()
  }

  /** the user's rules changed (handlers.ts): their zapret part is checked again */
  async rulesUpdated(): Promise<void> {
    // only when the «Напрямую + zapret» rules themselves changed (winws gets new lists)
    const sig = JSON.stringify(
      this.zrules().map((z) => [z.key, z.target.value, z.rule.zapretFallback !== false])
    )
    if (sig === this.lastRulesSig) {
      this.publish()
      return
    }
    this.lastRulesSig = sig
    await this.listsChanged()
  }

  /**
   * Our own reconnection (rules applied, another server, the mode): the
   * connections cut by it are not «no answer» for LIVE_QUIET_MS.
   */
  noteReconnect(): void {
    this.quietUntil = this.now() + LIVE_QUIET_MS
    this.stalls.clear()
  }

  private publish(): void {
    this.d.publish(this.view())
  }

  /** one operation at a time (start, checks, picks, list changes) */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  // --- the user's switches -----------------------------------------------------

  init(): void {
    this.publish()
    // a winws left behind by a crashed app: stopped once, without a UAC prompt
    if (this.d.available && !this.d.vpn().running && this.d.orphanRunning) {
      void this.d
        .orphanRunning()
        .then(async (left) => {
          if (!left) return
          this.d.log('info', 'zapret: остался процесс прошлого запуска — останавливаем')
          await (await this.d.daemon()).cleanup()
        })
        .catch(() => undefined)
    }
  }

  /**
   * On: the service must have its DPI task (one UAC prompt to set it up /
   * update it, only here — never by itself). `accepted`: the one-time warning.
   */
  async setEnabled(on: boolean, accepted = false): Promise<ZapretView> {
    const s = this.d.getSettings()
    this.error = undefined
    if (!on) {
      this.d.setSettings({ ...s, enabled: false })
      await this.deactivate()
      this.publish()
      return this.view()
    }
    if (!this.d.available) {
      this.error = 'В этой сборке нет zapret — переустановите приложение.'
      this.publish()
      return this.view()
    }
    if (!s.warned && !accepted) throw new Error('Сначала подтвердите предупреждение')
    const st = await this.d.service.status().catch(() => ({ state: 'missing' }) as TunServiceInfo)
    // the build's zapret files differ from the pinned release: zapret only is off
    if (st.dpiError) {
      this.d.setSettings({ ...s, warned: s.warned || accepted, enabled: false })
      this.error = st.dpiError
      this.publish()
      return this.view()
    }
    if (st.state !== 'ok' || !st.dpi) {
      this.d.log('info', 'zapret: устанавливаем / обновляем службу CipherWay (запрос прав Windows)')
      const res = await this.d.service.install().catch(() => 'failed' as const)
      if (res !== 'ok') {
        this.d.setSettings({ ...s, warned: s.warned || accepted, enabled: false })
        this.error =
          res === 'cancelled'
            ? 'Без разрешения Windows zapret не запустить: служба CipherWay ставится один раз и потом не спрашивает прав.'
            : 'Не удалось установить службу CipherWay — подробности на странице «Логи».'
        this.publish()
        return this.view()
      }
    }
    this.d.setSettings({ ...s, enabled: true, warned: true })
    this.d.log('info', 'zapret включён')
    if (this.d.vpn().running) await this.activate()
    else this.publish()
    return this.view()
  }

  async setServices(ids: ZapretServiceId[]): Promise<ZapretView> {
    const s = this.d.getSettings()
    const services = ZAPRET_SERVICES.map((x) => x.id).filter((id) => ids.includes(id))
    this.d.setSettings({ ...s, services })
    await this.listsChanged()
    return this.view()
  }

  async addDomain(raw: string): Promise<ZapretView> {
    const s = this.d.getSettings()
    const r = addZapretDomain(s.custom, raw, this.d.reserved())
    if (!r.ok) throw new Error(r.error)
    this.d.setSettings({ ...s, custom: r.list })
    await this.listsChanged()
    return this.view()
  }

  async removeDomain(domain: string): Promise<ZapretView> {
    const s = this.d.getSettings()
    this.d.setSettings({ ...s, custom: s.custom.filter((x) => x !== domain) })
    this.items.delete(customKey(domain))
    this.direct.delete(customKey(domain))
    await this.listsChanged()
    return this.view()
  }

  /**
   * The subscription changed (other servers): the broker gets their addresses
   * to exclude — winws restarted with the same strategy.
   */
  serversChanged(): void {
    if (!this.active || !this.strategyId || !this.dpiUp) return
    const gen = this.gen
    const id = this.strategyId
    void this.serial(async () => {
      if (gen === this.gen && this.strategyId === id) await this.runStrategy(gen, id)
    }).catch(() => undefined)
  }

  /** «Подобрать заново» */
  repick(): Promise<ZapretView> {
    if (!this.active) return Promise.resolve(this.view())
    const gen = this.gen
    return this.serial(async () => {
      await this.pick(gen, true)
      return this.view()
    })
  }

  /** The VPN connected / disconnected (handlers.ts on every status change). */
  async onVpn(running: boolean): Promise<void> {
    if (running) await this.activate()
    else await this.deactivate()
  }

  async shutdown(): Promise<void> {
    await this.deactivate()
  }

  // --- lifecycle -------------------------------------------------------------

  private async activate(): Promise<void> {
    const s = this.d.getSettings()
    if (this.active || !s.enabled || !this.d.available || !this.d.vpn().running) return
    this.active = true
    this.serviceOk = false
    const gen = ++this.gen
    this.ac = new AbortController()
    // a pick runs a dozen probes on this one signal: no false «possible leak» warning
    setMaxListeners(64, this.ac.signal)
    this.error = undefined
    this.warning = undefined
    this.phase = 'starting'
    this.items.clear()
    this.direct.clear()
    // nothing direct before it is confirmed: everything through the VPN for now
    await this.route()
    this.publish()
    this.startTimers(gen)
    void this.serial(async () => {
      if (gen !== this.gen) return
      const net = await this.d.network().catch(() => null)
      this.netId = net?.id ?? null
      this.source = net?.source ?? null
      await this.startFor(gen, true)
    }).catch((err: unknown) => this.fail(gen, err))
  }

  private async deactivate(): Promise<void> {
    const wasActive = this.active
    this.gen++
    // every probe in flight (DoH, TLS, QUIC, the video page) stops right now
    this.ac.abort()
    this.active = false
    this.stopTimers()
    this.phase = 'off'
    this.picking = undefined
    this.checking = false
    this.items.clear()
    this.direct.clear()
    this.strategyId = null
    const daemon = this.daemonRef
    this.daemonRef = null
    this.dpiUp = false
    if (daemon) await daemon.stop().catch(() => undefined)
    if (wasActive || this.lastRouting !== JSON.stringify(NO_ZAPRET)) {
      this.lastRouting = JSON.stringify(NO_ZAPRET)
      await this.d.applyRouting(NO_ZAPRET).catch(() => undefined)
    }
    this.syncRules()
    this.publish()
  }

  private fail(gen: number, err: unknown): void {
    if (gen !== this.gen) return
    this.phase = 'error'
    this.error = err instanceof Error ? err.message : String(err)
    this.d.log('error', `zapret: ${this.error}`)
    this.publish()
  }

  private startTimers(gen: number): void {
    this.stopTimers()
    const check = setInterval(
      () => {
        if (gen !== this.gen) return
        void this.serial(() => this.check(gen, true, false, 'по таймеру')).catch(() => undefined)
      },
      this.d.checkEveryMs ?? 10 * 60_000
    )
    const net = setInterval(() => {
      if (gen !== this.gen) return
      void this.pollNetwork(gen).catch(() => undefined)
    }, this.d.netPollMs ?? 20_000)
    check.unref?.()
    net.unref?.()
    this.timers = [check, net]
  }

  private stopTimers(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  /** the strategy of this network (a pick if none yet), then the direct check */
  private async startFor(gen: number, firstCheck: boolean): Promise<void> {
    const memo = this.netId ? this.d.getMemory()[this.netId] : undefined
    const stale = memo && memo.id === null && this.now() - memo.at > NOTHING_RETRY_MS
    const old = memo && (memo.v ?? 0) < MEMO_VERSION
    if (!memo || stale || old || (memo.id && !strategyById(memo.id))) {
      await this.pick(gen, false)
      return
    }
    this.strategyId = memo.id
    if (memo.id) await this.runStrategy(gen, memo.id)
    else await this.stopDpi()
    if (gen !== this.gen) return
    this.phase = 'running'
    // a remembered strategy that no longer opens what it opened: picked again (rate-limited)
    await this.check(gen, true, false, firstCheck ? 'после подключения' : 'после смены сети')
  }

  private async pollNetwork(gen: number): Promise<void> {
    const net = await this.d.network().catch(() => null)
    if (gen !== this.gen || !net || net.id === this.netId) {
      if (net) this.source = net.source
      return
    }
    this.d.log('info', 'zapret: сеть сменилась — проверяем заново')
    this.netId = net.id
    this.source = net.source
    await this.serial(async () => {
      if (gen !== this.gen) return
      // the broker has already moved winws to the new adapter; the strategy may differ here
      await this.startFor(gen, false)
    })
  }

  /** the lists (services / own domains) changed */
  private async listsChanged(): Promise<void> {
    if (!this.active) {
      this.publish()
      return
    }
    const gen = this.gen
    const keys = new Set(this.checkKeys())
    for (const k of [...this.direct]) if (!keys.has(k)) this.direct.delete(k)
    for (const k of [...this.items.keys()]) if (!keys.has(k)) this.items.delete(k)
    await this.route()
    this.publish()
    await this.serial(async () => {
      if (gen !== this.gen) return
      if (this.strategyId && this.dpiUp) await this.runStrategy(gen, this.strategyId)
      else if (this.strategyId === null && this.netId && !this.d.getMemory()[this.netId]) {
        await this.pick(gen, false)
        return
      }
      await this.check(gen, false, false, 'списки изменились')
    })
  }

  // --- winws through the broker ----------------------------------------------

  private async request(strategy: string): Promise<DpiRequest> {
    const s = this.d.getSettings()
    const services = new Set<ZapretServiceId>(s.services)
    const hosts = [...s.custom]
    let ips: string[] = []
    // the «Напрямую + zapret» rules: their domains into the hostlist, addresses into an ipset
    for (const z of this.zrules()) {
      if (z.target.kind === 'service') services.add(z.target.value)
      else if (z.target.kind === 'domain') {
        if (!hosts.includes(z.target.value) && hosts.length < ZAPRET_CUSTOM_MAX)
          hosts.push(z.target.value)
      } else {
        // one bad rule never spoils the list: it is just left out
        const r = ipRange(z.target.value)
        if (r && !ips.includes(r.value) && ips.length < 512) ips.push(r.value)
      }
    }
    const exclude = await this.d.excludeIps().then(
      (x) => x,
      () => null
    )
    // our servers' addresses unknown: an IP rule could cover one of them — no IP rules then
    if (ips.length && (exclude === null || (exclude.length === 0 && this.d.hasServers?.()))) {
      this.d.log('warn', 'zapret: адреса серверов VPN неизвестны — правила по IP пока без zapret')
      ips = []
    }
    return {
      strategy,
      services: ZAPRET_SERVICES.map((x) => x.id).filter((id) => services.has(id)),
      hosts,
      exclude: (exclude ?? []).slice(0, 512),
      ...(ips.length ? { ips } : {})
    }
  }

  /** winws with this strategy; false = it can't run here (another DPI bypass, the service) */
  private async runStrategy(gen: number, id: string): Promise<boolean> {
    const foreign = await this.d.foreignDpi().catch(() => null)
    if (gen !== this.gen) return false
    if (foreign) {
      this.warning = `Запущен другой обход блокировок (${foreign}) — zapret CipherWay не запускается, чтобы они не мешали друг другу. Проверка сайтов продолжается.`
      await this.stopDpi()
      return false
    }
    this.warning = undefined
    // the service of an older version has no zapret task (never a UAC prompt from here)
    if (!this.daemonRef && !this.serviceOk) {
      const st = await this.d.service.status().catch(() => null)
      if (gen !== this.gen) return false
      this.serviceOk = !!st && st.state === 'ok' && !!st.dpi
      if (!this.serviceOk) {
        this.error =
          st?.dpiError ??
          'Служба CipherWay устарела — выключите и снова включите «Ускорение без VPN»: Windows один раз спросит разрешение и обновит её.'
        return false
      }
    }
    try {
      const daemon = this.daemonRef ?? (await this.d.daemon())
      const req = await this.request(id)
      // the VPN went off meanwhile: never start winws for a deactivated feature
      if (gen !== this.gen) return false
      this.daemonRef = daemon
      const st = await daemon.apply(req)
      if (gen !== this.gen) {
        await daemon.stop().catch(() => undefined)
        return false
      }
      this.dpiUp = st.status === 'running'
      this.noteFilter(st.wfExcl)
      if (st.wait === 'no_network')
        this.d.log('warn', 'zapret: не найден сетевой адаптер с выходом в интернет')
      return this.dpiUp
    } catch (err) {
      this.dpiUp = false
      const text = dpiErrorText(err)
      if (err instanceof DpiStartError && (err.code === 'foreign_dpi' || err.code === 'dpi_busy')) {
        this.warning = text
      } else {
        this.error = text
      }
      this.d.log('warn', `zapret: ${text}`)
      return false
    }
  }

  private noteFilter(n: number | undefined): void {
    if (n === undefined || n === this.lastWfExcl) return
    this.lastWfExcl = n
    if (n > 0)
      this.d.log('info', `zapret: трафик к серверам VPN (адресов: ${n}) не проходит через zapret`)
    else if (n < 0)
      this.d.log('warn', 'zapret: адресов серверов VPN слишком много — их трафик проходит через zapret')
  }

  private async stopDpi(): Promise<void> {
    const daemon = this.daemonRef
    this.daemonRef = null
    this.dpiUp = false
    if (daemon) await daemon.stop().catch(() => undefined)
  }

  // --- checks ------------------------------------------------------------------

  private path(): DirectPath {
    return this.d.vpn().tun && this.source ? { localAddress: this.source } : {}
  }

  /** every key a check decides: the route keys of the items + the «Напрямую + zapret» rules */
  private checkKeys(): string[] {
    return [...routeKeys(this.d.getSettings()), ...this.zrules().map((z) => z.key)]
  }

  private targetsOf(key: string): CheckTarget[] {
    if (key.startsWith('d:')) return customTargets(key.slice(2))
    if (key.startsWith('r:')) {
      const z = this.zrules().find((x) => x.key === key)
      if (!z) return []
      if (z.target.kind === 'domain') return customTargets(z.target.value)
      if (z.target.kind === 'service') {
        return SERVICE_DEFS[z.target.value].targets.map((t) => ({ ...t, route: undefined }))
      }
      // an address: a TLS handshake without SNI; a range: nothing to aim at (live traffic decides)
      const v = z.target.value
      const single = !v.includes('/') || /\/(32|128)$/.test(v)
      return single ? [{ host: v.split('/')[0], http: false, tlsOnly: true }] : []
    }
    if (key === YT_PAGES) return SERVICE_DEFS.youtube.targets.filter((t) => !t.route)
    if (key === YT_VIDEO) return SERVICE_DEFS.youtube.targets.filter((t) => t.route === YT_VIDEO)
    if (key === YT_QUIC) return []
    return [...(SERVICE_DEFS[key as ZapretServiceId]?.targets ?? [])]
  }

  /** the video nodes of this network (reused `maxAge`); null = no video check */
  private async videoHosts(doh: DohServer, maxAge = NODES_TTL_MS): Promise<string[] | null> {
    if (!this.d.videoNodes) return null
    const fresh =
      this.nodes && this.nodes.net === this.netId && this.now() - this.nodes.at < maxAge
    if (!fresh || !this.nodes?.list.length) {
      const signal = this.ac.signal
      const list = await this.d
        .videoNodes(doh, this.path(), signal)
        .catch(() => [] as string[])
      // switched off meanwhile: nothing is remembered from a cut-off search
      if (signal.aborted) return []
      this.nodes = { net: this.netId, at: this.now(), list }
      if (list.length)
        this.d.log('info', `zapret: видеосерверы YouTube для проверки — ${list.join(', ')}`)
    }
    return this.nodes?.list ?? []
  }

  /**
   * key → ok / the first failure, every target of every key (bounded in time).
   * YouTube's video: `nodes` of the found ones (alternated by the caller) over
   * TCP (TLS + GET /generate_204) and over QUIC (one Initial) — one passing
   * node is enough; the redirector over TCP must open too.
   * `parallel` connections at a time; `budgetMs` 'auto' = enough for every
   * target at that pace (≥ 1 min, ≤ CHECK_BUDGET_MAX_MS). No target starts
   * after the budget; the deactivation aborts the ones in flight.
   */
  private async probe(
    keys: string[],
    doh: DohServer,
    budgetMs: number | 'auto',
    targetMs?: number,
    nodes = 2,
    parallel = 12,
    nodesAge = NODES_TTL_MS
  ): Promise<Map<string, KeyResult>> {
    const path = this.path()
    const signal = this.ac.signal
    const out = new Map<string, KeyResult>()
    const jobs = keys.flatMap((key) => this.targetsOf(key).map((t) => ({ key, t })))
    const wantVideo = keys.includes(YT_VIDEO) || keys.includes(YT_QUIC)
    let noVideo = false
    if (wantVideo) {
      const all = await this.videoHosts(doh, nodesAge)
      if (all === null) {
        // no video search (tests): QUIC = the redirector
        if (keys.includes(YT_QUIC))
          jobs.push({ key: YT_QUIC, t: { host: 'redirector.googlevideo.com', http: false, quic: true } })
      } else if (all.length === 0) noVideo = true
      else {
        const n = Math.min(nodes, all.length)
        const pick = Array.from({ length: n }, (_, i) => all[(this.nodeTurn + i) % all.length])
        this.nodeTurn = (this.nodeTurn + 1) % all.length
        for (const host of pick) {
          if (keys.includes(YT_VIDEO)) {
            jobs.push({
              key: YT_VIDEO,
              t: { host, http: true, path: '/generate_204', video: true }
            })
          }
          if (keys.includes(YT_QUIC))
            jobs.push({ key: YT_QUIC, t: { host, http: false, quic: true, video: true } })
        }
      }
    }
    const results: (TargetResult | null)[] = new Array(jobs.length).fill(null)
    const budget =
      budgetMs === 'auto'
        ? Math.min(
            CHECK_BUDGET_MAX_MS,
            Math.max(60_000, Math.ceil(jobs.length / parallel) * ((targetMs ?? 9000) + 1000))
          )
        : budgetMs
    let next = 0
    let over = false
    const worker = async (): Promise<void> => {
      while (next < jobs.length && !over && !signal.aborted) {
        const i = next++
        const { key, t } = jobs[i]
        let r = await this.d.checkTarget(t, doh, path, targetMs, signal)
        // an own domain without an address of its own: www.<domain>
        const own = key.startsWith('d:') || key.startsWith('r:')
        if (
          !r.ok &&
          own &&
          (r.error === 'dns' || r.error === 'noaddr') &&
          !t.host.startsWith('www.') &&
          !signal.aborted
        ) {
          const w = await this.d.checkTarget(
            { ...t, host: `www.${t.host}` },
            doh,
            path,
            targetMs,
            signal
          )
          // www opens or fails for real: it decides; it has no address either: the first answer stays
          if (w.ok || r.error === 'dns' || (w.error !== 'dns' && w.error !== 'noaddr')) r = w
        }
        results[i] = r
      }
    }
    await deadline(
      Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker)),
      budget,
      undefined
    )
    // the budget is over: no new target starts (the ones in flight end by their own deadline)
    over = true
    for (const key of keys) {
      // nothing to aim at (an address range of a rule): direct, live traffic decides
      const none = key.startsWith('r:') && !jobs.some((j) => j.key === key)
      out.set(key, none ? { ok: true, note: 'проверяется по трафику' } : { ok: true })
    }
    const nodeOk = new Map<string, boolean>()
    const nodeFail = new Map<string, string>()
    jobs.forEach(({ key, t }, i) => {
      const r = results[i] ?? { host: t.host, ok: false, error: 'timeout' }
      if (t.video) {
        // a video node: any one of them is enough
        if (r.ok) nodeOk.set(key, true)
        else if (!nodeFail.has(key)) {
          const how = t.quic ? 'видео по QUIC не открывается напрямую' : 'видео не открывается напрямую'
          nodeFail.set(key, `${how} — ${failureText(r)}`)
        }
        return
      }
      const cur = out.get(key)
      if (r.ok && r.unconfirmed && cur?.ok && !cur.note) {
        out.set(key, { ok: true, note: 'сертификат не подтвердился — решает живой трафик' })
        return
      }
      if (r.error === 'noaddr' && cur?.ok) {
        out.set(key, { ok: true, noaddr: true, note: 'нет адреса — проверяется по поддоменам' })
        return
      }
      if (!r.ok && cur?.ok) {
        out.set(key, {
          ok: false,
          detail: t.quic ? `QUIC: ${failureText(r)}` : failureText(r)
        })
      }
    })
    for (const [key, why] of nodeFail) {
      if (!nodeOk.get(key) && out.get(key)?.ok) out.set(key, { ok: false, detail: why })
    }
    if (noVideo) {
      for (const k of [YT_VIDEO, YT_QUIC]) {
        if (keys.includes(k) && out.get(k)?.ok) {
          out.set(k, { ok: false, detail: 'не найден видеосервер YouTube — видео не проверить' })
        }
      }
    }
    // an own domain without an address: its listed subdomains decide (none listed = direct)
    for (const [key, r] of out) {
      if (!r.noaddr) continue
      const dom = key.slice(2)
      const subs = [...out].filter(
        ([k]) => (k.startsWith('d:') || k.startsWith('r:')) && k !== key && this.domainOf(k)?.endsWith(`.${dom}`)
      )
      if (subs.length && !subs.some(([, x]) => x.ok && !x.noaddr)) {
        out.set(key, { ok: false, detail: `${dom}: нет адреса, а поддомены не открываются` })
      }
    }
    return out
  }

  /** the domain of an own-domain / domain-rule key */
  private domainOf(key: string): string | null {
    if (key.startsWith('d:')) return key.slice(2)
    const z = this.zrules().find((x) => x.key === key)
    return z?.target.kind === 'domain' ? z.target.value : null
  }

  /**
   * The direct check of every item → the sets; `auto`: a broken strategy is
   * re-picked (after one more look at what failed). Light (0.7.3): the
   * strategy that runs, CHECK_PARALLEL connections at a time, one video node;
   * `why` goes into its log line (with the time and the connections it opened).
   */
  private async check(gen: number, auto: boolean, afterPick = false, why = ''): Promise<void> {
    if (gen !== this.gen) return
    const keys = this.checkKeys()
    const signal = this.ac.signal
    const t0 = this.now()
    const c0 = this.d.connections?.() ?? 0
    let verdict = ''
    let logged = false
    this.checking = true
    this.publish()
    try {
      const doh = await this.d.pickDoh(this.path(), signal).catch(() => null)
      if (gen !== this.gen) return
      // after a pick nothing «stopped» opening: the strategy is new
      const before = afterPick ? new Set<string>() : new Set(this.direct)
      // after the core reported the DoH failing, keep the other one for a while
      if (doh && this.now() >= this.dnsHoldUntil) this.dns = doh
      const res = doh
        ? await this.probe(
            keys,
            doh,
            this.d.checkBudgetMs ?? 'auto',
            CHECK_TARGET_MS,
            1,
            CHECK_PARALLEL,
            NODES_KEEP_MS
          )
        : new Map(
            keys.map((k) => [
              k,
              { ok: false, detail: 'DNS-серверы 8.8.8.8 и 1.1.1.1 не отвечают напрямую' }
            ])
          )
      if (gen !== this.gen) return
      this.setResults(keys, res)
      verdict = this.directCount(keys)
      this.checkedAt = this.now()
      if (this.phase === 'starting') this.phase = 'running'
      await this.route()
      const lost = [...before].filter((k) => keys.includes(k) && !this.direct.has(k))
      if (lost.length)
        this.d.log('warn', `zapret: напрямую перестало открываться — ${lost.join(', ')}; через VPN`)
      if (afterPick) {
        const failed = keys.filter((k) => !this.direct.has(k))
        if (failed.length)
          this.d.log('info', `zapret: напрямую не открылся — ${failed.join(', ')}; через VPN`)
      }
      // the strategy broke: an item it opened when it was picked (or was open a moment ago) fails
      const memo = this.netId ? this.d.getMemory()[this.netId] : undefined
      const failed = keys.filter(
        (k) => !this.direct.has(k) && (before.has(k) || (memo?.ok ?? []).includes(k))
      )
      // without a DoH nothing can be judged: never a pick from that
      if (auto && failed.length && this.strategyId && doh) {
        // a lost packet / a busy node is not a broken strategy: what failed, once more, a bit later
        await sleep(this.d.confirmMs ?? CONFIRM_MS, signal)
        if (gen !== this.gen) return
        const again = await this.probe(
          failed,
          doh,
          'auto',
          CHECK_TARGET_MS,
          1,
          CHECK_PARALLEL,
          NODES_KEEP_MS
        )
        if (gen !== this.gen) return
        const back = failed.filter(
          (k) => again.get(k)?.ok && (this.liveHold.get(k) ?? 0) <= this.now()
        )
        if (back.length) {
          for (const k of back) {
            const note = again.get(k)?.note
            this.direct.add(k)
            this.items.set(k, { state: 'direct', ...(note ? { note } : {}) })
          }
          this.d.log('info', `zapret: со второй попытки открылось — ${back.join(', ')}; напрямую`)
          await this.route()
          verdict = this.directCount(keys)
        }
        if (back.length < failed.length && this.canAutoPick()) {
          this.checking = false
          this.logCheck(why, t0, c0, verdict)
          logged = true
          this.d.log('info', 'zapret: стратегия перестала работать — подбираем заново')
          await this.pick(gen, false)
        }
      }
    } finally {
      if (!logged && why) {
        // switched off midway: said so (the probes were aborted with it)
        this.logCheck(why, t0, c0, gen === this.gen && verdict ? verdict : 'прервана')
      }
      if (gen === this.gen) {
        this.checking = false
        this.publish()
      }
    }
  }

  private directCount(keys: string[]): string {
    return `напрямую ${keys.filter((k) => this.direct.has(k)).length} из ${keys.length}`
  }

  /** «перепроверка (по таймеру) — 14:03:27–14:03:35 (8 с), соединений: 11, напрямую 3 из 3» */
  private logCheck(why: string, t0: number, c0: number, verdict: string): void {
    const t1 = this.now()
    const conns = this.d.connections ? `, соединений: ${this.d.connections() - c0}` : ''
    this.d.log(
      'info',
      `zapret: перепроверка${why ? ` (${why})` : ''} — ${clock(t0)}–${clock(t1)} (${Math.round((t1 - t0) / 1000)} с)${conns}, ${verdict || 'прервана'}`
    )
  }

  private setResults(keys: string[], res: Map<string, KeyResult>): void {
    this.direct.clear()
    for (const key of keys) {
      const r = res.get(key)
      const held = (this.liveHold.get(key) ?? 0) > this.now()
      if (r?.ok && held) {
        // went back to the VPN because live connections got no answer: not yet
        this.items.set(key, {
          state: 'vpn',
          detail: 'соединения напрямую недавно не получали ответа — проверим ещё раз позже'
        })
      } else if (r?.ok) {
        this.direct.add(key)
        this.items.set(key, { state: 'direct', ...(r.note ? { note: r.note } : {}) })
      } else {
        this.items.set(key, { state: 'vpn', ...(r?.detail ? { detail: r.detail } : {}) })
      }
    }
  }

  private canAutoPick(): boolean {
    const key = this.netId ?? '-'
    const last = this.lastAutoPick.get(key) ?? 0
    if (this.now() - last < AUTO_PICK_GAP_MS) return false
    this.lastAutoPick.set(key, this.now())
    return true
  }

  /** the sets into the core, only when they changed */
  private async route(): Promise<void> {
    this.syncRules()
    const r = zapretRouting(this.d.getSettings(), this.direct, this.dns)
    const text = JSON.stringify(r)
    if (text === this.lastRouting) return
    this.lastRouting = text
    // the connections that change their way are closed: not «no answer»
    this.noteReconnect()
    await this.d.applyRouting(r).catch((err: unknown) => {
      this.d.log(
        'warn',
        `zapret: правила не применились — ${err instanceof Error ? err.message : err}`
      )
    })
  }

  /**
   * The sets a (re)starting core gets: what was confirmed so far — nothing
   * direct before the first check of this connection.
   */
  currentRouting(): ZapretRouting {
    return zapretRouting(this.d.getSettings(), this.active ? this.direct : new Set(), this.dns)
  }

  // --- live traffic (0.7.1) ---------------------------------------------------------

  /** which route key / rule a connection belongs to (null = none of ours) */
  private keyOfConn(c: LiveConnection): string | null {
    const rule = c.rule ?? ''
    const host = (c.metadata?.host ?? '').toLowerCase()
    const net = c.metadata?.network ?? 'tcp'
    if (/cw-z-d\b/.test(rule)) return routeKeyOf(this.d.getSettings(), host, net)
    // a «Напрямую + zapret» rule goes through a direct slot of the user's rules
    if (!/cw-\d+-d\b/.test(rule)) return null
    const ip = c.metadata?.destinationIP ?? ''
    let best: { key: string; len: number } | null = null
    for (const z of this.zrules()) {
      const v = z.target.value
      if (z.target.kind === 'domain' && host && (host === v || host.endsWith(`.${v}`))) {
        if (!best || v.length > best.len) best = { key: z.key, len: v.length }
      } else if (z.target.kind === 'ip' && ip && isIP(ip)) {
        const r = ipRange(v)
        if (r?.list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')) best ??= { key: z.key, len: 0 }
      }
    }
    return best?.key ?? null
  }

  /**
   * Every /connections snapshot of the core (once a second): a direct
   * connection of a zapret item (TCP or QUIC) that got nothing back for
   * LIVE_STALL_MS is counted; LIVE_STALLS of them within LIVE_WINDOW_MS → that
   * route key goes back through the VPN at once and is re-checked after
   * LIVE_RECHECK_MS. Never right after our own reconnection (LIVE_QUIET_MS):
   * those are cut by us, not by the DPI.
   */
  onConnections(raw: { connections?: LiveConnection[] | null }): void {
    if (!this.active || this.direct.size === 0) return
    const now = this.now()
    if (now < this.quietUntil) return
    for (const c of raw.connections ?? []) {
      if ((c.download ?? 0) > 0) continue
      const start = c.start ? Date.parse(c.start) : NaN
      if (!Number.isFinite(start) || now - start < LIVE_STALL_MS) continue
      // opened during our reconnection: its silence is ours
      if (start < this.quietUntil) continue
      const key = this.keyOfConn(c)
      if (!key || !this.direct.has(key)) continue
      // a rule the user keeps direct whatever happens
      if (key.startsWith('r:') && this.zrules().find((z) => z.key === key)?.rule.zapretFallback === false)
        continue
      let m = this.stalls.get(key)
      if (!m) this.stalls.set(key, (m = new Map()))
      if (!m.has(c.id)) m.set(c.id, now)
    }
    for (const [key, m] of this.stalls) {
      for (const [id, at] of m) if (now - at > LIVE_WINDOW_MS) m.delete(id)
      if (m.size >= LIVE_STALLS && this.direct.has(key)) this.liveFallback(key, m.size)
    }
  }

  private liveFallback(key: string, count: number): void {
    const now = this.now()
    const repeated = now - (this.lastLive.get(key) ?? -Infinity) < LIVE_REPEAT_MS
    this.lastLive.set(key, now)
    this.liveHold.set(key, now + (repeated ? LIVE_REPEAT_MS : LIVE_RECHECK_MS))
    this.stalls.delete(key)
    this.direct.delete(key)
    this.items.set(key, {
      state: 'vpn',
      detail: 'соединения напрямую не получают ответа — временно через VPN'
    })
    this.d.log(
      'warn',
      `zapret: ${key}: ${count} соединения напрямую без ответа за минуту — через VPN, перепроверка через ${repeated ? 30 : 3} мин`
    )
    void this.route().then(() => this.publish())
    const gen = this.gen
    const t = setTimeout(
      () => {
        if (gen !== this.gen) return
        void this.serial(() => this.check(gen, true, false, 'после отката по трафику')).catch(
          () => undefined
        )
      },
      (repeated ? LIVE_REPEAT_MS : LIVE_RECHECK_MS) + 1000
    )
    t.unref?.()
    this.timers.push(t)
  }

  /** core log lines: the direct DoH failing → the zapret domains to the other one */
  onCoreLine(line: string): void {
    if (!this.active) return
    const m = DNS_FAIL_RE.exec(line)
    if (!m) return
    const failed: DohServer = m[1] === '8.8.8.8' ? 'primary' : 'fallback'
    if (failed !== this.dns) return
    const now = this.now()
    this.dnsFails = [...this.dnsFails.filter((t) => now - t < 60_000), now]
    if (this.dnsFails.length < DNS_FAILS) return
    this.dnsFails = []
    this.dns = failed === 'primary' ? 'fallback' : 'primary'
    this.dnsHoldUntil = now + DNS_HOLD_MS
    this.d.log(
      'warn',
      `zapret: DNS ${m[1]} не отвечает — домены переключены на ${this.dns === 'primary' ? '8.8.8.8' : '1.1.1.1'}`
    )
    void this.route()
  }

  // --- the pick ------------------------------------------------------------------

  /** the order of a pick: what worked here last (and recently opened the video) first */
  private pickOrder(): string[] {
    const memo = this.netId ? this.d.getMemory()[this.netId] : undefined
    const known = [
      ...(memo?.id ? [memo.id] : []),
      ...(memo?.good ?? []).filter((g) => this.now() - g.at < GOOD_TTL_MS).map((g) => g.id)
    ]
    const ids = [...known, ...STRATEGIES.map((s) => s.id)].filter((id) => strategyById(id))
    return [...new Set(ids)]
  }

  /**
   * A pick (0.7.2, ≤ ~3 min): pass 1 tries the strategies — first the one
   * that worked on this network last time and the ones that opened the video
   * here — each with the next video node (DPI may «punish» one address); it
   * stops at one that opens everything. Then the best CONFIRM_TOP are checked
   * once more (another node): a strategy counts with what opened BOTH times.
   * Ties: the one that opens the video node, then the one known here.
   */
  private async pick(gen: number, manual: boolean): Promise<void> {
    if (gen !== this.gen) return
    const settings = this.d.getSettings()
    if (itemKeys(settings).length === 0 && this.zrules().length === 0) {
      this.phase = 'running'
      this.publish()
      return
    }
    // what the pick looks at: the services, the first own domains, the first rules
    const items = [
      ...settings.services,
      ...settings.custom.slice(0, PICK_CUSTOM_MAX).map(customKey),
      ...this.zrules()
        .slice(0, PICK_CUSTOM_MAX)
        .map((z) => z.key)
    ]
    const sample = items.flatMap(routeKeysOf)
    const order = this.pickOrder()
    const memo = this.netId ? this.d.getMemory()[this.netId] : undefined
    const known = new Set([...(memo?.id ? [memo.id] : []), ...(memo?.good ?? []).map((g) => g.id)])
    const total = order.length + CONFIRM_TOP
    this.phase = 'picking'
    this.picking = { done: 0, total }
    this.error = undefined
    this.publish()
    this.d.log('info', `zapret: подбираем стратегию${manual ? ' (вручную)' : ''}…`)
    const signal = this.ac.signal
    const t0 = this.now()
    const c0 = this.d.connections?.() ?? 0
    let restarts = 0
    const budget = this.d.pickBudgetMs ?? PICK_BUDGET_MS
    const end = this.now() + budget
    const firstEnd = end - Math.min(CONFIRM_RESERVE_MS, budget / 4)
    const tried = new Map<string, Set<string>>()
    let best: { id: string; ok: Set<string> } | null = null
    let reason = ''
    const full = (ok: Set<string>): boolean => score(ok, items)[0] === items.length
    const rank = (a: { id: string; ok: Set<string> }, b: { id: string; ok: Set<string> } | null): boolean => {
      if (!b) return true
      const sa = score(a.ok, items)
      const sb = score(b.ok, items)
      if (better(sa, sb)) return true
      if (better(sb, sa)) return false
      return known.has(a.id) && !known.has(b.id)
    }
    const tryOne = async (id: string, doh: DohServer, until: number): Promise<Set<string> | null> => {
      restarts++
      if (!(await this.runStrategy(gen, id))) return null
      await sleep(this.d.settleMs ?? 1500, signal)
      if (gen !== this.gen) return null
      const res = await this.probe(
        sample,
        doh,
        Math.min(15_000, Math.max(1000, until - this.now())),
        PICK_TARGET_MS,
        1
      )
      if (gen !== this.gen) return null
      this.picking = { done: (this.picking?.done ?? 0) + 1, total }
      this.publish()
      return new Set(sample.filter((k) => res.get(k)?.ok))
    }
    try {
      const doh = await this.d.pickDoh(this.path(), signal).catch(() => null)
      if (gen !== this.gen) return
      if (!doh) {
        reason = 'DNS-серверы 8.8.8.8 и 1.1.1.1 не отвечают напрямую'
      } else {
        if (this.now() >= this.dnsHoldUntil) this.dns = doh
        // pass 1
        for (const id of order) {
          if (gen !== this.gen) return
          if (firstEnd - this.now() < 3000) break
          const ok = await tryOne(id, doh, firstEnd)
          if (gen !== this.gen) return
          if (!ok) {
            // another DPI bypass / the service: no strategy can be tried
            if (this.warning || this.error) break
            continue
          }
          tried.set(id, ok)
          if (full(ok)) break
        }
        // pass 2: the best ones once more; what opened both times counts
        const top = [...tried]
          .map(([id, ok]) => ({ id, ok }))
          .filter((x) => x.ok.size > 0)
          .sort((a, b) => (rank(a, b) ? -1 : rank(b, a) ? 1 : 0))
          .slice(0, CONFIRM_TOP)
        for (const c of top) {
          if (gen !== this.gen) return
          if (end - this.now() < 3000) {
            if (!best || rank(c, best)) best = c
            continue
          }
          const again = await tryOne(c.id, doh, end)
          if (gen !== this.gen) return
          if (!again) continue
          const both = { id: c.id, ok: new Set([...c.ok].filter((k) => again.has(k))) }
          this.d.log(
            'info',
            `zapret: перепроверка «${strategyById(c.id)?.name}» — ${score(both.ok, items)[0]} из ${items.length}`
          )
          if (rank(both, best)) best = both
          if (full(both.ok)) break
        }
      }
    } finally {
      if (gen === this.gen) this.picking = undefined
      const t1 = this.now()
      const conns = this.d.connections ? `, соединений: ${this.d.connections() - c0}` : ''
      this.d.log(
        'info',
        `zapret: подбор${gen === this.gen ? '' : ' прерван'} — ${clock(t0)}–${clock(t1)} (${Math.round((t1 - t0) / 1000)} с), перезапусков zapret: ${restarts}${conns}`
      )
    }
    if (gen !== this.gen) return
    const memory = { ...this.d.getMemory() }
    const usable = best ? score(best.ok, items)[0] : 0
    if (best && usable > 0) {
      this.strategyId = best.id
      await this.runStrategy(gen, best.id)
      this.d.log(
        'info',
        `zapret: выбрана стратегия «${strategyById(best.id)?.name}» — открывается ${usable} из ${items.length}`
      )
      if (this.netId) {
        const videoOk = best.ok.has(YT_VIDEO) || best.ok.has(YT_QUIC)
        const good = [
          ...(videoOk ? [{ id: best.id, at: this.now(), ok: [...best.ok] }] : []),
          ...(memory[this.netId]?.good ?? []).filter((g) => g.id !== best.id)
        ].slice(0, 3)
        memory[this.netId] = {
          id: best.id,
          at: this.now(),
          v: MEMO_VERSION,
          ok: [...best.ok],
          ...(good.length ? { good } : {})
        }
      }
    } else {
      this.strategyId = null
      await this.stopDpi()
      this.d.log(
        'warn',
        `zapret: ни одна стратегия не помогла${reason ? ` (${reason})` : ''} — всё через VPN`
      )
      // «nothing works here» only when strategies were really tried (not: no service / another bypass)
      if (this.netId && !this.warning && !this.error) {
        const good = memory[this.netId]?.good
        memory[this.netId] = {
          id: null,
          at: this.now(),
          v: MEMO_VERSION,
          ...(good?.length ? { good } : {})
        }
      }
    }
    if (this.netId) this.d.setMemory(trimMemory(memory))
    if (gen !== this.gen) return
    this.phase = 'running'
    // the real state of every item (own domains past the sample included)
    await this.check(gen, false, true, 'после подбора')
  }
}

/** keeps the newest MEMORY_MAX networks */
export function trimMemory(m: Record<string, StrategyMemo>): Record<string, StrategyMemo> {
  const entries = Object.entries(m).sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, MEMORY_MAX))
}
