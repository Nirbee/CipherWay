import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, rm, writeFile, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import {
  AUTO_OUTBOUND_ID,
  type AppSettings,
  type AutoInfo,
  type ConnectionState,
  type LogEntry,
  type OutboundConfig,
  type RoutingMode,
  type RulesConfig,
  type ServerPing,
  type TrafficStats
} from '@shared/types'
import { generateProbeConfig, generateSingboxConfig, TUN_ADDRESS4 } from './configGen'
import { generateXrayConfig, isXrayHandled, XRAY_EXE, type XrayBridge } from './xrayGen'
import { ClashApi } from './clashApi'
import { CLASH_MODE, TAG_AUTO, TAG_PROXY_GROUP } from './sbTypes'
import { brokerScript, hasTunAdapter, psQuote } from './broker'
import { findFreePort } from '../system/ports'
import { disableSystemProxy, enableSystemProxy } from '../system/proxy'
import { allIps, resolveServers, toExcludeCidrs, type ServerIps } from '../system/resolve'

type LogFn = (entry: LogEntry) => void
type StateFn = (state: ConnectionState, message?: string) => void
type TrafficFn = (stats: TrafficStats) => void
type AutoFn = (info: AutoInfo) => void
type PingsFn = (pings: ServerPing[]) => void
type IpsFn = (ips: string[]) => void

export interface StartParams {
  outbounds: OutboundConfig[]
  activeOutboundId: string | undefined
  rules: RulesConfig
  settings: AppSettings
  /** last known latency per node id (persisted) — orders the urltest group */
  latencies?: Record<string, number | null>
}

const MAX_RESTARTS = 5
const XRAY_READY_TIMEOUT_MS = 8000
/** system proxy: sing-box is up in well under a second; remote rule-sets may take a few */
const CORE_READY_TIMEOUT_MS = 25_000
/** TUN: includes the time the user needs to answer the UAC prompt */
const CORE_READY_TIMEOUT_TUN_MS = 90_000
/** TUN: creating the wintun adapter the very first time can take half a minute */
const TUN_ADAPTER_TIMEOUT_MS = 45_000
const PROBE_READY_TIMEOUT_MS = 8000
/** the urltest group's own startup check (dead nodes time out after ~5 s) */
const AUTO_FIRST_CHECK_MS = 8000

const NO_AUTO: AutoInfo = { checking: false, dead: false }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Resolves true once something accepts TCP connections on 127.0.0.1:port. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(500, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** xray prints "2026/01/01 00:00:00.000000 [Warning] ..." — map to our levels. */
function xrayLevel(line: string): LogEntry['level'] {
  if (/\[Error\]|^panic/i.test(line)) return 'error'
  if (/\[Warning\]/i.test(line)) return 'warn'
  if (/\[Debug\]/i.test(line)) return 'debug'
  return 'info'
}

function singboxLevel(line: string): LogEntry['level'] {
  if (/\b(ERROR|FATAL|PANIC)\b|error|fatal/i.test(line)) return 'error'
  if (/\bWARN\b|warn/i.test(line)) return 'warn'
  return 'info'
}

/** Picks free loopback ports for every VLESS node, avoiding `taken`. */
async function allocBridges(nodes: OutboundConfig[], taken: Set<number>): Promise<XrayBridge[]> {
  const bridges: XrayBridge[] = []
  for (const o of nodes) {
    let port = await findFreePort(0)
    while (taken.has(port)) port = await findFreePort(0)
    taken.add(port)
    bridges.push({ outbound: o, port })
  }
  return bridges
}

function killProc(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 2000)
    proc.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
    proc.kill()
  })
}

/**
 * Drives the cores: xray (VLESS connections, one loopback SOCKS inbound per
 * node) and sing-box (TUN / system proxy, routing, DNS, Hysteria2).
 * Order: xray starts before sing-box and stops after it. If xray dies while
 * connected, everything is stopped with an error (no silent fallback).
 *  - System Proxy mode: sing-box spawned as a normal child (full stdio), the
 *    WinInet registry proxy points at its mixed inbound.
 *  - TUN mode: sing-box needs admin. We launch it through an elevated broker
 *    (one UAC prompt on connect). The broker watches a stop-file so we can
 *    terminate it later without a second prompt. Logs come from the log file.
 * «Connected» is reported only once the Clash API of the new core answers.
 * Routing mode and server switches go through the Clash API — no restart.
 */
export class SidecarManager {
  private child: ChildProcess | null = null // system-proxy mode child
  private xray: ChildProcess | null = null // xray-core child (always non-elevated)
  private xrayTail: string[] = [] // last output lines, for error messages
  private coreTail: string[] = [] // last sing-box lines, for error messages
  private restarts = 0
  private intentionalStop = false
  private starting = false
  private running = false
  private elevation: 'pending' | 'ok' | 'failed' = 'pending'
  private mode: AppSettings['proxyMode'] = 'system'
  private api: ClashApi | null = null
  private auto: AutoInfo = NO_AUTO
  /** bumps on every start/stop so a stale background check can't publish */
  private autoGen = 0
  /** latencies measured during this app run (fresher than StartParams.latencies) */
  private recentPings: Record<string, number | null> = {}
  private nodeIds: string[] = []
  /** TUN: an adapter with our address was already there before this start */
  private staleAdapter = false
  private probing: Promise<ServerPing[]> | null = null
  /** we switched the Windows proxy on and must switch it off again */
  private proxySet = false

  private trafficTimer: NodeJS.Timeout | null = null
  private tailTimer: NodeJS.Timeout | null = null
  private tailPos = 0
  private tick = 0
  private prevTotals: { up: number; down: number } | null = null

  private ports = { http: 0, clashApi: 0 }
  private lastParams: StartParams | null = null
  private totals: TrafficStats = {
    uploadSpeed: 0,
    downloadSpeed: 0,
    totalUpload: 0,
    totalDownload: 0
  }

  constructor(
    private onLog: LogFn,
    private onState: StateFn,
    private onTraffic: TrafficFn,
    private onAuto: AutoFn = () => undefined,
    /** latencies measured by the running core (startup check of the group) */
    private onPings: PingsFn = () => undefined,
    /** resolved node IPs — so they are masked in the log like the host names */
    private onServerIps: IpsFn = () => undefined
  ) {}

  private get binDir(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'bin')
      : join(process.cwd(), 'resources', 'bin')
  }
  private get runDir(): string {
    return join(app.getPath('userData'), 'run')
  }
  private exePath(): string {
    return join(this.binDir, 'sing-box.exe')
  }
  private xrayExePath(): string {
    return join(this.binDir, XRAY_EXE)
  }
  private get configPath(): string {
    return join(this.runDir, 'config.json')
  }
  private get xrayConfigPath(): string {
    return join(this.runDir, 'xray.json')
  }
  private get logPath(): string {
    return join(this.runDir, 'sing-box.log')
  }
  private get stopFile(): string {
    return join(this.runDir, 'stop.signal')
  }
  private get restartFile(): string {
    return join(this.runDir, 'restart.signal')
  }
  private get exitFile(): string {
    return join(this.runDir, 'core.exit')
  }

  /** Clash API of the running core (null while disconnected). */
  get clash(): ClashApi | null {
    return this.running ? this.api : null
  }
  get proxyMode(): AppSettings['proxyMode'] {
    return this.mode
  }
  get isRunning(): boolean {
    return this.running
  }

  private log(level: LogEntry['level'], source: LogEntry['source'], message: string): void {
    if (!message) return
    this.onLog({ ts: Date.now(), level, source, message })
  }

  async start(p: StartParams): Promise<void> {
    // a latency probe holds its own cores — let it finish first
    if (this.probing) await this.probing.catch(() => undefined)
    // a previous xray (e.g. auto-restart path) must be gone before ports are re-bound
    await this.stopXray()
    this.intentionalStop = false
    this.restarts = 0
    this.lastParams = p
    this.mode = p.settings.proxyMode
    this.running = false
    this.api = null
    this.autoGen++
    this.setAuto(NO_AUTO)
    this.nodeIds = p.outbounds.map((o) => o.id)
    this.coreTail = []
    this.onState('connecting')

    if (!existsSync(this.exePath())) {
      this.onState('error', 'sing-box.exe не найден — переустановите приложение')
      this.log('error', 'app', `sing-box.exe отсутствует в ${this.binDir}`)
      throw new Error('sing-box.exe missing')
    }
    if (p.outbounds.length === 0) {
      this.onState('error', 'Нет серверов. Добавьте подписку на странице «Подписка».')
      throw new Error('no outbounds')
    }
    const xrayNodes = p.outbounds.filter(isXrayHandled)
    if (xrayNodes.length > 0 && !existsSync(this.xrayExePath())) {
      this.onState('error', 'xray.exe не найден — переустановите приложение')
      this.log('error', 'app', `${XRAY_EXE} отсутствует в ${this.binDir}`)
      throw new Error('xray.exe missing')
    }

    this.starting = true
    try {
      await mkdir(this.runDir, { recursive: true })
      for (const f of [this.stopFile, this.restartFile, this.exitFile, this.logPath]) {
        await rm(f, { force: true }).catch(() => undefined)
      }

      // TUN: node IPs are resolved now (system DNS, TUN not up yet), excluded
      // from the TUN routes and pinned in xray — its connections to the nodes
      // go straight out of the physical NIC instead of through sing-box again
      let serverIps: ServerIps = {}
      if (this.mode === 'tun') {
        serverIps = await resolveServers(p.outbounds)
        this.onServerIps(allIps(serverIps))
        const hosts = new Set(p.outbounds.map((o) => o.server)).size
        this.log(
          'info',
          'app',
          `Адреса серверов определены: ${Object.keys(serverIps).length} из ${hosts}, исключено из TUN: ${toExcludeCidrs(serverIps).length}`
        )
      }

      this.ports.http = await findFreePort(p.settings.httpPort)
      this.ports.clashApi = await findFreePort(0)

      // one loopback SOCKS inbound per VLESS node, on random free ports
      const bridges = await allocBridges(xrayNodes, new Set([this.ports.http, this.ports.clashApi]))
      const xrayPorts = Object.fromEntries(bridges.map((b) => [b.outbound.id, b.port]))

      const cfg = generateSingboxConfig({
        outbounds: p.outbounds,
        activeOutboundId: p.activeOutboundId,
        rules: p.rules,
        settings: p.settings,
        socksPort: p.settings.socksPort,
        httpPort: this.ports.http,
        clashApiPort: this.ports.clashApi,
        logFile: this.logPath,
        cacheFile: join(this.runDir, 'cache.db'),
        xrayPorts,
        serverIps,
        latencies: { ...(p.latencies ?? {}), ...this.recentPings }
      })
      await writeFile(this.configPath, JSON.stringify(cfg, null, 2), 'utf8')

      if (bridges.length > 0) {
        const xcfg = generateXrayConfig(bridges, {
          serverIps,
          verbose: p.settings.verboseLog
        })
        await writeFile(this.xrayConfigPath, JSON.stringify(xcfg, null, 2), 'utf8')
        await this.startXray(bridges.map((b) => b.port))
      }

      this.api = new ClashApi(this.ports.clashApi)
      this.startLogTail()
      if (this.mode === 'tun') {
        // after a reload the old adapter may take a moment to disappear
        for (let i = 0; i < 15 && hasTunAdapter(networkInterfaces(), TUN_ADDRESS4); i++)
          await sleep(200)
        this.staleAdapter = hasTunAdapter(networkInterfaces(), TUN_ADDRESS4)
        if (this.staleAdapter)
          this.log('warn', 'app', 'Сетевой адаптер CipherWay остался от прошлого запуска')
        await this.startElevated()
      } else {
        this.startChild()
      }
      await this.waitCoreReady()
      if (this.mode === 'tun') await this.waitTunReady()

      // cache.db remembers the last mode / selector choice and would override
      // the config defaults — apply what the user picked explicitly
      await this.applyRuntimeChoices(p)

      if (this.mode !== 'tun') {
        await enableSystemProxy(this.ports.http)
        this.proxySet = true
        this.log('info', 'app', `Системный прокси включён на 127.0.0.1:${this.ports.http}`)
      }
      this.running = true
      this.startTrafficPolling()
      this.onState('connected')
      void this.autoCheck()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await this.stop(true)
      this.onState('error', msg)
      throw err
    } finally {
      this.starting = false
    }
  }

  private async applyRuntimeChoices(p: StartParams): Promise<void> {
    const api = this.api
    if (!api) return
    await api.setMode(CLASH_MODE[p.settings.routingMode]).catch(() => false)
    const ids = new Set(p.outbounds.map((o) => o.id))
    const target =
      p.activeOutboundId && (p.activeOutboundId === AUTO_OUTBOUND_ID || ids.has(p.activeOutboundId))
        ? p.activeOutboundId
        : TAG_AUTO
    await api.select(TAG_PROXY_GROUP, target).catch(() => false)
  }

  /** Waits until the new sing-box answers on its Clash API, or explains why not. */
  private async waitCoreReady(timeoutMs?: number): Promise<void> {
    const api = this.api
    if (!api) throw new Error('Ядро не запущено')
    const tun = this.mode === 'tun'
    const deadline =
      Date.now() + (timeoutMs ?? (tun ? CORE_READY_TIMEOUT_TUN_MS : CORE_READY_TIMEOUT_MS))
    while (Date.now() < deadline) {
      if (this.intentionalStop) throw new Error('Подключение отменено')
      if (await api.ping()) return
      if (tun && this.elevation === 'failed') {
        throw new Error('Не удалось получить права администратора для режима TUN')
      }
      if (!tun && !this.child) break // sing-box exited during startup
      if (tun && existsSync(this.exitFile)) break // ... or under the broker
      if (this.coreTail.some((l) => /\bFATAL\b/.test(l))) break
      await sleep(250)
    }
    throw new Error(`Ядро sing-box не запустилось${await this.coreReason()}`)
  }

  /** «: <last error line of sing-box>» or '' */
  private async coreReason(): Promise<string> {
    await this.tailOnce()
    const reason =
      this.coreTail.filter((l) => /error|fatal/i.test(l)).at(-1) ?? this.coreTail.at(-1)
    return reason ? `: ${reason.replace(/^.*?(FATAL|ERROR)(\[\d+\])?\s*/i, '')}` : ''
  }

  /**
   * TUN: the Clash API answers before the TUN inbound is up — wait for the
   * wintun adapter itself. The first one on a machine can take 20–40 s
   * («open interface take too much time»); on failure the broker restarts
   * sing-box once (no second UAC prompt).
   */
  private async waitTunReady(): Promise<void> {
    let why = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.onState(
        'connecting',
        attempt === 1 ? 'Создаём сетевой адаптер…' : 'Повторная попытка: создаём сетевой адаптер…'
      )
      const res = await this.pollAdapter(TUN_ADAPTER_TIMEOUT_MS)
      if (res === 'ok') {
        this.log('info', 'app', 'Сетевой адаптер TUN готов')
        return
      }
      if (res === 'cancel') throw new Error('Подключение отменено')
      why = res === 'exited' ? await this.coreReason() : ''
      this.log(
        'warn',
        'app',
        res === 'exited'
          ? `Ядро завершилось при создании адаптера TUN${why}`
          : `Адаптер TUN не создан за ${TUN_ADAPTER_TIMEOUT_MS / 1000} с`
      )
      if (attempt === 1) {
        this.log('info', 'app', 'Повторная попытка запуска TUN')
        await this.restartElevatedCore()
      }
    }
    throw new Error(
      `Не удалось создать сетевой адаптер TUN${why}. Перезагрузите компьютер и попробуйте снова или выберите «Системный прокси» в Настройках.`
    )
  }

  private async pollAdapter(timeoutMs: number): Promise<'ok' | 'exited' | 'timeout' | 'cancel'> {
    const api = this.api
    const since = Date.now()
    const deadline = since + timeoutMs
    while (Date.now() < deadline) {
      if (this.intentionalStop) return 'cancel'
      if (existsSync(this.exitFile)) return 'exited'
      // a leftover adapter proves nothing: then give the core a few seconds to fail
      const up =
        hasTunAdapter(networkInterfaces(), TUN_ADDRESS4) &&
        (!this.staleAdapter || Date.now() - since > 3000)
      if (up && (await api?.ping())) return 'ok'
      await sleep(300)
    }
    return 'timeout'
  }

  /** Asks the elevated broker for a fresh sing-box and waits for its Clash API. */
  private async restartElevatedCore(): Promise<void> {
    this.coreTail = []
    await writeFile(this.restartFile, '1', 'utf8')
    // the broker removes the signal once the new sing-box is launched
    for (let i = 0; i < 40 && existsSync(this.restartFile); i++) await sleep(200)
    if (existsSync(this.restartFile)) {
      await rm(this.restartFile, { force: true }).catch(() => undefined)
      throw new Error('Служебный процесс TUN не отвечает — попробуйте подключиться ещё раз')
    }
    await this.waitCoreReady(CORE_READY_TIMEOUT_MS)
  }

  /**
   * Starts xray-core and waits until its first SOCKS inbound accepts
   * connections. Throws (with a readable reason) if xray exits or times out.
   */
  private async startXray(ports: number[]): Promise<void> {
    this.xrayTail = []
    const proc = spawn(this.xrayExePath(), ['run', '-c', this.xrayConfigPath], {
      cwd: this.binDir,
      windowsHide: true
    })
    this.xray = proc
    let exited = false
    const onData = (d: Buffer): void => {
      for (const raw of d.toString().split(/\r?\n/)) {
        const line = raw.trim()
        if (!line) continue
        this.xrayTail = [...this.xrayTail.slice(-4), line]
        this.log(xrayLevel(line), 'xray', line)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (err) =>
      this.log('error', 'xray', `Не удалось запустить xray: ${err.message}`)
    )
    proc.on('exit', (code) => {
      exited = true
      if (this.xray !== proc) return // stopped on purpose / replaced
      this.xray = null
      this.log('error', 'xray', `xray завершился (code=${code})`)
      if (this.intentionalStop || this.starting) return
      // xray died while connected: tear everything down and show why
      const reason = this.xrayTail.at(-1)
      const msg = `Ядро Xray остановилось (код ${code ?? '?'}), соединение разорвано.${reason ? ` ${reason}` : ''}`
      void this.stop(true).then(() => this.onState('error', msg))
    })
    this.log('info', 'app', `Запуск xray: узлов VLESS — ${ports.length}, вход 127.0.0.1`)

    // every node's inbound must accept connections before sing-box starts:
    // the first DNS query / urltest probe goes through them immediately
    const deadline = Date.now() + XRAY_READY_TIMEOUT_MS
    const pending = new Set(ports)
    while (Date.now() < deadline && !exited) {
      const res = await Promise.all(
        [...pending].map(async (pt) => [pt, await probePort(pt)] as const)
      )
      for (const [pt, ok] of res) if (ok) pending.delete(pt)
      if (pending.size === 0) return
      await sleep(150)
    }
    const reason = this.xrayTail.at(-1) ?? 'нет ответа'
    await this.stopXray()
    throw new Error(`Не удалось запустить ядро Xray: ${reason}`)
  }

  private async stopXray(): Promise<void> {
    const proc = this.xray
    if (!proc) return
    this.xray = null // the exit handler ignores a process we stop ourselves
    await killProc(proc)
  }

  /** System-proxy mode: normal child process with captured stdio. */
  private startChild(): void {
    const proc = spawn(this.exePath(), ['run', '-c', this.configPath], {
      cwd: this.binDir, // so wintun.dll / assets resolve next to the exe
      windowsHide: true
    })
    this.child = proc
    const onData = (d: Buffer): void => {
      for (const raw of d.toString().split(/\r?\n/)) {
        const line = raw.trim()
        if (!line) continue
        this.coreTail = [...this.coreTail.slice(-6), line]
        this.log(singboxLevel(line), 'singbox', line)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', (code) => {
      if (this.child !== proc) return
      this.log('warn', 'singbox', `sing-box завершился (code=${code})`)
      this.child = null
      if (!this.starting) this.maybeRestart()
    })
  }

  /**
   * TUN mode: launch an elevated PowerShell broker that starts sing-box and
   * watches the stop-file. Triggers a single UAC prompt; disconnect just
   * writes the stop-file (no second prompt).
   */
  private async startElevated(): Promise<void> {
    this.elevation = 'pending'
    const brokerPath = join(this.runDir, 'broker.ps1')
    const script = brokerScript({
      exe: this.exePath(),
      config: this.configPath,
      workDir: this.binDir,
      stopFile: this.stopFile,
      restartFile: this.restartFile,
      exitFile: this.exitFile,
      parentPid: process.pid
    })
    // BOM: Windows PowerShell 5.1 reads BOM-less scripts as ANSI (Cyrillic user names)
    await writeFile(brokerPath, `\ufeff${script}`, 'utf8')

    // outer (non-elevated) PowerShell requests elevation for the broker -> UAC
    const launchCmd = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(brokerPath)})`
    const launcher = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', launchCmd],
      { windowsHide: true }
    )
    launcher.on('exit', (code) => {
      // code 0 = UAC accepted & broker launched; non-zero/null = likely denied
      this.elevation = code === 0 ? 'ok' : 'failed'
      if (code !== 0 && !this.intentionalStop) {
        this.log('error', 'app', `UAC отклонён или ошибка запуска (code=${code})`)
      }
    })
    this.log('info', 'app', 'Запуск sing-box в режиме TUN (запрошены права администратора)')
  }

  /** TUN: sing-box died under the broker while connected. */
  private async coreDied(): Promise<void> {
    if (!this.running || this.intentionalStop) return
    this.running = false
    const reason = await this.coreReason()
    this.log('error', 'singbox', `sing-box завершился${reason}`)
    await this.stop(true)
    this.onState('error', `Ядро sing-box остановилось, соединение разорвано${reason}`)
  }

  private maybeRestart(): void {
    if (this.intentionalStop || !this.lastParams) return
    if (this.mode === 'tun') return // broker owns the elevated lifecycle
    if (this.restarts >= MAX_RESTARTS) {
      this.onState('error', 'Превышено число перезапусков ядра')
      void this.stop(true)
      return
    }
    this.restarts++
    this.log('warn', 'app', `Авто-перезапуск ядра (${this.restarts}/${MAX_RESTARTS})`)
    const params = this.lastParams
    const restarts = this.restarts
    setTimeout(() => {
      if (this.intentionalStop) return
      void this.start(params)
        .then(() => {
          this.restarts = restarts
        })
        .catch(() => undefined)
    }, 1500)
  }

  /** Restart with a new config (rules changed, proxy mode changed). */
  async reload(p: StartParams): Promise<void> {
    if (!this.running) return
    this.log('info', 'app', 'Применение новой конфигурации…')
    await this.stop(true)
    await this.start(p)
  }

  /** Правила / Весь трафик / Напрямую — on the fly; open connections are reset. */
  async setRoutingMode(mode: RoutingMode): Promise<boolean> {
    if (this.lastParams)
      this.lastParams.settings = { ...this.lastParams.settings, routingMode: mode }
    const api = this.clash
    if (!api) return false
    const ok = await api.setMode(CLASH_MODE[mode]).catch(() => false)
    // existing connections keep their old route otherwise
    if (ok) await api.closeAll()
    this.log(
      ok ? 'info' : 'warn',
      'app',
      ok ? `Режим: ${CLASH_MODE[mode]}` : 'Не удалось сменить режим'
    )
    return ok
  }

  /** Switches the `proxy` selector (a node id or «auto»); false = needs a restart. */
  async selectServer(id: string): Promise<boolean> {
    if (this.lastParams) this.lastParams.activeOutboundId = id
    const api = this.clash
    if (!api) return false
    const ok = await api.select(TAG_PROXY_GROUP, id).catch(() => false)
    if (ok) void this.refreshAuto()
    return ok
  }

  /**
   * Real latency of every node: an HTTP request to generate_204 through the
   * node itself (Clash API `/delay`), in parallel, 5 s timeout. While
   * disconnected a throw-away xray + sing-box pair (no inbounds) is started
   * just for the test and stopped right after.
   */
  async testLatency(outbounds: OutboundConfig[]): Promise<ServerPing[]> {
    const api = this.clash
    if (api) return this.measure(api, outbounds)
    if (this.starting) return outbounds.map((o) => ({ outboundId: o.id, latencyMs: null }))
    this.probing ??= this.probe(outbounds).finally(() => {
      this.probing = null
    })
    return this.probing
  }

  private async measure(api: ClashApi, outbounds: OutboundConfig[]): Promise<ServerPing[]> {
    const res = await Promise.all(
      outbounds.map(async (o) => ({ outboundId: o.id, latencyMs: await api.delay(o.id) }))
    )
    this.remember(res)
    return res
  }

  private remember(pings: ServerPing[]): void {
    for (const p of pings) this.recentPings[p.outboundId] = p.latencyMs
  }

  private async probe(outbounds: OutboundConfig[]): Promise<ServerPing[]> {
    const none = outbounds.map((o) => ({ outboundId: o.id, latencyMs: null }))
    if (outbounds.length === 0 || !existsSync(this.exePath())) return none
    const dir = join(this.runDir, 'probe')
    await mkdir(dir, { recursive: true })
    let xray: ChildProcess | null = null
    let core: ChildProcess | null = null
    try {
      const clashPort = await findFreePort(0)
      const vless = outbounds.filter(isXrayHandled)
      const bridges = existsSync(this.xrayExePath())
        ? await allocBridges(vless, new Set([clashPort]))
        : []
      const usable = outbounds.filter(
        (o) => !isXrayHandled(o) || bridges.some((b) => b.outbound.id === o.id)
      )
      const xrayPorts = Object.fromEntries(bridges.map((b) => [b.outbound.id, b.port]))

      if (bridges.length) {
        const xcfg = join(dir, 'xray.json')
        await writeFile(xcfg, JSON.stringify(generateXrayConfig(bridges)), 'utf8')
        xray = spawn(this.xrayExePath(), ['run', '-c', xcfg], {
          cwd: this.binDir,
          windowsHide: true
        })
        xray.stdout?.resume()
        xray.stderr?.resume()
      }
      const cfgPath = join(dir, 'sing-box.json')
      const cfg = generateProbeConfig({
        outbounds: usable,
        clashApiPort: clashPort,
        logFile: join(dir, 'sing-box.log'),
        xrayPorts
      })
      await writeFile(cfgPath, JSON.stringify(cfg), 'utf8')
      core = spawn(this.exePath(), ['run', '-c', cfgPath], { cwd: this.binDir, windowsHide: true })
      core.stdout?.resume()
      core.stderr?.resume()

      const api = new ClashApi(clashPort)
      const deadline = Date.now() + PROBE_READY_TIMEOUT_MS
      let up = false
      while (Date.now() < deadline && core.exitCode === null) {
        if (await api.ping()) {
          up = true
          break
        }
        await sleep(150)
      }
      if (!up) {
        this.log('warn', 'app', 'Проверка задержки: временное ядро не запустилось')
        return none
      }
      // xray needs a moment to bind its inbounds too
      if (bridges.length) {
        const xd = Date.now() + XRAY_READY_TIMEOUT_MS
        while (Date.now() < xd && xray?.exitCode === null && !(await probePort(bridges[0].port))) {
          await sleep(100)
        }
      }
      const measured = await this.measure(api, usable)
      const byId = new Map(measured.map((m) => [m.outboundId, m.latencyMs]))
      return outbounds.map((o) => ({ outboundId: o.id, latencyMs: byId.get(o.id) ?? null }))
    } catch (err) {
      this.log(
        'warn',
        'app',
        `Проверка задержки не удалась: ${err instanceof Error ? err.message : err}`
      )
      return none
    } finally {
      await killProc(core)
      await killProc(xray)
      // configs hold node credentials — don't leave them around
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async stop(keepIntent = false): Promise<void> {
    this.intentionalStop = true
    this.running = false
    this.stopTrafficPolling()

    this.autoGen++

    if (this.mode === 'tun') {
      // signal the elevated broker to kill sing-box
      await writeFile(this.stopFile, '1', 'utf8').catch(() => undefined)
      // the broker deletes the stop-file once sing-box is gone
      for (let i = 0; i < 20 && existsSync(this.stopFile); i++) await sleep(150)
      await rm(this.exitFile, { force: true }).catch(() => undefined)
    } else {
      const child = this.child
      this.child = null
      await killProc(child)
    }
    // only undo what we did — never reset a proxy someone else configured
    if (this.proxySet) {
      this.proxySet = false
      await disableSystemProxy().catch(() => undefined)
    }
    // xray goes down after sing-box, so traffic never falls through to direct
    await this.stopXray()
    await this.tailOnce()
    this.stopLogTail()
    this.api = null
    this.setAuto(NO_AUTO)

    if (!keepIntent) {
      this.totals = { uploadSpeed: 0, downloadSpeed: 0, totalUpload: 0, totalDownload: 0 }
      this.prevTotals = null
      this.onState('disconnected')
      this.log('info', 'app', 'Отключено')
    }
  }

  // --- log file tailing (TUN mode has no stdio) ---------------------------

  private startLogTail(): void {
    this.stopLogTail()
    this.tailPos = 0
    this.tailTimer = setInterval(() => void this.tailOnce(), 600)
  }
  private stopLogTail(): void {
    if (this.tailTimer) clearInterval(this.tailTimer)
    this.tailTimer = null
  }
  private async tailOnce(): Promise<void> {
    try {
      const st = await stat(this.logPath)
      if (st.size < this.tailPos) this.tailPos = 0 // a restarted core recreated the file
      if (st.size <= this.tailPos) return
      const fh = await open(this.logPath, 'r')
      const len = st.size - this.tailPos
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, this.tailPos)
      await fh.close()
      this.tailPos = st.size
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const t = line.trim()
        if (!t) continue
        this.coreTail = [...this.coreTail.slice(-6), t]
        this.log(singboxLevel(t), 'singbox', t)
      }
    } catch {
      /* log file not created yet */
    }
  }

  // --- traffic via the clash API (/connections totals -> speed) -----------

  private startTrafficPolling(): void {
    this.stopTrafficPolling()
    this.tick = 0
    this.trafficTimer = setInterval(() => void this.pollTraffic(), 1000)
  }
  private stopTrafficPolling(): void {
    if (this.trafficTimer) clearInterval(this.trafficTimer)
    this.trafficTimer = null
  }

  private setAuto(next: AutoInfo): void {
    const a = this.auto
    if (
      a.nodeId === next.nodeId &&
      a.delayMs === next.delayMs &&
      a.checking === next.checking &&
      a.dead === next.dead
    ) {
      return
    }
    this.auto = next
    this.onAuto(next)
  }

  /**
   * Right after connecting: «Лучший сервер (авто)» shows «проверяем…» until
   * the urltest group has checked its members (sing-box does that on start;
   * the explicit /group/auto/delay is a no-op then, and a real check if the
   * startup one didn't happen). Then: the chosen node and its latency, every
   * node's latency for the list, or an honest «no server answers».
   */
  private async autoCheck(): Promise<void> {
    const api = this.api
    if (!api) return
    const gen = this.autoGen
    const alive = (): boolean => this.running && this.autoGen === gen && this.api === api
    this.setAuto({ checking: true, dead: false })
    void api.groupDelay(TAG_AUTO)

    const deadline = Date.now() + AUTO_FIRST_CHECK_MS
    let st = await api.proxyState(TAG_AUTO)
    while (alive() && !st?.now && Date.now() < deadline) {
      await sleep(400)
      st = await api.proxyState(TAG_AUTO)
    }
    if (!alive()) return
    if (!st?.now) {
      // nothing yet — one explicit check, it ends within its own timeout
      await api.groupDelay(TAG_AUTO)
      if (!alive()) return
      st = await api.proxyState(TAG_AUTO)
    }

    const all = await api.proxies()
    if (!alive()) return
    if (all) {
      const pings = this.nodeIds.map((id) => ({
        outboundId: id,
        latencyMs: all[id]?.delay ?? null
      }))
      this.remember(pings)
      this.onPings(pings)
    }
    const dead = !st?.now || st.delay === undefined
    this.setAuto({
      nodeId: st?.now || undefined,
      delayMs: dead ? null : st?.delay,
      checking: false,
      dead
    })
    if (dead) {
      this.log(
        'warn',
        'app',
        'Ни один сервер не ответил на проверку — проверьте интернет или выберите сервер вручную'
      )
    }
  }

  /** Periodic: follow the urltest group's choice (re-checked every 5 min by sing-box). */
  private async refreshAuto(): Promise<void> {
    if (this.auto.checking) return
    const api = this.clash
    if (!api) return
    const st = await api.proxyState(TAG_AUTO)
    if (!st || !this.running || this.auto.checking) return
    const dead = !st.now || st.delay === undefined
    this.setAuto({
      nodeId: st.now || undefined,
      delayMs: dead ? null : st.delay,
      checking: false,
      dead
    })
  }

  private async pollTraffic(): Promise<void> {
    const api = this.clash
    if (!api) return
    ++this.tick
    if (this.tick % 5 === 0) void this.refreshAuto()
    // TUN: the broker reports a sing-box that died on its own
    if (this.mode === 'tun' && this.tick % 2 === 0 && existsSync(this.exitFile)) {
      void this.coreDied()
      return
    }
    const json = await api.connections()
    if (!json) return
    const down = json.downloadTotal ?? 0
    const up = json.uploadTotal ?? 0
    if (this.prevTotals) {
      this.totals = {
        uploadSpeed: Math.max(0, up - this.prevTotals.up),
        downloadSpeed: Math.max(0, down - this.prevTotals.down),
        totalUpload: up,
        totalDownload: down
      }
      this.onTraffic(this.totals)
    }
    this.prevTotals = { up, down }
  }
}
