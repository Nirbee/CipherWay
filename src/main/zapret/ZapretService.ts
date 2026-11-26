import type { TunServiceInfo } from '@shared/types'
import {
  ZAPRET_SERVICES,
  addZapretDomain,
  type ZapretItem,
  type ZapretPhase,
  type ZapretServiceId,
  type ZapretSettings,
  type ZapretView
} from '@shared/zapret'
import { NO_ZAPRET, type ZapretRouting } from '../rules/compile'
import { customTargets, SERVICE_DEFS, type CheckTarget } from './lists'
import { STRATEGIES, strategyById } from './strategies'
import { customKey, itemKeys, zapretRouting } from './routing'
import type { DirectPath, DohServer, NetworkInfo, TargetResult } from './checks'
import { DpiStartError, type DpiDaemonLike, type DpiRequest } from './DpiDaemon'

// ---------------------------------------------------------------------------
// «Ускорение без VPN (zapret)» on the app side:
//   VPN connected + switched on → every item goes through the VPN first; the
//     strategy remembered for this network starts (first time here: a pick);
//     every item is checked directly → the ones that open go direct;
//   every ~10 min, and when the network changes → checked again; an item
//     that stops opening goes back through the VPN at once; if one that worked
//     stops, the strategy is picked again (at most every 30 min per network);
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
  pickDoh: (path: DirectPath) => Promise<DohServer | null>
  checkTarget: (
    t: CheckTarget,
    doh: DohServer,
    path: DirectPath,
    timeoutMs?: number
  ) => Promise<TargetResult>
  /**
   * YouTube's video nodes for this client (videoNodes.ts findVideoNodes).
   * Absent (tests) = no video check; [] = none found → YouTube not verified.
   */
  videoNodes?: (doh: DohServer, path: DirectPath) => Promise<string[]>
  /** our VPN servers' addresses (never touched by zapret) */
  excludeIps: () => Promise<string[]>
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
}

/** how often a broken strategy may be re-picked by itself, per network */
const AUTO_PICK_GAP_MS = 30 * 60_000
/** «nothing works here» is retried after this long */
const NOTHING_RETRY_MS = 6 * 60 * 60_000
/** own domains checked during a pick (all of them in the regular checks) */
const PICK_CUSTOM_MAX = 8
const MEMORY_MAX = 30
/** a target of a pick gets this long (failing strategies are many, the budget ~2 min) */
const PICK_TARGET_MS = 5000
/** the video nodes found are reused this long (per network) */
const NODES_TTL_MS = 30 * 60_000

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
  metadata?: { host?: string; network?: string }
}

interface ItemState {
  state: ZapretItem['state']
  detail?: string
}

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
      ...(this.warning ? { warning: this.warning } : {})
    }
  }

  private itemState(key: string): ItemState {
    if (!this.active) return { state: 'idle' }
    return this.items.get(key) ?? { state: 'checking' }
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
        void this.serial(() => this.check(gen, true)).catch(() => undefined)
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
    void firstCheck
    await this.check(gen, true)
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
    const keys = new Set(itemKeys(this.d.getSettings()))
    for (const k of [...this.direct]) if (!keys.has(k)) this.direct.delete(k)
    await this.route()
    this.publish()
    await this.serial(async () => {
      if (gen !== this.gen) return
      if (this.strategyId && this.dpiUp) await this.runStrategy(gen, this.strategyId)
      else if (this.strategyId === null && this.netId && !this.d.getMemory()[this.netId]) {
        await this.pick(gen, false)
        return
      }
      await this.check(gen, false)
    })
  }

  // --- winws through the broker ----------------------------------------------

  private async request(strategy: string): Promise<DpiRequest> {
    const s = this.d.getSettings()
    return {
      strategy,
      services: [...s.services],
      hosts: [...s.custom],
      exclude: (await this.d.excludeIps().catch(() => [] as string[])).slice(0, 512)
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

  private targetsOf(key: string): CheckTarget[] {
    if (key.startsWith('d:')) return customTargets(key.slice(2))
    return [...(SERVICE_DEFS[key as ZapretServiceId]?.targets ?? [])]
  }

  /** key → ok / the first failure, every target of every key (bounded in time) */
  /** the video nodes of this network (cached NODES_TTL_MS); null = no video check */
  private async videoTargets(doh: DohServer): Promise<CheckTarget[] | null> {
    if (!this.d.videoNodes) return null
    const fresh =
      this.nodes && this.nodes.net === this.netId && this.now() - this.nodes.at < NODES_TTL_MS
    if (!fresh || !this.nodes?.list.length) {
      const list = await this.d.videoNodes(doh, this.path()).catch(() => [] as string[])
      this.nodes = { net: this.netId, at: this.now(), list }
      if (list.length)
        this.d.log('info', `zapret: видеосерверы YouTube для проверки — ${list.join(', ')}`)
    }
    return (this.nodes?.list ?? []).map((host) => ({
      host,
      http: true,
      path: '/generate_204',
      video: true
    }))
  }

  private async probe(
    keys: string[],
    doh: DohServer,
    budgetMs: number,
    targetMs?: number
  ): Promise<Map<string, { ok: boolean; detail?: string }>> {
    const path = this.path()
    const out = new Map<string, { ok: boolean; detail?: string }>()
    const jobs = keys.flatMap((key) => this.targetsOf(key).map((t) => ({ key, t })))
    // YouTube = its pages AND a real video node (the video may be throttled alone)
    let noVideo = false
    if (keys.includes('youtube')) {
      const video = await this.videoTargets(doh)
      if (video && video.length === 0) noVideo = true
      for (const t of video ?? []) jobs.push({ key: 'youtube', t })
    }
    const results: (TargetResult | null)[] = new Array(jobs.length).fill(null)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < jobs.length) {
        const i = next++
        const { key, t } = jobs[i]
        let r = await this.d.checkTarget(t, doh, path, targetMs)
        // an own domain without an address of its own: www.<domain>
        if (!r.ok && r.error === 'dns' && key.startsWith('d:') && !t.host.startsWith('www.')) {
          r = await this.d.checkTarget({ ...t, host: `www.${t.host}` }, doh, path, targetMs)
        }
        results[i] = r
      }
    }
    await deadline(
      Promise.all(Array.from({ length: Math.min(12, jobs.length) }, worker)),
      budgetMs,
      undefined
    )
    for (const key of keys) out.set(key, { ok: true })
    jobs.forEach(({ key, t }, i) => {
      const r = results[i] ?? { host: t.host, ok: false, error: 'timeout' }
      const cur = out.get(key)
      if (!r.ok && cur?.ok) {
        out.set(key, {
          ok: false,
          detail: t.video ? `видео не открывается напрямую — ${failureText(r)}` : failureText(r)
        })
      }
    })
    if (noVideo && out.get('youtube')?.ok) {
      out.set('youtube', {
        ok: false,
        detail: 'не найден видеосервер YouTube — видео не проверить'
      })
    }
    return out
  }

  /** The direct check of every item → the sets; `auto`: a broken strategy is re-picked. */
  private async check(gen: number, auto: boolean): Promise<void> {
    if (gen !== this.gen) return
    const keys = itemKeys(this.d.getSettings())
    this.checking = true
    this.publish()
    try {
      const doh = await this.d.pickDoh(this.path()).catch(() => null)
      if (gen !== this.gen) return
      const before = new Set(this.direct)
      // after the core reported the DoH failing, keep the other one for a while
      if (doh && this.now() >= this.dnsHoldUntil) this.dns = doh
      const res = doh
        ? await this.probe(keys, doh, this.d.checkBudgetMs ?? 60_000)
        : new Map(
            keys.map((k) => [
              k,
              { ok: false, detail: 'DNS-серверы 8.8.8.8 и 1.1.1.1 не отвечают напрямую' }
            ])
          )
      if (gen !== this.gen) return
      this.setResults(keys, res)
      this.checkedAt = this.now()
      if (this.phase === 'starting') this.phase = 'running'
      await this.route()
      const lost = [...before].filter((k) => keys.includes(k) && !this.direct.has(k))
      if (lost.length)
        this.d.log('warn', `zapret: напрямую перестало открываться — ${lost.join(', ')}; через VPN`)
      // the strategy broke: an item it opened when it was picked (or was open a moment ago) fails
      const memo = this.netId ? this.d.getMemory()[this.netId] : undefined
      const broken = keys.some(
        (k) => !this.direct.has(k) && (before.has(k) || (memo?.ok ?? []).includes(k))
      )
      if (auto && broken && this.strategyId && this.canAutoPick()) {
        this.checking = false
        this.d.log('info', 'zapret: стратегия перестала работать — подбираем заново')
        await this.pick(gen, false)
      }
    } finally {
      if (gen === this.gen) {
        this.checking = false
        this.publish()
      }
    }
  }

  private setResults(keys: string[], res: Map<string, { ok: boolean; detail?: string }>): void {
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
        this.items.set(key, { state: 'direct' })
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
    const r = zapretRouting(this.d.getSettings(), this.direct, this.dns)
    const text = JSON.stringify(r)
    if (text === this.lastRouting) return
    this.lastRouting = text
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

  /** which switched-on item a host belongs to (null = none) */
  private keyOfHost(host: string): string | null {
    const h = host.toLowerCase()
    const under = (d: string): boolean => h === d || h.endsWith(`.${d}`)
    const s = this.d.getSettings()
    for (const id of s.services) {
      if ((SERVICE_DEFS[id]?.domains ?? []).some(under)) return id
    }
    for (const d of s.custom) if (under(d)) return customKey(d)
    return null
  }

  /**
   * Every /connections snapshot of the core (once a second): a direct
   * connection of a zapret item that got nothing back for LIVE_STALL_MS is
   * counted; LIVE_STALLS of them within LIVE_WINDOW_MS → that item goes back
   * through the VPN at once and is re-checked after LIVE_RECHECK_MS.
   */
  onConnections(raw: { connections?: LiveConnection[] | null }): void {
    if (!this.active || this.direct.size === 0) return
    const now = this.now()
    for (const c of raw.connections ?? []) {
      if (!/cw-z-d\b/.test(c.rule ?? '')) continue
      if ((c.metadata?.network ?? 'tcp') !== 'tcp' || (c.download ?? 0) > 0) continue
      const start = c.start ? Date.parse(c.start) : NaN
      if (!Number.isFinite(start) || now - start < LIVE_STALL_MS) continue
      const key = this.keyOfHost(c.metadata?.host ?? '')
      if (!key || !this.direct.has(key)) continue
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
        void this.serial(() => this.check(gen, true)).catch(() => undefined)
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

  /**
   * Tries the strategies in order (≤ pickBudgetMs): the first that opens every
   * item wins, else the one that opens the most; none → winws off, all via VPN.
   */
  private async pick(gen: number, manual: boolean): Promise<void> {
    if (gen !== this.gen) return
    const settings = this.d.getSettings()
    const keys = itemKeys(settings)
    if (keys.length === 0) {
      this.phase = 'running'
      this.publish()
      return
    }
    const sample = [
      ...settings.services,
      ...settings.custom.slice(0, PICK_CUSTOM_MAX).map(customKey)
    ]
    this.phase = 'picking'
    this.picking = { done: 0, total: STRATEGIES.length }
    this.error = undefined
    this.publish()
    this.d.log('info', `zapret: подбираем стратегию${manual ? ' (вручную)' : ''}…`)
    const end = this.now() + (this.d.pickBudgetMs ?? 120_000)
    let best: { id: string; ok: Set<string> } | null = null
    let reason = ''
    try {
      const doh = await this.d.pickDoh(this.path()).catch(() => null)
      if (gen !== this.gen) return
      if (!doh) {
        reason = 'DNS-серверы 8.8.8.8 и 1.1.1.1 не отвечают напрямую'
      } else {
        if (this.now() >= this.dnsHoldUntil) this.dns = doh
        for (const s of STRATEGIES) {
          if (gen !== this.gen) return
          const left = end - this.now()
          if (left < 3000) break
          if (!(await this.runStrategy(gen, s.id))) {
            // another DPI bypass / the service: no strategy can be tried
            if (this.warning || this.error) break
            continue
          }
          await sleep(this.d.settleMs ?? 1500)
          const res = await this.probe(
            sample,
            doh,
            Math.min(15_000, Math.max(1000, end - this.now())),
            PICK_TARGET_MS
          )
          if (gen !== this.gen) return
          const ok = new Set(sample.filter((k) => res.get(k)?.ok))
          this.picking = { done: (this.picking?.done ?? 0) + 1, total: STRATEGIES.length }
          this.publish()
          if (!best || ok.size > best.ok.size) best = { id: s.id, ok }
          if (ok.size === sample.length) break
        }
      }
    } finally {
      if (gen === this.gen) this.picking = undefined
    }
    if (gen !== this.gen) return
    const memory = { ...this.d.getMemory() }
    if (best && best.ok.size > 0) {
      this.strategyId = best.id
      await this.runStrategy(gen, best.id)
      this.d.log(
        'info',
        `zapret: выбрана стратегия «${strategyById(best.id)?.name}» — открывается ${best.ok.size} из ${sample.length}`
      )
      if (this.netId) {
        memory[this.netId] = { id: best.id, at: this.now(), v: MEMO_VERSION, ok: [...best.ok] }
      }
    } else {
      this.strategyId = null
      await this.stopDpi()
      this.d.log(
        'warn',
        `zapret: ни одна стратегия не помогла${reason ? ` (${reason})` : ''} — всё через VPN`
      )
      // «nothing works here» only when strategies were really tried (not: no service / another bypass)
      if (this.netId && !this.warning && !this.error)
        memory[this.netId] = { id: null, at: this.now(), v: MEMO_VERSION }
    }
    if (this.netId) this.d.setMemory(trimMemory(memory))
    if (gen !== this.gen) return
    this.phase = 'running'
    // the real state of every item (own domains past the sample included)
    await this.check(gen, false)
  }
}

/** keeps the newest MEMORY_MAX networks */
export function trimMemory(m: Record<string, StrategyMemo>): Record<string, StrategyMemo> {
  const entries = Object.entries(m).sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, MEMORY_MAX))
}
