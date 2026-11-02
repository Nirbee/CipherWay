import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, rm, writeFile, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  AppSettings,
  ConnectionState,
  LogEntry,
  OutboundConfig,
  RulesConfig,
  TrafficStats
} from '@shared/types'
import { generateSingboxConfig } from './configGen'
import { generateXrayConfig, isXrayHandled, XRAY_EXE, type XrayBridge } from './xrayGen'
import { findFreePort } from '../system/ports'
import { disableSystemProxy, enableSystemProxy } from '../system/proxy'

type LogFn = (entry: LogEntry) => void
type StateFn = (state: ConnectionState, message?: string) => void
type TrafficFn = (stats: TrafficStats) => void

export interface StartParams {
  outbounds: OutboundConfig[]
  activeOutboundId: string | undefined
  rules: RulesConfig
  settings: AppSettings
}

const MAX_RESTARTS = 5
const XRAY_READY_TIMEOUT_MS = 8000

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
 */
export class SidecarManager {
  private child: ChildProcess | null = null // system-proxy mode child
  private xray: ChildProcess | null = null // xray-core child (always non-elevated)
  private xrayTail: string[] = [] // last output lines, for error messages
  private restarts = 0
  private intentionalStop = false
  private mode: AppSettings['proxyMode'] = 'system'

  private trafficTimer: NodeJS.Timeout | null = null
  private tailTimer: NodeJS.Timeout | null = null
  private tailPos = 0
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
    private onTraffic: TrafficFn
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

  private log(level: LogEntry['level'], source: LogEntry['source'], message: string): void {
    if (!message) return
    this.onLog({ ts: Date.now(), level, source, message })
  }

  async start(p: StartParams): Promise<void> {
    // a previous xray (e.g. auto-restart path) must be gone before ports are re-bound
    await this.stopXray()
    this.intentionalStop = false
    this.restarts = 0
    this.lastParams = p
    this.mode = p.settings.proxyMode
    this.onState('connecting')

    if (!existsSync(this.exePath())) {
      this.onState('error', 'sing-box.exe не найден — запустите «npm run download:cores»')
      this.log('error', 'app', `sing-box.exe отсутствует в ${this.binDir}`)
      throw new Error('sing-box.exe missing')
    }
    if (!p.activeOutboundId || p.outbounds.length === 0) {
      this.onState('error', 'Не выбран сервер. Добавьте подписку и выберите ноду.')
      throw new Error('no active outbound')
    }
    const xrayNodes = p.outbounds.filter(isXrayHandled)
    if (xrayNodes.length > 0 && !existsSync(this.xrayExePath())) {
      this.onState('error', 'xray.exe не найден — переустановите приложение')
      this.log('error', 'app', `${XRAY_EXE} отсутствует в ${this.binDir}`)
      throw new Error('xray.exe missing')
    }

    await mkdir(this.runDir, { recursive: true })
    await rm(this.stopFile, { force: true }).catch(() => undefined)
    await rm(this.logPath, { force: true }).catch(() => undefined)

    this.ports.http = await findFreePort(p.settings.httpPort)
    this.ports.clashApi = await findFreePort(0)

    // one loopback SOCKS inbound per VLESS node, on random free ports
    const bridges: XrayBridge[] = []
    const taken = new Set([this.ports.http, this.ports.clashApi])
    for (const o of xrayNodes) {
      let port = await findFreePort(0)
      while (taken.has(port)) port = await findFreePort(0)
      taken.add(port)
      bridges.push({ outbound: o, port })
    }
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

    if (this.mode === 'tun') {
      await this.startElevated()
    } else {
      this.startChild()
      await enableSystemProxy(this.ports.http)
      this.log('info', 'app', `Системный прокси включён на 127.0.0.1:${this.ports.http}`)
    }

    this.startLogTail()
    this.startTrafficPolling()
    this.onState('connected')
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
      if (this.intentionalStop) return
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
    this.onState('error', `Не удалось запустить ядро Xray: ${reason}`)
    throw new Error('xray failed to start')
  }

  private async stopXray(): Promise<void> {
    const proc = this.xray
    if (!proc) return
    this.xray = null // the exit handler ignores a process we stop ourselves
    if (proc.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      proc.kill()
    })
  }

  /** System-proxy mode: normal child process with captured stdio. */
  private startChild(): void {
    const proc = spawn(this.exePath(), ['run', '-c', this.configPath], {
      cwd: this.binDir, // so wintun.dll / assets resolve next to the exe
      windowsHide: true
    })
    this.child = proc
    proc.stdout?.on('data', (d: Buffer) => this.log('info', 'singbox', d.toString().trimEnd()))
    proc.stderr?.on('data', (d: Buffer) => this.log('error', 'singbox', d.toString().trimEnd()))
    proc.on('exit', (code) => {
      this.log('warn', 'singbox', `sing-box завершился (code=${code})`)
      this.child = null
      this.maybeRestart()
    })
  }

  /**
   * TUN mode: launch an elevated PowerShell broker that starts sing-box and
   * watches the stop-file. Triggers a single UAC prompt; disconnect just
   * writes the stop-file (no second prompt).
   */
  private async startElevated(): Promise<void> {
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
      if (code !== 0 && !this.intentionalStop) {
        this.onState('error', 'Не удалось получить права администратора для TUN-режима')
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
      void this.stop()
      return
    }
    this.restarts++
    this.log('warn', 'app', `Авто-перезапуск ядра (${this.restarts}/${MAX_RESTARTS})`)
    const params = this.lastParams
    setTimeout(() => {
      if (!this.intentionalStop) void this.start(params)
    }, 1500)
  }

  /** Hot-reload after a rules/server change: quick restart of the core. */
  async reload(p: StartParams): Promise<void> {
    if (!this.child && this.mode !== 'tun') return
    this.log('info', 'app', 'Перезагрузка конфигурации правил…')
    await this.stop(true)
    await this.start(p)
  }

  async stop(keepIntent = false): Promise<void> {
    this.intentionalStop = true
    this.stopTrafficPolling()
    this.stopLogTail()

    if (this.mode === 'tun') {
      // signal the elevated broker to kill sing-box
      await writeFile(this.stopFile, '1', 'utf8').catch(() => undefined)
      // the broker deletes the stop-file once sing-box is gone
      for (let i = 0; i < 20 && existsSync(this.stopFile); i++) await sleep(150)
    } else {
      this.child?.kill()
      this.child = null
      await disableSystemProxy().catch(() => undefined)
    }
    // xray goes down after sing-box, so traffic never falls through to direct
    await this.stopXray()

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
        const level: LogEntry['level'] = /error|fatal/i.test(t)
          ? 'error'
          : /warn/i.test(t)
            ? 'warn'
            : 'info'
        this.log(level, 'singbox', t)
      }
    } catch {
      /* log file not created yet */
    }
  }

  // --- traffic via the clash API (/connections totals -> speed) -----------

  private startTrafficPolling(): void {
    this.stopTrafficPolling()
    this.trafficTimer = setInterval(() => void this.pollTraffic(), 1000)
  }
  private stopTrafficPolling(): void {
    if (this.trafficTimer) clearInterval(this.trafficTimer)
    this.trafficTimer = null
  }
  private async pollTraffic(): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.ports.clashApi}/connections`, {
        signal: AbortSignal.timeout(800)
      })
      if (!res.ok) return
      const json = (await res.json()) as { downloadTotal?: number; uploadTotal?: number }
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
    } catch {
      /* core not up yet / transient */
    }
  }
}
