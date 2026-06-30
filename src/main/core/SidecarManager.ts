import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, rm, writeFile, stat } from 'node:fs/promises'
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

/**
 * Drives a single sing-box core.
 *  - System Proxy mode: sing-box spawned as a normal child (full stdio), the
 *    WinInet registry proxy points at its mixed inbound.
 *  - TUN mode: sing-box needs admin. We launch it through an elevated broker
 *    (one UAC prompt on connect). The broker watches a stop-file so we can
 *    terminate it later without a second prompt. Logs come from the log file.
 */
export class SidecarManager {
  private child: ChildProcess | null = null // system-proxy mode child
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
  private get configPath(): string {
    return join(this.runDir, 'config.json')
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

    await mkdir(this.runDir, { recursive: true })
    await rm(this.stopFile, { force: true }).catch(() => undefined)
    await rm(this.logPath, { force: true }).catch(() => undefined)

    this.ports.http = await findFreePort(p.settings.httpPort)
    this.ports.clashApi = await findFreePort(0)

    const cfg = generateSingboxConfig({
      outbounds: p.outbounds,
      activeOutboundId: p.activeOutboundId,
      rules: p.rules,
      settings: p.settings,
      socksPort: p.settings.socksPort,
      httpPort: this.ports.http,
      clashApiPort: this.ports.clashApi,
      logFile: this.logPath,
      cacheFile: join(this.runDir, 'cache.db')
    })
    await writeFile(this.configPath, JSON.stringify(cfg, null, 2), 'utf8')

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
    } else {
      this.child?.kill()
      this.child = null
      await disableSystemProxy().catch(() => undefined)
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
