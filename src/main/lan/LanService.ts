import type {
  LanDevice,
  LanErrorKind,
  LanPeerLink,
  LanRoom,
  LanView,
  TunServiceInfo
} from '@shared/types'
import { LanApiError, type LanApi } from './api'
import {
  foreignIps,
  isAccessError,
  type DaemonStatus,
  type PingResult,
  type UpParams
} from './lanCtl'
import type { LanBrokerState } from './lanBroker'
import { LanStartError } from './LanDaemon'

// ---------------------------------------------------------------------------
// «LAN» — the whole feature on the app side:
//   switch on  → bot GET /lan/status → the service is there (one UAC prompt to
//                set it up if not, only when the user flips the switch) → the
//                daemon starts through the service task → not logged in yet:
//                bot POST /lan/device → `lanctl up --auth-key=file:…` → Running
//   switch off → the daemon stops (it stays registered, shows «не в сети»)
//   app quit   → the daemon stops, the switch is remembered: next start turns
//                LAN on again by itself (never with a UAC prompt)
// Rooms live in the bot and work with LAN off too. Every dependency is
// injected — unit tested with mocks in LanService.test.ts.
//
// TODO(lan-phase-2): Minecraft LAN discovery. Java Edition announces an open
// world by UDP multicast to 224.0.2.60:4445 («[MOTD]name[/MOTD][AD]port[/AD]»),
// which never crosses the LAN daemon's adapter. Design: a relay in main joins
// 224.0.2.60:4445 on the physical interfaces, forwards each announcement as
// unicast UDP to the online room peers' LAN IPs on a fixed port (say 41643,
// direct in configGen like 41642); the receiving app checks the sender is a room
// peer and re-announces it on loopback. The game connects to the SOURCE address
// of the announcement (127.0.0.1 then), so the receiver also opens a local TCP
// forwarder 127.0.0.1:<port> → <peer LAN IP>:<port> while the world is announced
// (or rewrites [AD] to a free local port it forwards).
// ---------------------------------------------------------------------------

export interface LanDaemonLike {
  start(): Promise<void>
  stop(): Promise<void>
  running(): Promise<LanBrokerState | null>
  isMine(st: LanBrokerState | null): boolean
  readLog(): Promise<string[]>
}

export interface LanCtlLike {
  status(): Promise<DaemonStatus>
  up(p: UpParams): Promise<void>
  ping(ip: string): Promise<PingResult | null>
  noAutoUpdate(): Promise<void>
}

type LanApiLike = Pick<
  LanApi,
  | 'status'
  | 'registerDevice'
  | 'devices'
  | 'deleteDevice'
  | 'rooms'
  | 'createRoom'
  | 'joinRoom'
  | 'leaveRoom'
  | 'kick'
  | 'regenerateCode'
>

export interface LanServiceDeps {
  api: LanApiLike
  /** this build ships cipherway-lan.exe / cipherway-lanctl.exe */
  available: boolean
  daemon: () => Promise<LanDaemonLike>
  ctl: () => Promise<LanCtlLike>
  service: {
    status(): Promise<TunServiceInfo>
    install(): Promise<'ok' | 'cancelled' | 'failed'>
  }
  /** the host name the bot gave this computer last (null before the first login) */
  getHostname: () => string | null
  setHostname: (name: string) => void
  /** where the auth key is put for `up --auth-key=file:` (removed right after) */
  keyFile: string
  writeKey: (path: string, key: string) => Promise<void>
  removeKey: (path: string) => Promise<void>
  getEnabled: () => boolean
  setEnabled: (on: boolean) => void
  /** the Headscale URL from the bot (configGen keeps it direct) */
  setLoginServer: (url: string) => void
  getLoginServer: () => string
  hasSubscription: () => boolean
  publish: (v: LanView) => void
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** new lines of the daemon's own log */
  daemonLog: (lines: string[]) => void
  /** the switch changed: the running VPN gets / loses the LAN bypass rules */
  onBypassChange?: () => Promise<void>
  /** ms; tests make them short */
  pollActiveMs?: number
  pollIdleMs?: number
  waitMs?: number
}

const ERROR_TEXT: Record<LanErrorKind, string> = {
  nosub: 'Сначала добавьте подписку на странице «Подписка».',
  inactive:
    'Подписка не активна — LAN работает только с действующей подпиской. Продлите её и включите LAN снова.',
  disabled: 'LAN сейчас выключен на сервере CipherWay. Попробуйте позже.',
  device_limit:
    'Достигнут лимит устройств LAN. Удалите старое устройство из списка ниже — и это подключится.',
  tailscale_running:
    'На компьютере работает Tailscale. LAN CipherWay построен на нём же и не может работать одновременно: остановите службу Tailscale (Пуск → «Службы» → Tailscale → «Остановить») и включите LAN снова.',
  lan_busy:
    'LAN CipherWay уже включён другим пользователем этого компьютера. Выключите его там и попробуйте снова.',
  in_use:
    'LAN на этом компьютере подключён под другим пользователем Windows или доступ к нему запрещён. Включите его под тем пользователем или удалите и заново установите службу в «Настройках».',
  unsafe_address:
    'Сервер LAN выдал адреса вне сети LAN — для безопасности LAN выключен. Напишите в поддержку.',
  service:
    'Служба CipherWay не установлена или устарела. Нажмите «Включить» — Windows один раз спросит разрешение.',
  uac: 'Без разрешения Windows LAN не запустить: служба CipherWay ставится один раз и потом не спрашивает прав.',
  missing: 'Компонент LAN не найден — переустановите приложение.',
  daemon: 'LAN не запустился. Подробности — на странице «Логи».',
  login: 'Не удалось подключить это устройство к LAN. Подробности — на странице «Логи».',
  auth: 'Не удалось войти — обновите подписку на странице «Подписка».',
  rate: 'Слишком много попыток — подождите минуту.',
  network: 'Нет связи с сервером CipherWay. Проверьте интернет.',
  server: 'Сервер CipherWay ответил ошибкой. Попробуйте позже.'
}

export function lanErrorText(kind: LanErrorKind): string {
  return ERROR_TEXT[kind]
}

const RESTARTS_MAX = 3
const RESTART_WINDOW_MS = 10 * 60_000
const ROOMS_EVERY_MS = 10_000
const PINGS_EVERY_MS = 10_000
// a node that falls back to NeedsLogin (the subscription link was reset, the
// node expired) is re-registered silently, at most once a minute: the bot gives
// at most 20 keys an hour per subscription and every new key voids the previous
// unused one. A failed attempt shows its error and stops (no key-burning loop).
const RELOGIN_EVERY_MS = 60_000

class Cancelled extends Error {}

export class LanService {
  private v: LanView
  private gen = 0
  private active = false
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private restarts: number[] = []
  private lastRooms = 0
  private lastPings = 0
  private lastLogin = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private d: LanServiceDeps) {
    this.v = {
      available: d.available,
      hasSubscription: d.hasSubscription(),
      enabled: d.getEnabled(),
      phase: 'off',
      message: null,
      error: null,
      selfIp: null,
      selfName: null,
      rooms: [],
      roomsError: null,
      links: {},
      devices: null,
      limits: null
    }
  }

  view(): LanView {
    return { ...this.v, hasSubscription: this.d.hasSubscription(), enabled: this.d.getEnabled() }
  }

  private set(patch: Partial<LanView>): void {
    this.v = { ...this.v, ...patch }
    this.d.publish(this.view())
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private fail(kind: LanErrorKind, text = ERROR_TEXT[kind]): void {
    this.set({ phase: 'error', message: null, error: { kind, text } })
  }

  private check(gen: number): void {
    if (gen !== this.gen) throw new Cancelled()
  }

  // --- lifecycle ---------------------------------------------------------------

  /** App start: the switch was on last time → on again (never a UAC prompt). */
  init(delayMs = 1500): void {
    if (!this.d.getEnabled()) return
    // after the window and the subscription refresh got their share of the start
    const gen = this.gen
    setTimeout(() => {
      if (gen === this.gen && this.d.getEnabled()) void this.enable(false)
    }, delayMs)
  }

  /** The switch. `on` from the user may set up the service (one UAC prompt). */
  setEnabled(on: boolean): Promise<LanView> {
    return on ? this.enable(true) : this.disable()
  }

  private enable(byUser: boolean): Promise<LanView> {
    const gen = ++this.gen
    if (byUser) this.d.setEnabled(true)
    return this.serial(async () => {
      try {
        await this.doEnable(gen, byUser)
      } catch (err) {
        if (!(err instanceof Cancelled)) {
          this.d.log('error', `LAN: ${err instanceof Error ? err.message : String(err)}`)
          if (this.v.phase === 'starting') this.fail('daemon')
        }
      }
      return this.view()
    })
  }

  private async doEnable(gen: number, byUser: boolean): Promise<void> {
    this.stopTimer()
    if (!this.d.available) return this.fail('missing')
    if (!this.d.hasSubscription()) return this.fail('nosub')
    this.set({ phase: 'starting', error: null, message: 'Проверяем подписку…' })

    let srv
    try {
      srv = await this.d.api.status()
    } catch (err) {
      return this.apiFail(err)
    }
    this.check(gen)
    this.set({
      limits: {
        maxRoomMembers: srv.maxRoomMembers,
        maxRoomsOwned: srv.maxRoomsOwned,
        maxRoomsJoined: srv.maxRoomsJoined,
        maxDevices: srv.maxDevices
      }
    })
    if (!srv.enabled) return this.fail('disabled')
    if (srv.loginServer) this.d.setLoginServer(srv.loginServer)

    const st = await this.d.service.status()
    this.check(gen)
    // an installed LAN task keeps working after an app update («outdated»): the
    // service is brought up to date by the next TUN connect, no prompt for LAN.
    // No LAN task at all: one UAC prompt — only when the user flips the switch.
    if (!st.lan) {
      if (!byUser) return this.fail('service')
      this.set({
        message:
          st.state === 'missing'
            ? 'Устанавливаем службу CipherWay — подтвердите запрос Windows (один раз)…'
            : 'Обновляем службу CipherWay — подтвердите запрос Windows (один раз)…'
      })
      const res = await this.d.service.install().catch(() => 'failed' as const)
      this.check(gen)
      if (res === 'cancelled') return this.fail('uac')
      const after = res === 'ok' ? await this.d.service.status() : st
      if (res !== 'ok' || !after.lan) return this.fail('service')
    }

    this.set({ message: 'Запускаем LAN…' })
    // the running VPN lets the daemon through before it dials anything
    await this.d.onBypassChange?.().catch(() => undefined)
    this.check(gen)
    const daemon = await this.d.daemon()
    try {
      await daemon.start()
    } catch (err) {
      this.check(gen)
      if (err instanceof LanStartError) {
        if (err.code === 'tailscale_running') {
          this.d.log('warn', `LAN не запущен: работает Tailscale (${err.detail ?? ''})`)
          return this.fail('tailscale_running')
        }
        if (err.code === 'lan_busy') return this.fail('lan_busy')
      }
      this.d.log('error', `LAN не запустился: ${err instanceof Error ? err.message : String(err)}`)
      return this.fail('daemon')
    }
    this.check(gen)
    this.d.log('info', 'LAN запущен')

    let status: DaemonStatus | null
    try {
      status = await this.waitCtl(gen)
    } catch (err) {
      if (err instanceof Cancelled) throw err
      this.d.log('error', `LAN: ${err instanceof Error ? err.message : String(err)}`)
      await daemon.stop().catch(() => undefined)
      return this.fail('in_use')
    }
    if (!status) {
      this.d.log('error', 'LAN: демон не отвечает на запросы')
      await daemon.stop().catch(() => undefined)
      return this.fail('daemon')
    }
    if (status.backendState !== 'Running') {
      const ok = await this.login(gen, status)
      if (!ok) {
        await daemon.stop().catch(() => undefined)
        return
      }
    }
    this.check(gen)
    const ctlNow = await this.d.ctl()
    const now = await ctlNow.status().catch(() => status)
    if (await this.unsafe(now)) return
    await ctlNow
      .noAutoUpdate()
      .catch((e: unknown) =>
        this.d.log(
          'warn',
          `LAN: не удалось выключить самообновление: ${e instanceof Error ? e.message : e}`
        )
      )
    this.set({
      phase: 'on',
      message: null,
      error: null,
      selfIp: now.selfIp,
      selfName: now.selfName,
      devices: null
    })
    this.d.log('info', `LAN включён: ${now.selfIp ?? 'адрес ещё не выдан'}`)
    this.lastRooms = 0
    this.lastPings = 0
    this.schedule(0)
  }

  /**
   * The server may only hand out LAN addresses (100.64.0.0/10, fd7a:115c:a1e0::/48):
   * anything else would put real internet ranges on the LAN adapter. Stops LAN.
   */
  private async unsafe(s: DaemonStatus): Promise<boolean> {
    const bad = foreignIps(s)
    if (bad.length === 0) return false
    this.d.log('error', `LAN: адреса вне сети LAN (${bad.slice(0, 5).join(', ')}) — LAN остановлен`)
    const daemon = await this.d.daemon()
    await daemon.stop().catch(() => undefined)
    this.stopTimer()
    this.fail('unsafe_address')
    return true
  }

  /** `status` answers once the daemon's pipe is up. */
  private async waitCtl(gen: number): Promise<DaemonStatus | null> {
    const ctl = await this.d.ctl()
    const end = Date.now() + (this.d.waitMs ?? 20_000)
    while (Date.now() < end) {
      this.check(gen)
      try {
        const s = await ctl.status()
        if (s.backendState !== 'NoState' && s.backendState !== 'Starting') return s
      } catch (err) {
        // the pipe answers, but not to this Windows user
        if (isAccessError(err instanceof Error ? err.message : String(err))) throw err
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    try {
      return await ctl.status()
    } catch {
      return null
    }
  }

  /** Registers this computer (a fresh single-use key from the bot) and brings it up. */
  private async login(gen: number, status: DaemonStatus): Promise<boolean> {
    const ctl = await this.d.ctl()
    const known = this.d.getHostname()
    this.lastLogin = Date.now()
    try {
      if (status.backendState === 'Stopped' && status.selfIp && known) {
        // registered before, only switched off: no new key, no new device slot
        // (--hostname again: `up --reset` would put the PC name there otherwise)
        await ctl.up({ loginServer: this.d.getLoginServer(), hostname: known })
      } else {
        this.set({ message: 'Подключаем это устройство…' })
        let key
        try {
          key = await this.d.api.registerDevice(known)
        } catch (err) {
          this.check(gen)
          if (err instanceof LanApiError && err.kind === 'device_limit') {
            this.fail('device_limit')
            await this.loadDevices().catch(() => undefined)
            return false
          }
          this.apiFail(err)
          return false
        }
        this.check(gen)
        this.d.setLoginServer(key.loginServer)
        this.d.setHostname(key.hostname)
        await this.d.writeKey(this.d.keyFile, key.authKey)
        try {
          await ctl.up({
            loginServer: key.loginServer,
            authKeyFile: this.d.keyFile,
            hostname: key.hostname
          })
        } finally {
          await this.d.removeKey(this.d.keyFile).catch(() => undefined)
        }
      }
    } catch (err) {
      if (err instanceof Cancelled) throw err
      const msg = err instanceof Error ? err.message : String(err)
      this.d.log('error', `LAN: вход не удался: ${msg}`)
      this.fail(isAccessError(msg) ? 'in_use' : 'login')
      return false
    }
    this.check(gen)
    return true
  }

  private apiFail(err: unknown): void {
    if (err instanceof LanApiError) {
      const kinds: Partial<Record<string, LanErrorKind>> = {
        nosub: 'nosub',
        inactive: 'inactive',
        disabled: 'disabled',
        device_limit: 'device_limit',
        auth: 'auth',
        rate: 'rate',
        network: 'network'
      }
      const kind = kinds[err.kind]
      this.d.log('warn', `LAN: сервер: ${err.message}`)
      // the rest (503 lan_unavailable, …) carries its own Russian text
      return kind ? this.fail(kind) : this.fail('server', err.message)
    }
    this.d.log('error', `LAN: ${err instanceof Error ? err.message : String(err)}`)
    this.fail('server')
  }

  private disable(): Promise<LanView> {
    this.gen++
    this.d.setEnabled(false)
    this.stopTimer()
    return this.serial(async () => {
      const daemon = await this.d.daemon().catch(() => null)
      await daemon?.stop().catch(() => undefined)
      this.set({ phase: 'off', message: null, error: null, selfIp: null, links: {} })
      this.d.log('info', 'LAN выключен')
      await this.d.onBypassChange?.().catch(() => undefined)
      return this.view()
    })
  }

  /** App quit / the service is being removed: stop the daemon, keep the switch. */
  shutdown(): Promise<void> {
    this.gen++
    this.stopTimer()
    return this.serial(async () => {
      const daemon = await this.d.daemon().catch(() => null)
      await daemon?.stop().catch(() => undefined)
      if (this.v.phase !== 'off') this.set({ phase: 'off', message: null, links: {} })
    })
  }

  /** «LAN» is on screen: poll often, ping the peers. */
  setActive(active: boolean): void {
    this.active = active
    if (active) {
      this.lastRooms = 0
      void this.refreshRooms()
    }
    if (this.timer) this.schedule(0)
  }

  // --- polling -----------------------------------------------------------------

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    this.stopTimer()
    this.timer = setTimeout(() => void this.tick(), ms)
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    const gen = this.gen
    try {
      await this.poll(gen)
    } catch (err) {
      if (!(err instanceof Cancelled)) {
        this.d.log('warn', `LAN: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      this.ticking = false
      if (gen === this.gen && this.v.phase === 'on') {
        this.schedule(this.active ? (this.d.pollActiveMs ?? 3000) : (this.d.pollIdleMs ?? 15_000))
      }
    }
  }

  private async poll(gen: number): Promise<void> {
    const daemon = await this.d.daemon()
    const lines = await daemon.readLog().catch(() => [])
    if (lines.length) this.d.daemonLog(lines)
    const st = await daemon.running()
    this.check(gen)
    if (!daemon.isMine(st) || st?.status !== 'running') return this.daemonGone(st)

    const ctl = await this.d.ctl()
    const s = await ctl.status().catch(() => null)
    this.check(gen)
    if (!s) return
    if (await this.unsafe(s)) return
    if (s.backendState === 'NeedsLogin' && Date.now() - this.lastLogin > RELOGIN_EVERY_MS) {
      // the node was removed / expired on the server: register again, quietly
      this.d.log('warn', 'LAN: устройство вышло из сети CipherWay — подключаем заново')
      if (!(await this.login(gen, s))) return
      this.set({ phase: 'on', error: null, message: null })
    }
    const links: Record<string, LanPeerLink> = {}
    for (const p of s.peers) {
      const prev = this.v.links[p.ip]
      links[p.ip] = {
        ip: p.ip,
        online: p.online,
        path: p.direct ? 'direct' : p.relay ? 'relay' : 'unknown',
        latencyMs: p.online ? (prev?.latencyMs ?? null) : null
      }
    }
    this.set({ selfIp: s.selfIp, selfName: s.selfName, links })

    if (!this.active) return
    if (Date.now() - this.lastRooms >= ROOMS_EVERY_MS) await this.refreshRooms()
    if (Date.now() - this.lastPings >= PINGS_EVERY_MS) await this.pingPeers(gen, ctl)
  }

  /** Room peers that are online: one ping each (path + latency). */
  private async pingPeers(gen: number, ctl: LanCtlLike): Promise<void> {
    this.lastPings = Date.now()
    const ips = new Set<string>()
    for (const r of this.v.rooms) {
      for (const m of r.members) {
        if (m.isSelf) continue
        for (const dev of m.devices) if (dev.ip && this.v.links[dev.ip]?.online) ips.add(dev.ip)
      }
    }
    for (const ip of [...ips].slice(0, 16)) {
      const res = await ctl.ping(ip)
      this.check(gen)
      const cur = this.v.links[ip]
      if (!cur) continue
      this.v.links = {
        ...this.v.links,
        [ip]: {
          ...cur,
          latencyMs: res?.latencyMs ?? null,
          path: res ? res.path : cur.path
        }
      }
    }
    this.set({})
  }

  private daemonGone(st: LanBrokerState | null): void {
    this.stopTimer()
    if (st?.error === 'tailscale_running') {
      this.d.log('warn', `LAN остановлен: запущен Tailscale (${st.detail ?? ''})`)
      return this.fail('tailscale_running')
    }
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS)
    const why = st?.stopReason || st?.detail || st?.status || 'нет ответа'
    if (this.restarts.length >= RESTARTS_MAX) {
      this.d.log('error', `LAN остановился (${why}) — больше не перезапускаем`)
      return this.fail('daemon')
    }
    this.restarts.push(now)
    this.d.log('warn', `LAN остановился (${why}) — перезапускаем`)
    void this.enable(false)
  }

  // --- rooms / devices (bot) ---------------------------------------------------

  async refreshRooms(): Promise<LanView> {
    this.lastRooms = Date.now()
    if (!this.d.hasSubscription()) {
      this.set({ rooms: [], roomsError: ERROR_TEXT.nosub })
      return this.view()
    }
    try {
      const rooms = await this.d.api.rooms()
      this.set({ rooms, roomsError: null })
    } catch (err) {
      this.set({ roomsError: err instanceof Error ? err.message : String(err) })
    }
    return this.view()
  }

  private async afterRoomChange(room?: LanRoom | null): Promise<LanView> {
    if (room) {
      const rest = this.v.rooms.filter((r) => r.id !== room.id)
      this.set({ rooms: [...rest, room] })
    }
    return this.refreshRooms()
  }

  async createRoom(name: string): Promise<LanView> {
    return this.afterRoomChange(await this.d.api.createRoom(name))
  }

  async joinRoom(code: string): Promise<LanView> {
    return this.afterRoomChange(await this.d.api.joinRoom(code))
  }

  async leaveRoom(id: string): Promise<LanView> {
    await this.d.api.leaveRoom(id)
    this.set({ rooms: this.v.rooms.filter((r) => r.id !== id) })
    return this.refreshRooms()
  }

  async kick(id: string, memberId: string): Promise<LanView> {
    return this.afterRoomChange(await this.d.api.kick(id, memberId))
  }

  async regenerateCode(id: string): Promise<LanView> {
    return this.afterRoomChange(await this.d.api.regenerateCode(id))
  }

  async loadDevices(): Promise<LanView> {
    const list: LanDevice[] = await this.d.api.devices()
    const self = this.v.selfIp
    this.set({ devices: list.map((x) => ({ ...x, isThis: !!self && x.ip === self })) })
    return this.view()
  }

  /** Frees a device slot; LAN stuck on «лимит устройств» tries again. */
  async deleteDevice(nodeId: string): Promise<LanView> {
    await this.d.api.deleteDevice(nodeId)
    await this.loadDevices().catch(() => undefined)
    if (this.v.error?.kind === 'device_limit' && this.d.getEnabled()) return this.enable(true)
    return this.view()
  }
}
