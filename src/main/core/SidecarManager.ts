import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, rm, writeFile, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { app } from 'electron'
import {
  AUTO_OUTBOUND_ID,
  type AppSettings,
  type ConnectionState,
  type LogEntry,
  type OutboundConfig,
  type RoutingMode,
  type RulesConfig,
  type ServerPing,
  type TrafficStats
} from '@shared/types'
import { generateProbeConfig, generateSingboxConfig } from './configGen'
import { generateXrayConfig, isXrayHandled, XRAY_EXE, type XrayBridge } from './xrayGen'
import { ClashApi } from './clashApi'
import { CLASH_MODE, TAG_AUTO, TAG_PROXY_GROUP } from './sbTypes'
import { findFreePort } from '../system/ports'
import { disableSystemProxy, enableSystemProxy } from '../system/proxy'

type LogFn = (entry: LogEntry) => void
type StateFn = (state: ConnectionState, message?: string) => void
type TrafficFn = (stats: TrafficStats) => void
type AutoFn = (nodeId: string | undefined) => void

export interface StartParams {
  outbounds: OutboundConfig[]
  activeOutboundId: string | undefined
  rules: RulesConfig
  settings: AppSettings
}

const MAX_RESTARTS = 5
const XRAY_READY_TIMEOUT_MS = 8000
/** system proxy: sing-box is up in well under a second; remote rule-sets may take a few */
const CORE_READY_TIMEOUT_MS = 25_000
/** TUN: includes the time the user needs to answer the UAC prompt */
const CORE_READY_TIMEOUT_TUN_MS = 90_000
const PROBE_READY_TIMEOUT_MS = 8000

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
  private autoNow: string | undefined
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
    private onAuto: AutoFn = () => undefined
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
    this.autoNow = undefined
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
      await rm(this.stopFile, { force: true }).catch(() => undefined)
      await rm(this.logPath, { force: true }).catch(() => undefined)

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
        xrayPorts
      })
      await writeFile(this.configPath, JSON.stringify(cfg, null, 2), 'utf8')

      if (bridges.length > 0) {
        const xcfg = generateXrayConfig(bridges)
        await writeFile(this.xrayConfigPath, JSON.stringify(xcfg, null, 2), 'utf8')
        await this.startXray(bridges.map((b) => b.port))
      }

      this.api = new ClashApi(this.ports.clashApi)
      this.startLogTail()
      if (this.mode === 'tun') {
        await this.startElevated()
      } else {
        this.startChild()
      }
      await this.waitCoreReady()

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
  private async waitCoreReady(): Promise<void> {
    const api = this.api
    if (!api) throw new Error('Ядро не запущено')
    const tun = this.mode === 'tun'
    const deadline = Date.now() + (tun ? CORE_READY_TIMEOUT_TUN_MS : CORE_READY_TIMEOUT_MS)
    while (Date.now() < deadline) {
      if (this.intentionalStop) throw new Error('Подключение отменено')
      if (await api.ping()) return
      if (tun && this.elevation === 'failed') {
        throw new Error('Не удалось получить права администратора для режима TUN')
      }
      if (!tun && !this.child) break // sing-box exited during startup
      if (this.coreTail.some((l) => /\bFATAL\b/.test(l))) break
      await sleep(250)
    }
    await this.tailOnce()
    const reason = this.coreTail.filter((l) => /error|fatal/i.test(l)).at(-1) ?? this.coreTail.at(-1)
    throw new Error(
      `Ядро sing-box не запустилось${reason ? `: ${reason.replace(/^.*?(FATAL|ERROR)\s*/i, '')}` : ''}`
    )
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

    const deadline = Date.now() + XRAY_READY_TIMEOUT_MS
    while (Date.now() < deadline && !exited) {
      if (await probePort(ports[0])) return
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
    const script = `
$exe = ${JSON.stringify(this.exePath())}
$cfg = ${JSON.stringify(this.configPath)}
$stop = ${JSON.stringify(this.stopFile)}
$wd  = ${JSON.stringify(this.binDir)}
$p = Start-Process -FilePath $exe -ArgumentList @('run','-c',$cfg) -WorkingDirectory $wd -WindowStyle Hidden -PassThru
while (-not (Test-Path $stop)) {
  if ($p.HasExited) { break }
  Start-Sleep -Milliseconds 400
}
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Remove-Item $stop -ErrorAction SilentlyContinue
`.trim()
    await writeFile(brokerPath, script, 'utf8')

    // outer (non-elevated) PowerShell requests elevation for the broker -> UAC
    const launchCmd = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${brokerPath.replace(/'/g, "''")}')`
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
    if (this.lastParams) this.lastParams.settings = { ...this.lastParams.settings, routingMode: mode }
    const api = this.clash
    if (!api) return false
    const ok = await api.setMode(CLASH_MODE[mode]).catch(() => false)
    // existing connections keep their old route otherwise
    if (ok) await api.closeAll()
    this.log(ok ? 'info' : 'warn', 'app', ok ? `Режим: ${CLASH_MODE[mode]}` : 'Не удалось сменить режим')
    return ok
  }

  /** Switches the `proxy` selector (a node id or «auto»); false = needs a restart. */
  async selectServer(id: string): Promise<boolean> {
    if (this.lastParams) this.lastParams.activeOutboundId = id
    const api = this.clash
    if (!api) return false
    const ok = await api.select(TAG_PROXY_GROUP, id).catch(() => false)
    if (ok) void this.refreshAutoNow()
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
    return Promise.all(
      outbounds.map(async (o) => ({ outboundId: o.id, latencyMs: await api.delay(o.id) }))
    )
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
      const usable = outbounds.filter((o) => !isXrayHandled(o) || bridges.some((b) => b.outbound.id === o.id))
      const xrayPorts = Object.fromEntries(bridges.map((b) => [b.outbound.id, b.port]))

      if (bridges.length) {
        const xcfg = join(dir, 'xray.json')
        await writeFile(xcfg, JSON.stringify(generateXrayConfig(bridges)), 'utf8')
        xray = spawn(this.xrayExePath(), ['run', '-c', xcfg], { cwd: this.binDir, windowsHide: true })
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
      this.log('warn', 'app', `Проверка задержки не удалась: ${err instanceof Error ? err.message : err}`)
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

    if (this.mode === 'tun') {
      // signal the elevated broker to kill sing-box
      await writeFile(this.stopFile, '1', 'utf8').catch(() => undefined)
      // the broker deletes the stop-file once sing-box is gone
      for (let i = 0; i < 20 && existsSync(this.stopFile); i++) await sleep(150)
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
    if (this.autoNow !== undefined) {
      this.autoNow = undefined
      this.onAuto(undefined)
    }

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
    void this.refreshAutoNow()
  }
  private stopTrafficPolling(): void {
    if (this.trafficTimer) clearInterval(this.trafficTimer)
    this.trafficTimer = null
  }

  private async refreshAutoNow(): Promise<void> {
    const now = (await this.clash?.groupNow(TAG_AUTO)) ?? undefined
    if (now !== this.autoNow) {
      this.autoNow = now
      this.onAuto(now)
    }
  }

  private async pollTraffic(): Promise<void> {
    const api = this.clash
    if (!api) return
    if (++this.tick % 5 === 0) void this.refreshAutoNow()
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
