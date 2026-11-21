import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../core/atomicFile'
import { parseLanState, type LanBrokerError, type LanBrokerState } from './lanBroker'

// ---------------------------------------------------------------------------
// App side of the LAN broker protocol (see lanBroker.ts): writes
// <userRun>\lan-ctl.json, starts the «CipherWay LAN <SID>» task with
// `schtasks /run` (no UAC prompt), waits for <home>\lan-state.json of this
// session; tails <home>\lan.log (the daemon's own log) for «Логи».
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface LanCtlFile {
  session: string
  pid: number
  cmd: 'run' | 'stop'
  ts: number
}

export class LanStartError extends Error {
  constructor(
    public readonly code: LanBrokerError | 'task' | 'timeout',
    message: string,
    public readonly detail?: string
  ) {
    super(message)
    this.name = 'LanStartError'
  }
}

export interface LanDaemonOpts {
  /** the app's run folder (lan-ctl.json) */
  runDir: string
  /** <Root>\u\<SID> */
  home: string
  task: string
  /** tests: instead of `schtasks /run` */
  runTask?: () => Promise<{ code: number; out: string }>
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
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

export class LanDaemon {
  private ctl: LanCtlFile | null = null
  private logPos = 0
  private logSize = -1
  private partial = ''

  constructor(private o: LanDaemonOpts) {}

  get ctlPath(): string {
    return join(this.o.runDir, 'lan-ctl.json')
  }
  get statePath(): string {
    return join(this.o.home, 'lan-state.json')
  }
  get logPath(): string {
    return join(this.o.home, 'lan.log')
  }
  get session(): string | null {
    return this.ctl?.session ?? null
  }

  async state(): Promise<LanBrokerState | null> {
    const text = await readFile(this.statePath, 'utf8').catch(() => null)
    return text === null ? null : parseLanState(text)
  }

  private mine = (st: LanBrokerState | null): st is LanBrokerState =>
    !!st && !!this.ctl && st.session === this.ctl.session

  private async waitState(
    ok: (s: LanBrokerState) => boolean,
    ms: number
  ): Promise<LanBrokerState | null> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const st = await this.state()
      if (this.mine(st) && ok(st)) return st
      await sleep(200)
    }
    return null
  }

  /** Starts the daemon (resolves once the broker reports it running). */
  async start(): Promise<void> {
    const prev = await this.state()
    this.ctl = {
      session: randomBytes(16).toString('hex'),
      pid: process.pid,
      cmd: 'run',
      ts: Date.now()
    }
    await mkdir(this.o.runDir, { recursive: true })
    await writeAtomic(this.ctlPath, JSON.stringify(this.ctl))
    // a broker of an earlier session sees the new id and stops; give it a moment
    if (prev?.status === 'running' && Date.now() - (prev.ts ?? 0) < 6000) {
      const end = Date.now() + 6000
      while (Date.now() < end) {
        const st = await this.state()
        if (!st || st.status !== 'running' || Date.now() - (st.ts ?? 0) > 5000) break
        await sleep(200)
      }
    }
    const runTask = (): Promise<{ code: number; out: string }> =>
      this.o.runTask?.() ?? schtasksRun(this.o.task)
    const res = await runTask()
    if (res.code !== 0) {
      this.o.log('error', `schtasks /run (LAN): код ${res.code} ${res.out.trim()}`)
      throw new LanStartError('task', 'Служба CipherWay не запустила LAN')
    }
    // one instance per task: a /run while the previous broker is exiting is ignored
    for (let i = 0; i < 2 && !(await this.waitState(() => true, 3000)); i++) await runTask()
    const st = await this.waitState((x) => x.status !== 'starting', 20_000)
    if (!st) throw new LanStartError('timeout', 'Служба CipherWay не ответила')
    if (st.status !== 'running') {
      throw new LanStartError(st.error || 'failed', st.detail || st.status || 'ошибка', st.detail)
    }
    this.logPos = 0
    this.logSize = -1
    this.partial = ''
  }

  /** The broker of this session still runs the daemon (null = no session). */
  async running(): Promise<LanBrokerState | null> {
    if (!this.ctl) return null
    return this.state()
  }

  isMine(st: LanBrokerState | null): boolean {
    return this.mine(st)
  }

  async stop(): Promise<void> {
    if (!this.ctl) return
    this.ctl = { ...this.ctl, cmd: 'stop', ts: Date.now() }
    await writeAtomic(this.ctlPath, JSON.stringify(this.ctl)).catch(() => undefined)
    const end = Date.now() + 6000
    while (Date.now() < end) {
      const st = await this.state()
      if (!this.mine(st) || st.status !== 'running' || Date.now() - (st.ts ?? 0) > 5000) break
      await sleep(150)
    }
    this.ctl = null
    await rm(this.ctlPath, { force: true }).catch(() => undefined)
  }

  /** New complete lines of the daemon's log since the last call. */
  async readLog(maxBytes = 256 * 1024): Promise<string[]> {
    let size: number
    try {
      size = (await stat(this.logPath)).size
    } catch {
      return []
    }
    // a new file (rotated at the daemon's start) or truncated
    if (size < this.logPos || (this.logSize >= 0 && size < this.logSize)) {
      this.logPos = 0
      this.partial = ''
    }
    this.logSize = size
    if (size <= this.logPos) return []
    const start = Math.max(this.logPos, size - maxBytes)
    const fh = await open(this.logPath, 'r').catch(() => null)
    if (!fh) return []
    try {
      const buf = Buffer.alloc(size - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      this.logPos = start + bytesRead
      const text = this.partial + buf.subarray(0, bytesRead).toString('utf8')
      const lines = text.split(/\r?\n/)
      this.partial = lines.pop() ?? ''
      return lines.filter((l) => l.trim() !== '')
    } finally {
      await fh.close()
    }
  }
}
