import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TunServiceInfo } from '@shared/types'
import { brokerScript, psQuote } from './broker'
import {
  elevateCommand,
  installScript,
  isValidSid,
  serviceBrokerScript,
  taskName,
  uninstallScript,
  type BrokerHashes
} from './serviceScripts'
import { writeAtomic } from './atomicFile'

// ---------------------------------------------------------------------------
// TUN needs admin rights. Two ways to get them (see serviceScripts.ts):
//  * ServiceLauncher — the «Служба TUN» task (SYSTEM), started without UAC;
//  * LegacyLauncher — the 0.4.1 way, an elevated broker per connect (UAC
//    every time). Used when the service is switched off or can't be set up.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface TunLauncher {
  readonly kind: 'service' | 'legacy'
  /** folder the core reads the slot rule-sets from */
  readonly coreRuleDir: string
  /** sing-box log file the app tails */
  readonly coreLogPath: string
  /** starts the core; resolves once it was launched (not yet ready) */
  launch(): Promise<void>
  /** a fresh core (the retry after a slow wintun start), no new UAC prompt */
  restartCore(): Promise<void>
  /** the rule files in the user's rules folder changed */
  syncRules(): Promise<void>
  /** the core exited on its own */
  exited(): Promise<boolean>
  /** launching failed for good (UAC refused, service refused) — readable reason */
  failure(): string | null
  stop(): Promise<void>
}

export interface LauncherPaths {
  binDir: string
  runDir: string
  configPath: string
  rulesDir: string
  logPath: string
}

function run(
  cmd: string,
  args: string[],
  timeout = 30_000
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code as number)
          : err
            ? -1
            : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

// --- legacy: elevated broker per connect ----------------------------------

export class LegacyLauncher implements TunLauncher {
  readonly kind = 'legacy' as const
  private elevation: 'pending' | 'ok' | 'failed' = 'pending'

  constructor(
    private p: LauncherPaths,
    private log: (level: 'info' | 'warn' | 'error', msg: string) => void,
    private isCancelled: () => boolean
  ) {}

  get coreRuleDir(): string {
    return this.p.rulesDir
  }
  get coreLogPath(): string {
    return this.p.logPath
  }
  private get stopFile(): string {
    return join(this.p.runDir, 'stop.signal')
  }
  private get restartFile(): string {
    return join(this.p.runDir, 'restart.signal')
  }
  private get exitFile(): string {
    return join(this.p.runDir, 'core.exit')
  }

  async launch(): Promise<void> {
    for (const f of [this.stopFile, this.restartFile, this.exitFile]) {
      await rm(f, { force: true }).catch(() => undefined)
    }
    this.elevation = 'pending'
    const brokerPath = join(this.p.runDir, 'broker.ps1')
    const script = brokerScript({
      exe: join(this.p.binDir, 'sing-box.exe'),
      config: this.p.configPath,
      workDir: this.p.binDir,
      stopFile: this.stopFile,
      restartFile: this.restartFile,
      exitFile: this.exitFile,
      parentPid: process.pid
    })
    // BOM: Windows PowerShell 5.1 reads BOM-less scripts as ANSI (Cyrillic user names)
    await writeFile(brokerPath, `\ufeff${script}`, 'utf8')
    const launchCmd = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(`"${brokerPath}"`)})`
    const launcher = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', launchCmd],
      {
        windowsHide: true
      }
    )
    launcher.on('exit', (code) => {
      // code 0 = UAC accepted & broker launched; non-zero/null = likely denied
      this.elevation = code === 0 ? 'ok' : 'failed'
      if (code !== 0 && !this.isCancelled()) {
        this.log('error', `UAC отклонён или ошибка запуска (code=${code})`)
      }
    })
    this.log('info', 'Запуск sing-box в режиме TUN (запрошены права администратора)')
  }

  failure(): string | null {
    return this.elevation === 'failed'
      ? 'Не удалось получить права администратора для режима TUN'
      : null
  }

  async exited(): Promise<boolean> {
    return existsSync(this.exitFile)
  }

  async restartCore(): Promise<void> {
    await writeFile(this.restartFile, '1', 'utf8')
    // the broker removes the signal once the new sing-box is launched
    for (let i = 0; i < 40 && existsSync(this.restartFile); i++) await sleep(200)
    if (existsSync(this.restartFile)) {
      await rm(this.restartFile, { force: true }).catch(() => undefined)
      throw new Error('Служебный процесс TUN не отвечает — попробуйте подключиться ещё раз')
    }
  }

  async syncRules(): Promise<void> {
    /* the elevated core reads the user's rules folder directly */
  }

  async stop(): Promise<void> {
    await writeFile(this.stopFile, '1', 'utf8').catch(() => undefined)
    // the broker deletes the stop-file once sing-box is gone
    for (let i = 0; i < 20 && existsSync(this.stopFile); i++) await sleep(150)
    await rm(this.exitFile, { force: true }).catch(() => undefined)
  }
}

// --- the «Служба TUN» task -------------------------------------------------

interface BrokerState {
  session?: string
  status?: 'starting' | 'running' | 'stopped' | 'refused' | 'error'
  restart?: number
  rules?: number
  exitCode?: number | null
  error?: string
  ts?: number
}

interface Ctl {
  session: string
  pid: number
  cmd: 'run' | 'stop'
  restart: number
  rules: number
  ts: number
}

const hashCache = new Map<string, { key: string; hash: string }>()

/** sha256 of a file, cached by size + mtime (sing-box.exe is ~40 MB). */
export async function fileSha256(path: string): Promise<string> {
  const st = await stat(path)
  const key = `${st.size}:${st.mtimeMs}`
  const c = hashCache.get(path)
  if (c?.key === key) return c.hash
  const hash = await new Promise<string>((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
  hashCache.set(path, { key, hash })
  return hash
}

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

export interface TunServiceOpts {
  binDir: string
  runDir: string
  appVersion: string
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** tests: %ProgramData%\CipherWay replacement */
  rootOverride?: string
}

/** Install / status / removal of the «Служба TUN» task. */
export class TunService {
  private sidCache: string | null = null

  constructor(private o: TunServiceOpts) {}

  get root(): string {
    return this.o.rootOverride ?? join(process.env.ProgramData || 'C:\\ProgramData', 'CipherWay')
  }

  async sid(): Promise<string> {
    if (this.sidCache) return this.sidCache
    const { out } = await run('whoami', ['/user', '/fo', 'csv', '/nh'], 10_000)
    const sid = /S-1-5-21(-\d+){3,6}/.exec(out)?.[0]
    if (!sid || !isValidSid(sid)) throw new Error('Не удалось определить пользователя Windows')
    this.sidCache = sid
    return sid
  }

  homeDir(sid: string): string {
    return join(this.root, 'u', sid)
  }

  private async hashes(): Promise<BrokerHashes> {
    return {
      'sing-box.exe': await fileSha256(join(this.o.binDir, 'sing-box.exe')),
      'wintun.dll': await fileSha256(join(this.o.binDir, 'wintun.dll'))
    }
  }

  async brokerText(sid: string): Promise<string> {
    return serviceBrokerScript({
      sid,
      userRunDir: this.o.runDir,
      hashes: await this.hashes(),
      rootOverride: this.o.rootOverride
    })
  }

  async status(): Promise<TunServiceInfo> {
    try {
      const sid = await this.sid()
      const manifest = await readFile(join(this.homeDir(sid), 'manifest.json'), 'utf8')
        .then(
          (t) => JSON.parse(t.replace(/^\ufeff/, '')) as { broker?: string; files?: BrokerHashes }
        )
        .catch(() => null)
      const task = (await run('schtasks', ['/query', '/tn', taskName(sid)], 10_000)).code === 0
      if (!manifest || !task) return { state: 'missing' }
      const want = await this.hashes()
      const broker = sha256(await this.brokerText(sid))
      const same =
        manifest.broker === broker &&
        manifest.files?.['sing-box.exe'] === want['sing-box.exe'] &&
        manifest.files?.['wintun.dll'] === want['wintun.dll']
      return { state: same ? 'ok' : 'outdated' }
    } catch (err) {
      return { state: 'missing', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Runs `script` elevated (one UAC prompt). */
  private async elevated(name: string, script: string): Promise<'ok' | 'cancelled' | 'failed'> {
    const path = join(this.o.runDir, `${name}-${randomBytes(4).toString('hex')}.ps1`)
    await writeFile(path, `\ufeff${script}`, 'utf8')
    try {
      const { code } = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', elevateCommand(path)],
        10 * 60_000
      )
      return code === 0 ? 'ok' : code === 1223 ? 'cancelled' : 'failed'
    } finally {
      await rm(path, { force: true }).catch(() => undefined)
    }
  }

  async install(): Promise<'ok' | 'cancelled' | 'failed'> {
    const sid = await this.sid()
    const brokerText = await this.brokerText(sid)
    this.o.log('info', 'Установка службы TUN (один запрос прав администратора)')
    const res = await this.elevated(
      'tun-install',
      installScript({
        sid,
        srcBinDir: this.o.binDir,
        brokerText,
        hashes: await this.hashes(),
        brokerHash: sha256(brokerText),
        appVersion: this.o.appVersion
      })
    )
    if (res === 'failed') {
      const why = await readFile(join(this.homeDir(sid), 'install-error.txt'), 'utf8').catch(
        () => ''
      )
      this.o.log('error', `Служба TUN не установлена${why ? `: ${why.trim()}` : ''}`)
    } else if (res === 'ok') {
      this.o.log('info', 'Служба TUN установлена')
    }
    return res
  }

  async remove(): Promise<'ok' | 'cancelled' | 'failed'> {
    const sid = await this.sid()
    const res = await this.elevated('tun-remove', uninstallScript(sid))
    if (res === 'ok') this.o.log('info', 'Служба TUN удалена')
    return res
  }

  launcher(p: LauncherPaths, isCancelled: () => boolean): Promise<ServiceLauncher> {
    return this.sid().then(
      (sid) =>
        new ServiceLauncher(p, {
          home: this.homeDir(sid),
          task: taskName(sid),
          log: this.o.log,
          isCancelled
        })
    )
  }
}

/** Service broker protocol, app side (see serviceScripts.ts). */
export class ServiceLauncher implements TunLauncher {
  readonly kind = 'service' as const
  private ctl: Ctl | null = null
  private reason: string | null = null

  constructor(
    private p: LauncherPaths,
    private s: {
      home: string
      task: string
      log: (level: 'info' | 'warn' | 'error', msg: string) => void
      isCancelled: () => boolean
    }
  ) {}

  get coreRuleDir(): string {
    return join(this.s.home, 'rules')
  }
  get coreLogPath(): string {
    return join(this.s.home, 'sing-box.log')
  }
  private get ctlPath(): string {
    return join(this.p.runDir, 'tun-ctl.json')
  }
  private get statePath(): string {
    return join(this.s.home, 'state.json')
  }

  private async state(): Promise<BrokerState | null> {
    try {
      return JSON.parse(
        (await readFile(this.statePath, 'utf8')).replace(/^\ufeff/, '')
      ) as BrokerState
    } catch {
      return null
    }
  }

  private async writeCtl(): Promise<void> {
    if (!this.ctl) return
    this.ctl.ts = Date.now()
    await writeAtomic(this.ctlPath, JSON.stringify(this.ctl))
  }

  private async waitState(
    ok: (s: BrokerState) => boolean,
    ms: number
  ): Promise<BrokerState | null> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const st = await this.state()
      if (st && ok(st)) return st
      if (this.s.isCancelled()) return null
      await sleep(150)
    }
    return null
  }

  private mine = (st: BrokerState): boolean => st.session === this.ctl?.session

  async launch(): Promise<void> {
    // a broker of an earlier session that is still alive sees the new
    // session id in tun-ctl.json and stops; give it a moment
    const prev = await this.state()
    this.ctl = {
      session: randomBytes(16).toString('hex'),
      pid: process.pid,
      cmd: 'run',
      restart: 0,
      rules: 0,
      ts: Date.now()
    }
    await this.writeCtl()
    if (prev?.status === 'running' && Date.now() - (prev.ts ?? 0) < 6000) {
      await this.waitState(
        (st) => st.status !== 'running' || Date.now() - (st.ts ?? 0) > 6000,
        7000
      )
    }
    const res = await run('schtasks', ['/run', '/tn', this.s.task], 15_000)
    if (res.code !== 0) {
      this.reason = 'Служба TUN не запустилась — удалите её в Настройках и подключитесь снова'
      this.s.log('error', `schtasks /run: код ${res.code} ${res.out.trim()}`)
      return
    }
    this.s.log('info', 'Запуск sing-box в режиме TUN через службу CipherWay (без запроса прав)')
    const st = await this.waitState((x) => this.mine(x) && x.status !== 'starting', 20_000)
    if (this.s.isCancelled()) return
    if (!st) this.reason = 'Служба TUN не ответила'
    else if (st.status !== 'running') {
      this.reason = `Служба TUN отказалась запускать ядро: ${st.error || st.status}`
    }
  }

  failure(): string | null {
    return this.reason
  }

  async exited(): Promise<boolean> {
    const st = await this.state()
    if (!st || !this.mine(st)) return false
    if (st.status === 'error' || st.status === 'stopped') return true
    return st.restart === this.ctl?.restart && typeof st.exitCode === 'number'
  }

  async restartCore(): Promise<void> {
    if (!this.ctl) return
    this.ctl.restart++
    const n = this.ctl.restart
    await this.writeCtl()
    const st = await this.waitState((x) => this.mine(x) && (x.restart ?? 0) >= n, 15_000)
    if (!st || st.status !== 'running') {
      throw new Error('Служебный процесс TUN не отвечает — попробуйте подключиться ещё раз')
    }
  }

  async syncRules(): Promise<void> {
    if (!this.ctl) return
    this.ctl.rules++
    const n = this.ctl.rules
    await this.writeCtl()
    const st = await this.waitState((x) => this.mine(x) && (x.rules ?? 0) >= n, 6000)
    if (!st) this.s.log('warn', 'Служба TUN не подтвердила новые правила')
  }

  async stop(): Promise<void> {
    if (!this.ctl) return
    this.ctl.cmd = 'stop'
    await this.writeCtl().catch(() => undefined)
    const end = Date.now() + 6000
    while (Date.now() < end) {
      const st = await this.state()
      if (!st || !this.mine(st) || st.status !== 'running' || Date.now() - (st.ts ?? 0) > 5000)
        break
      await sleep(150)
    }
    this.ctl = null
    await rm(this.ctlPath, { force: true }).catch(() => undefined)
  }
}
