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
}

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
  checkTarget: (t: CheckTarget, doh: DohServer, path: DirectPath) => Promise<TargetResult>
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
    if (!memo || stale || (memo.id && !strategyById(memo.id))) {
      await this.pick(gen, false)
      return
    }
    this.strategyId = memo.id
    if (memo.id) await this.runStrategy(gen, memo.id)
    else await this.stopDpi()
    if (gen !== this.gen) return
    this.phase = 'running'
    await this.check(gen, !firstCheck)
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
  private async probe(
    keys: string[],
    doh: DohServer,
    budgetMs: number
  ): Promise<Map<string, { ok: boolean; detail?: string }>> {
    const path = this.path()
    const out = new Map<string, { ok: boolean; detail?: string }>()
    const jobs = keys.flatMap((key) => this.targetsOf(key).map((t) => ({ key, t })))
    const results: (TargetResult | null)[] = new Array(jobs.length).fill(null)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < jobs.length) {
        const i = next++
        const { key, t } = jobs[i]
        let r = await this.d.checkTarget(t, doh, path)
        // an own domain without an address of its own: www.<domain>
        if (!r.ok && r.error === 'dns' && key.startsWith('d:') && !t.host.startsWith('www.')) {
          r = await this.d.checkTarget({ ...t, host: `www.${t.host}` }, doh, path)
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
      if (!r.ok && cur?.ok) out.set(key, { ok: false, detail: failureText(r) })
    })
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
      if (doh) this.dns = doh
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
      if (auto && lost.length && this.strategyId && this.canAutoPick()) {
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
      if (r?.ok) {
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
        this.dns = doh
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
            Math.min(15_000, Math.max(1000, end - this.now()))
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
      if (this.netId) memory[this.netId] = { id: best.id, at: this.now() }
    } else {
      this.strategyId = null
      await this.stopDpi()
      this.d.log(
        'warn',
        `zapret: ни одна стратегия не помогла${reason ? ` (${reason})` : ''} — всё через VPN`
      )
      // «nothing works here» only when strategies were really tried (not: no service / another bypass)
      if (this.netId && !this.warning && !this.error)
        memory[this.netId] = { id: null, at: this.now() }
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
