import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../core/atomicFile'
import type { ZapretServiceId } from '@shared/zapret'
import { parseDpiState, type DpiBrokerError, type DpiBrokerState } from './dpiBroker'

// ---------------------------------------------------------------------------
// App side of the DPI broker protocol (dpiBroker.ts): writes
// <userRun>\dpi-lists.json + dpi-ctl.json, starts the «CipherWay DPI <SID>»
// task with `schtasks /run` (no UAC prompt), waits for <home>\dpi-state.json
// of this session. A new strategy / list = the next `gen`: the broker restarts
// winws with it. Every wait has a deadline.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface DpiRequest {
  strategy: string
  services: ZapretServiceId[]
  /** own domains (normalized) */
  hosts: string[]
  /** our VPN servers' addresses (IP / CIDR) */
  exclude: string[]
  /** the user's «Напрямую + zapret» IP rules (IP / CIDR, 0.7.2) */
  ips?: string[]
}

interface CtlFile {
  session: string
  pid: number
  cmd: 'run' | 'stop' | 'cleanup'
  gen: number
  ts: number
}

export class DpiStartError extends Error {
  constructor(
    public readonly code: DpiBrokerError | 'task' | 'timeout',
    message: string,
    public readonly detail?: string
  ) {
    super(message)
    this.name = 'DpiStartError'
  }
}

export interface DpiDaemonOpts {
  runDir: string
  /** <Root>\u\<SID> */
  home: string
  task: string
  /** tests: instead of `schtasks /run` */
  runTask?: () => Promise<{ code: number; out: string }>
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** ms; tests make them short */
  startTimeoutMs?: number
  applyTimeoutMs?: number
}

function schtasksRun(task: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'schtasks',
      ['/run', '/tn', task],
      { windowsHide: true, timeout: 15_000 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? -1
              : 0
        resolve({ code, out: `${stdout}${stderr}` })
      }
    )
  })
}

/** what the app-side ZapretService needs (mocked in its tests) */
export interface DpiDaemonLike {
  start(req: DpiRequest): Promise<DpiBrokerState>
  apply(req: DpiRequest): Promise<DpiBrokerState>
  stop(): Promise<void>
  running(): Promise<DpiBrokerState | null>
  cleanup(): Promise<void>
}

export class DpiDaemon implements DpiDaemonLike {
  private ctl: CtlFile | null = null

  constructor(private o: DpiDaemonOpts) {}

  get ctlPath(): string {
    return join(this.o.runDir, 'dpi-ctl.json')
  }
  get listsPath(): string {
    return join(this.o.runDir, 'dpi-lists.json')
  }
  get statePath(): string {
    return join(this.o.home, 'dpi-state.json')
  }

  async state(): Promise<DpiBrokerState | null> {
    const text = await readFile(this.statePath, 'utf8').catch(() => null)
    return text === null ? null : parseDpiState(text)
  }

  private mine = (st: DpiBrokerState | null): st is DpiBrokerState =>
    !!st && !!this.ctl && st.session === this.ctl.session

  private async waitState(
    ok: (s: DpiBrokerState) => boolean,
    ms: number
  ): Promise<DpiBrokerState | null> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const st = await this.state()
      if (this.mine(st) && ok(st)) return st
      await sleep(150)
    }
    return null
  }

  private async writeLists(gen: number, req: DpiRequest): Promise<void> {
    await writeAtomic(
      this.listsPath,
      JSON.stringify({
        gen,
        strategy: req.strategy,
        services: req.services,
        hosts: req.hosts,
        exclude: req.exclude,
        ips: req.ips ?? []
      })
    )
  }

  private async writeCtl(): Promise<void> {
    if (!this.ctl) return
    this.ctl.ts = Date.now()
    await writeAtomic(this.ctlPath, JSON.stringify(this.ctl))
  }

  private runTask(): Promise<{ code: number; out: string }> {
    return this.o.runTask?.() ?? schtasksRun(this.o.task)
  }

  /** Runs the task with a fresh request; resolves once the broker answered for this session. */
  private async launch(cmd: CtlFile['cmd'], req: DpiRequest | null): Promise<DpiBrokerState> {
    const prev = await this.state()
    this.ctl = {
      session: randomBytes(16).toString('hex'),
      pid: process.pid,
      cmd,
      gen: 1,
      ts: Date.now()
    }
    await mkdir(this.o.runDir, { recursive: true })
    if (req) await this.writeLists(1, req)
    await this.writeCtl()
    // a broker of an earlier session sees the new id and stops; give it a moment
    if (prev?.status === 'running' && Date.now() - (prev.ts ?? 0) < 6000) {
      const end = Date.now() + 7000
      while (Date.now() < end) {
        const st = await this.state()
        if (!st || st.status !== 'running' || Date.now() - (st.ts ?? 0) > 6000) break
        await sleep(150)
      }
    }
    const res = await this.runTask()
    if (res.code !== 0) {
      this.o.log('error', `schtasks /run (zapret): код ${res.code} ${res.out.trim()}`)
      throw new DpiStartError('task', 'Служба CipherWay не запустила zapret')
    }
    // one instance per task: a /run while the previous broker is exiting is ignored
    for (let i = 0; i < 2 && !(await this.waitState(() => true, 3000)); i++) await this.runTask()
    const st = await this.waitState((x) => x.status !== 'starting', this.o.startTimeoutMs ?? 30_000)
    if (!st) throw new DpiStartError('timeout', 'Служба CipherWay не ответила')
    return st
  }

  /** Starts winws with `req`; resolves once the broker runs (winws may wait for a network). */
  async start(req: DpiRequest): Promise<DpiBrokerState> {
    const st = await this.launch('run', req)
    if (st.status !== 'running') {
      this.ctl = null
      throw new DpiStartError(st.error || 'failed', st.detail || st.status || 'ошибка', st.detail)
    }
    return st
  }

  /** Another strategy / list: the broker restarts winws (no new task run while it lives). */
  async apply(req: DpiRequest): Promise<DpiBrokerState> {
    const cur = this.ctl ? await this.state() : null
    if (!this.ctl || !this.mine(cur) || cur.status !== 'running') return this.start(req)
    const gen = this.ctl.gen + 1
    await this.writeLists(gen, req)
    this.ctl.gen = gen
    await this.writeCtl()
    const st = await this.waitState(
      (x) => (x.gen ?? 0) >= gen || x.status !== 'running',
      this.o.applyTimeoutMs ?? 10_000
    )
    if (!st) throw new DpiStartError('timeout', 'Служба CipherWay не применила стратегию')
    if (st.status !== 'running') {
      this.ctl = null
      throw new DpiStartError(st.error || 'failed', st.detail || st.status || 'ошибка', st.detail)
    }
    return st
  }

  /** The broker of this session (null = none started). */
  async running(): Promise<DpiBrokerState | null> {
    if (!this.ctl) return null
    const st = await this.state()
    return this.mine(st) ? st : null
  }

  async stop(): Promise<void> {
    if (!this.ctl) return
    this.ctl = { ...this.ctl, cmd: 'stop' }
    await this.writeCtl().catch(() => undefined)
    const end = Date.now() + 6000
    while (Date.now() < end) {
      const st = await this.state()
      if (!this.mine(st) || st.status !== 'running' || Date.now() - (st.ts ?? 0) > 5000) break
      await sleep(150)
    }
    this.ctl = null
    await rm(this.ctlPath, { force: true }).catch(() => undefined)
  }

  /** A winws an earlier broker left behind (app crash): the broker stops just that one. */
  async cleanup(): Promise<void> {
    try {
      await this.launch('cleanup', null)
    } catch (err) {
      this.o.log('warn', `zapret: очистка не удалась — ${err instanceof Error ? err.message : err}`)
    } finally {
      this.ctl = null
      await rm(this.ctlPath, { force: true }).catch(() => undefined)
    }
  }
}
