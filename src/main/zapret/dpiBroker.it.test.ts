import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DPI_ALL, DPI_EXE } from '../core/coreNames'
import {
  CYGWIN_KEY_PS,
  dpiBrokerScript,
  NATIVE_PS,
  parseDpiState,
  PICK_IF_PS,
  type DpiHashes,
  type ForeignDpi
} from './dpiBroker'
import { DpiDaemon, DpiStartError, type DpiRequest } from './DpiDaemon'
import { SERVICE_DEFS } from './lists'

// The DPI broker for real, without elevation: a temp «ProgramData», a fake
// winws (a tiny C# exe that records its command line) and the real
// cipherway-dpi.exe in --dry-run mode (it verifies the command line the broker
// built and exits), the app side (DpiDaemon) talking to it through the files.
// The «app» is this test's own node.exe (process.execPath, our user's SID).
// What can't run here: the SYSTEM task itself, WinDivert and the ACL check of
// <Root>\dpi (both need admin; $CheckAcl is off with a test root).

const win = process.platform === 'win32'
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const REAL_BIN = resolve(__dirname, '../../../resources/bin')
const haveReal = win && DPI_ALL.every((f) => existsSync(join(REAL_BIN, f)))

const FAKE_WINWS_CS = `
using System; using System.IO; using System.Threading;
public static class P { public static int Main(string[] a) {
  File.WriteAllText(Path.Combine(Environment.CurrentDirectory, "fake-args.txt"), Environment.CommandLine);
  Console.WriteLine("windivert initialized. capture is started.");
  Thread.Sleep(120000);
  return 0; } }
`

const ps = (script: string): Promise<string> =>
  new Promise((res) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30_000 },
      (_e, out) => res(String(out).trim())
    )
  )

describe.skipIf(!win)('DPI broker (no elevation, fake winws / real winws --dry-run)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cw-dpi-it-'))
  // the owner of the «app» process (this node.exe) must be the broker's user
  const sid = win
    ? (/S-1-5-21(-\d+){3,6}/.exec(
        execFileSync(
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
          ['/user', '/fo', 'csv', '/nh'],
          { encoding: 'utf8' }
        )
      )?.[0] ?? '')
    : ''
  const fakeExe = join(tmp, 'fake.exe')
  const procs: ChildProcess[] = []
  const otherName = `cwfakedpi${randomBytes(3).toString('hex')}`
  const foreign: ForeignDpi = { processes: [otherName], services: ['CipherWayNoSuchService'] }
  // Cygwin's object directory: a non-elevated test winws needs its own user in the DACL
  const cygwinDirSddl = () => `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;${sid})`

  /** a «ProgramData\CipherWay» with dpi\bin and the user's home + run folders */
  function makeRoot(name: string, real: boolean) {
    const root = join(tmp, name, 'ProgramData', 'CipherWay')
    const bin = join(root, 'dpi', 'bin')
    const home = join(root, 'u', sid)
    const userRun = join(tmp, name, "пользователь O'Neil", 'run')
    for (const d of [bin, home, userRun]) mkdirSync(d, { recursive: true })
    for (const f of DPI_ALL) {
      if (real) copyFileSync(join(REAL_BIN, f), join(bin, f))
      else if (f === DPI_EXE) copyFileSync(fakeExe, join(bin, f))
      else writeFileSync(join(bin, f), `not really ${f}`)
    }
    const hashes = Object.fromEntries(DPI_ALL.map((f) => [f, sha(join(bin, f))])) as DpiHashes
    return { root, bin, home, userRun, hashes }
  }
  type Root = ReturnType<typeof makeRoot>
  let fake: Root

  beforeAll(() => {
    expect(sid).toMatch(/^S-1-5-21-/)
    const mk = join(tmp, 'mk.ps1')
    writeFileSync(join(tmp, 'fake.cs'), FAKE_WINWS_CS)
    writeFileSync(
      mk,
      `Add-Type -TypeDefinition ([IO.File]::ReadAllText($args[0])) -OutputAssembly $args[1] -OutputType ConsoleApplication`
    )
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', mk, join(tmp, 'fake.cs'), fakeExe],
      { windowsHide: true, timeout: 60_000 }
    )
    fake = makeRoot('fake', false)
  }, 90_000)

  afterEach(async () => {
    for (const p of procs.splice(0)) if (p.exitCode === null) p.kill()
    // only the copies under this test's temp folder: strategies.test.ts runs the
    // real cipherway-dpi.exe (--dry-run) from resources\bin at the same time
    const like = `${tmp.replace(/'/g, "''")}\\*`
    await ps(
      `Get-Process -Name '${DPI_EXE.replace(/\.exe$/, '')}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${like}' } | Stop-Process -Force -ErrorAction SilentlyContinue`
    )
    try {
      execFileSync('taskkill', ['/f', '/im', `${otherName}.exe`], { stdio: 'ignore' })
    } catch {
      /* none */
    }
    await sleep(300)
  })
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  function brokerFile(
    r: Root,
    extra: {
      hashes?: DpiHashes
      dryRun?: boolean
      appExe?: string
      userRunDir?: string
      tcpTsTest?: { netsh: string; stateFile: string }
    } = {}
  ): string {
    const file = join(r.home, 'dpi-broker.ps1')
    writeFileSync(
      file,
      '\ufeff' +
        dpiBrokerScript({
          sid,
          userRunDir: extra.userRunDir ?? r.userRun,
          appExe: extra.appExe ?? process.execPath,
          hashes: extra.hashes ?? r.hashes,
          rootOverride: r.root,
          foreign,
          dryRun: extra.dryRun,
          cygwinDirSddl: cygwinDirSddl(),
          ...(extra.tcpTsTest ? { tcpTsTest: extra.tcpTsTest } : {})
        })
    )
    return file
  }

  function daemon(
    r: Root,
    file = brokerFile(r),
    env: NodeJS.ProcessEnv = process.env,
    runDir = r.userRun
  ): DpiDaemon {
    let last: ChildProcess | null = null
    return new DpiDaemon({
      runDir,
      home: r.home,
      task: 'unused',
      log: () => undefined,
      startTimeoutMs: 20_000,
      // like the real task (MultipleInstancesPolicy IgnoreNew): a /run while this
      // daemon's broker still runs is ignored — DpiDaemon re-runs the task when the
      // first answer is slow (> 3 s under a loaded test run), and a second broker
      // of the same session would answer «refused» (the lock) over the first one
      runTask: async () => {
        if (last && last.exitCode === null) return { code: 0, out: '' }
        const p = spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
          { windowsHide: true, env }
        )
        last = p
        procs.push(p)
        return { code: 0, out: '' }
      }
    })
  }
  const state = (r: Root) => {
    try {
      return parseDpiState(readFileSync(join(r.home, 'dpi-state.json'), 'utf8'))
    } catch {
      return null
    }
  }
  const req = (over: Partial<DpiRequest> = {}): DpiRequest => ({
    strategy: 'fake-fakedsplit-ts',
    services: ['youtube'],
    hosts: ['example.org', 'xn--e1afmkfd.xn--p1ai'],
    exclude: ['203.0.113.7/32', '198.51.100.8', '2001:db8::7/128'],
    ...over
  })
  async function waitFile(path: string): Promise<string> {
    for (let i = 0; i < 50 && !existsSync(path); i++) await sleep(100)
    return readFileSync(path, 'utf8')
  }
  /** the broker run by hand with this request file (no DpiDaemon) */
  async function runRaw(r: Root, ctl: Record<string, unknown>, file = brokerFile(r)) {
    writeFileSync(join(r.userRun, 'dpi-ctl.json'), JSON.stringify(ctl))
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      windowsHide: true
    })
    procs.push(p)
    await new Promise((res) => p.once('exit', res))
    return state(r)
  }

  it('builds the command line itself: table + its own paths + the adapter; restarts on a new strategy; stops', async () => {
    const d = daemon(fake)
    const st = await d.start(req())
    expect(st.status).toBe('running')
    expect(st.strategy).toBe('fake-fakedsplit-ts')
    // the lists are lines of files the broker wrote, never arguments
    const hosts = readFileSync(join(fake.home, 'dpi', 'hosts.txt'), 'utf8').split('\n')
    expect(hosts).toContain('youtube.com')
    expect(hosts).toContain('googlevideo.com')
    expect(hosts).toContain('example.org')
    expect(hosts).toContain('xn--e1afmkfd.xn--p1ai')
    expect(hosts.join(' ')).not.toMatch(/discord/)
    const excl = readFileSync(join(fake.home, 'dpi', 'exclude.txt'), 'utf8').split('\n')
    expect(excl).toEqual(
      expect.arrayContaining(['10.0.0.0/8', '203.0.113.7/32', '198.51.100.8', '2001:db8::7/128'])
    )
    const voice = readFileSync(join(fake.home, 'dpi', 'discord-ips.txt'), 'utf8')
      .trim()
      .split('\n')
    expect(voice).toEqual([...SERVICE_DEFS.discord.cidrs])

    if (st.wait === 'no_network') return // a machine without a default route: nothing to start
    expect(st.dpiPid).toBeGreaterThan(0)
    expect(st.ifIdx).toBeGreaterThan(0)
    const cmd = await waitFile(join(fake.bin, 'fake-args.txt'))
    expect(cmd).toContain(`"--wf-iface=${st.ifIdx}"`)
    expect(cmd).toContain(`"--hostlist=${join(fake.home, 'dpi', 'hosts.txt')}"`)
    expect(cmd).toContain(`"--ipset-exclude=${join(fake.home, 'dpi', 'exclude.txt')}"`)
    expect(cmd).toContain(
      `"--dpi-desync-fake-tls=@${join(fake.bin, 'tls_clienthello_www_google_com.bin')}"`
    )
    expect(cmd).toContain('"--dpi-desync=fake,fakedsplit"')
    expect(cmd).not.toContain('discord')
    expect(cmd).not.toContain(fake.userRun)
    expect(cmd).not.toContain('example.org')

    // a new strategy + Discord: the next generation, winws restarted with it
    unlinkSync(join(fake.bin, 'fake-args.txt'))
    const st2 = await d.apply(req({ strategy: 'sniext', services: ['youtube', 'discord'] }))
    expect(st2.gen).toBe(2)
    expect(st2.strategy).toBe('sniext')
    expect(st2.dpiPid).not.toBe(st.dpiPid)
    const cmd2 = await waitFile(join(fake.bin, 'fake-args.txt'))
    expect(cmd2).toContain('"--dpi-desync-split-pos=2,sniext+1"')
    expect(cmd2).toContain('"--filter-l7=discord,stun"')
    // the voice profile acts on Discord's ranges only
    expect(cmd2).toContain(`"--ipset=${join(fake.home, 'dpi', 'discord-ips.txt')}"`)
    expect(readFileSync(join(fake.home, 'dpi', 'hosts.txt'), 'utf8')).toContain('discord.com')
    expect(() => process.kill(st.dpiPid!, 0)).toThrow()

    await d.stop()
    const end = state(fake)
    expect(end?.status).toBe('stopped')
    expect(end?.stopReason).toBe('команда остановки')
    await sleep(500)
    expect(() => process.kill(st2.dpiPid!, 0)).toThrow()
  }, 90_000)

  it("refuses a list it can't trust (quotes, a path, a newline at the end, a public suffix) — and never repeats it", async () => {
    for (const bad of [
      { hosts: ['example.org" --dpi-desync-fake-tls=@C:\\x'] },
      { hosts: ['EXAMPLE.org'] },
      { hosts: ['example.org\n'] },
      { hosts: ['com.ru'] },
      { hosts: ['github.io'] },
      { strategy: 'evil --x' },
      { strategy: 'sniext\n' },
      { strategy: 'no-such-strategy' },
      { exclude: ['10.0.0.0/8 --x'] },
      { exclude: ['10.0.0.1\n'] },
      { exclude: ['300.1.1.1'] },
      { ips: ['10.0.0.0/8 --x'] },
      { ips: ['198.51.100.0/24\n'] },
      { ips: ['300.1.1.1/32'] },
      // too wide for zapret (M1): IPv4 wider than /8, IPv6 wider than /32
      { ips: ['0.0.0.0/0'] },
      { ips: ['10.0.0.0/7'] },
      { ips: ['::/0'] },
      { ips: ['2001:db8::/31'] },
      // a Unicode digit is not a digit
      { ips: ['١٩٨.51.100.0/24'] },
      { ips: ['198.51.100.0/２４'] },
      { services: ['youtube', 'C:\\Windows'] as never },
      { services: ['youtube\n'] as never }
    ]) {
      const d = daemon(fake)
      let err: unknown = null
      await d.start(req(bad)).catch((e: unknown) => (err = e))
      expect(err, JSON.stringify(bad)).toBeInstanceOf(DpiStartError)
      expect((err as DpiStartError).code).toBe('bad_request')
      const st = state(fake)
      expect(st?.status).toBe('error')
      expect(st?.dpiPid).toBeFalsy()
      // the refused value is in no message
      const log = readFileSync(join(fake.home, 'dpi-broker.log'), 'utf8')
      for (const text of [st?.detail ?? '', log]) {
        expect(text).not.toMatch(/evil|EXAMPLE|C:\\\\Windows|no-such|300\.1|--x|github|com\.ru/)
      }
      await d.stop()
    }
  }, 180_000)

  it('IP rules (0.7.2): an ipset of their own, its profiles only then; the hostlist stays inert without domains', async () => {
    const d = daemon(fake)
    const st = await d.start(
      req({ services: [], hosts: [], ips: ['198.51.100.0/24', '2001:db8:1::/48'] })
    )
    expect(st.status).toBe('running')
    expect(st.wait).not.toBe('no_hosts')
    expect(readFileSync(join(fake.home, 'dpi', 'ips.txt'), 'utf8').trim().split('\n')).toEqual([
      '198.51.100.0/24',
      '2001:db8:1::/48'
    ])
    expect(readFileSync(join(fake.home, 'dpi', 'hosts.txt'), 'utf8').trim()).toBe(
      'none.cipherway.invalid'
    )
    if (st.wait !== 'no_network') {
      const cmd = await waitFile(join(fake.bin, 'fake-args.txt'))
      expect(cmd).toContain(`"--ipset=${join(fake.home, 'dpi', 'ips.txt')}"`)
      expect(cmd).not.toContain('198.51.100')
    }
    // without IP rules: no such profile
    if (existsSync(join(fake.bin, 'fake-args.txt'))) unlinkSync(join(fake.bin, 'fake-args.txt'))
    const st2 = await d.apply(req())
    if (st2.wait !== 'no_network') {
      const cmd = await waitFile(join(fake.bin, 'fake-args.txt'))
      expect(cmd).not.toContain('ips.txt')
    }
    await d.stop()
  }, 90_000)

  describe('TCP timestamps (0.7.2) — a fake netsh and a fake «Windows setting»', () => {
    /** a fake netsh: writes its value into the state file; `fail-<value>` next to it → exit 1 */
    function fakeTs(r: Root, initial: 'enabled' | 'disabled') {
      const dir = join(r.root, '..', 'ts')
      mkdirSync(dir, { recursive: true })
      const stateFile = join(dir, 'state.txt')
      const netsh = join(dir, 'netsh.cmd')
      writeFileSync(stateFile, initial)
      writeFileSync(
        netsh,
        `@echo off\r\nif exist "%~dp0fail-%6" exit /b 1\r\n>"${stateFile}" echo %6\r\nexit /b 0\r\n`
      )
      const marker = join(r.root, 'tmp', 'dpi-tcp-ts.txt')
      const now = (): string => readFileSync(stateFile, 'utf8').trim()
      return { dir, stateFile, netsh, marker, now, file: brokerFile(r, { tcpTsTest: { netsh, stateFile } }) }
    }

    it('off → on while zapret runs (the original in the marker), back off at the stop; on → untouched', async () => {
      const r = makeRoot('ts1', false)
      const f = fakeTs(r, 'disabled')
      const d = daemon(r, f.file)
      const st = await d.start(req())
      expect(st.status).toBe('running')
      expect(f.now()).toBe('enabled')
      expect(readFileSync(f.marker, 'utf8')).toBe('Disabled')
      expect(state(r)?.tcpTs).toBe('enabled')
      await d.stop()
      for (let i = 0; i < 50 && existsSync(f.marker); i++) await sleep(100)
      expect(f.now()).toBe('disabled')
      expect(existsSync(f.marker)).toBe(false)
      expect(readFileSync(join(r.home, 'dpi-broker.log'), 'utf8')).toMatch(/метки времени TCP выключены, как было/)

      // already on: nothing touched, no marker
      writeFileSync(f.stateFile, 'enabled')
      const d2 = daemon(r, f.file)
      await d2.start(req())
      expect(existsSync(f.marker)).toBe(false)
      await d2.stop()
      await sleep(800)
      expect(f.now()).toBe('enabled')
    }, 90_000)

    it('a failed return keeps the marker; the next broker without work (cleanup) puts it back', async () => {
      const r = makeRoot('ts2', false)
      const f = fakeTs(r, 'disabled')
      writeFileSync(join(f.dir, 'fail-disabled'), '')
      const d = daemon(r, f.file)
      await d.start(req())
      expect(f.now()).toBe('enabled')
      await d.stop()
      await sleep(1500)
      // netsh said «no»: still on, the marker stays
      expect(f.now()).toBe('enabled')
      expect(readFileSync(f.marker, 'utf8')).toBe('Disabled')
      expect(readFileSync(join(r.home, 'dpi-broker.log'), 'utf8')).toMatch(/не удалось вернуть/)
      // netsh works again: a cleanup run (no winws) restores — the lock is free
      unlinkSync(join(f.dir, 'fail-disabled'))
      await d.cleanup()
      for (let i = 0; i < 50 && existsSync(f.marker); i++) await sleep(100)
      expect(f.now()).toBe('disabled')
      expect(existsSync(f.marker)).toBe(false)
    }, 90_000)

    it('netsh failing to turn them on leaves nothing behind', async () => {
      const r = makeRoot('ts3', false)
      const f = fakeTs(r, 'disabled')
      writeFileSync(join(f.dir, 'fail-enabled'), '')
      const d = daemon(r, f.file)
      await d.start(req())
      expect(f.now()).toBe('disabled')
      expect(existsSync(f.marker)).toBe(false)
      expect(readFileSync(join(r.home, 'dpi-broker.log'), 'utf8')).toMatch(/не включились/)
      await d.stop()
    }, 90_000)
  })

  it('too many own domains are refused', async () => {
    const d = daemon(fake)
    const many = Array.from({ length: 201 }, (_, i) => `d${i}.example.org`)
    await expect(d.start(req({ hosts: many }))).rejects.toMatchObject({ code: 'bad_request' })
    await d.stop()
  }, 60_000)

  it('a session id ending in a newline is not a request', async () => {
    const st = await runRaw(fake, {
      session: `${'a'.repeat(32)}\n`,
      pid: process.pid,
      cmd: 'run',
      gen: 1,
      ts: Date.now()
    })
    expect(st).toMatchObject({ status: 'refused', error: 'no_request' })
  }, 60_000)

  it('the pid must be a process of the app (our exe, our user) — not any live process', async () => {
    // a live process of this user, but not the app's exe
    const other = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep 30'], {
      windowsHide: true
    })
    procs.push(other)
    await sleep(500)
    const st = await runRaw(fake, {
      session: 'b'.repeat(32),
      pid: other.pid,
      cmd: 'run',
      gen: 1,
      ts: Date.now()
    })
    expect(st).toMatchObject({ status: 'refused', error: 'no_request' })
    // a broker installed for another app exe refuses this node.exe too
    const d = daemon(fake, brokerFile(fake, { appExe: 'C:\\Program Files\\Other\\app.exe' }))
    await expect(d.start(req())).rejects.toMatchObject({ code: 'no_request' })
  }, 60_000)

  it('the user folder through a junction: refused; a junction higher up: the final path differs', async () => {
    const r = makeRoot('junction', false)
    // run\ itself a junction → the broker stops at once
    const target = join(tmp, 'junction-target')
    mkdirSync(target, { recursive: true })
    const link = join(tmp, 'junction', 'link-run')
    execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
    const p1 = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', brokerFile(r, { userRunDir: link })],
      { windowsHide: true }
    )
    procs.push(p1)
    await new Promise((res) => p1.once('exit', res))
    expect(state(r)).toMatchObject({ status: 'error', detail: 'папка приложения — ссылка' })
    // a junction in a parent folder: Is-Reparse of run\ says no, the handle says otherwise
    const realParent = join(tmp, 'junction', 'real-parent')
    mkdirSync(join(realParent, 'run'), { recursive: true })
    const parentLink = join(tmp, 'junction', 'parent-link')
    execFileSync('cmd', ['/c', 'mklink', '/J', parentLink, realParent], { stdio: 'ignore' })
    const run2 = join(parentLink, 'run')
    writeFileSync(
      join(run2, 'dpi-ctl.json'),
      JSON.stringify({
        session: 'c'.repeat(32),
        pid: process.pid,
        cmd: 'run',
        gen: 1,
        ts: Date.now()
      })
    )
    const file = brokerFile(r, { userRunDir: run2 })
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      windowsHide: true
    })
    procs.push(p)
    await new Promise((res) => p.once('exit', res))
    // the request is not read at all: no session, refused
    expect(state(r)).toMatchObject({ status: 'refused', error: 'no_request', session: '' })
  }, 90_000)

  it("a plain user's program called like another DPI bypass does not stop zapret (only admin ones count)", async () => {
    const other = join(tmp, `${otherName}.exe`)
    copyFileSync(fakeExe, other)
    const p = spawn(other, [], { windowsHide: true, cwd: tmp })
    procs.push(p)
    await sleep(500)
    const d = daemon(fake)
    const st = await d.start(req())
    expect(st.status).toBe('running')
    await d.stop()
  }, 60_000)

  it('one winws per computer: a broker that finds the lock in <Root>\\tmp taken is refused', async () => {
    // A runs (no lists = no winws, nothing for B to take for an orphan) and holds the lock
    const a = daemon(fake)
    const st = await a.start(req({ services: [], hosts: [] }))
    expect(st.status).toBe('running')
    expect(st.wait).toBe('no_hosts')
    // B: another app instance on the same computer
    const run2 = join(tmp, 'fake', 'second-run')
    mkdirSync(run2, { recursive: true })
    const b = daemon(fake, brokerFile(fake, { userRunDir: run2 }), process.env, run2)
    // A and B share one state file here (same user's home): A's next Save-State may
    // replace B's answer before B's daemon reads it — the broker's journal is the proof
    const err = await b.start(req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DpiStartError)
    expect(['dpi_busy', 'timeout']).toContain((err as DpiStartError).code)
    expect(readFileSync(join(fake.home, 'dpi-broker.log'), 'utf8')).toContain(
      'не запускаем: zapret CipherWay уже работает у другого пользователя Windows'
    )
    expect(state(fake)?.status).not.toBe('error')
    await a.stop()
  }, 90_000)

  it("an orphan of this user is killed first; one without this user's hostlist never", async () => {
    // our exe with this user's hostlist: what a broker of an earlier run started
    const orphan = spawn(
      join(fake.bin, DPI_EXE),
      // quoted the way the broker passes it (Build-Args)
      [`"--hostlist=${join(fake.home, 'dpi', 'hosts.txt')}"`],
      { windowsHide: true, cwd: fake.bin, windowsVerbatimArguments: true }
    )
    procs.push(orphan)
    await sleep(500)
    writeFileSync(join(fake.home, 'dpi-state.json'), JSON.stringify({ dpiPid: orphan.pid }))
    const d = daemon(fake)
    const st = await d.start(req())
    expect(st.status).toBe('running')
    await new Promise((r) => setTimeout(r, 300))
    expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true)
    expect(readFileSync(join(fake.home, 'dpi-broker.log'), 'utf8')).toContain(
      `остановлен zapret прошлого запуска, pid ${orphan.pid}`
    )
    await d.stop()
    // our exe without the hostlist: left alone (a pid may be reused)
    const stray = spawn(join(fake.bin, DPI_EXE), ['--something-else'], {
      windowsHide: true,
      cwd: fake.bin
    })
    procs.push(stray)
    await sleep(500)
    writeFileSync(join(fake.home, 'dpi-state.json'), JSON.stringify({ dpiPid: stray.pid }))
    const d2 = daemon(fake)
    expect((await d2.start(req())).status).toBe('running')
    expect(stray.exitCode).toBeNull()
    expect(() => process.kill(stray.pid!, 0)).not.toThrow()
    await d2.stop()
  }, 90_000)

  it("Cygwin's object directory taken by somebody else: refused, zapret not started", async () => {
    const r = makeRoot('cygsquat', false)
    // a plain user creates \BaseNamedObjects\cygwin1S5-<key of OUR cygwin1.dll> first
    const dll = join(r.bin, 'cygwin1.dll')
    const squat = join(tmp, 'squat.ps1')
    writeFileSync(
      squat,
      // BOM: Windows PowerShell 5.1 reads a BOM-less script as ANSI (Cyrillic texts)
      `\ufeff$ErrorActionPreference = 'Stop'\n${NATIVE_PS}\n${CYGWIN_KEY_PS}\n$n = 'cygwin1S5-' + (Cygwin-Key $args[0])\n$h = Object-Dir $n 'D:P(A;;GA;;;WD)'\n[Console]::Out.WriteLine($n + ' ' + $h.status)\n[Console]::Out.Flush()\nStart-Sleep -Seconds 40`
    )
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', squat, dll],
      {
        windowsHide: true
      }
    )
    procs.push(p)
    const line = await new Promise<string>((res) =>
      p.stdout.once('data', (b: Buffer) => res(String(b)))
    )
    // the name the broker computes = the one Cygwin uses (cygwinKey, checked against cygwin1.dll 3.4.10)
    expect(line.trim()).toMatch(/^cygwin1S5-[0-9a-f]{16} 00000000$/)
    const d = daemon(r)
    const err = await d.start(req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DpiStartError)
    expect((err as DpiStartError).code).toBe('foreign_dpi')
    expect(state(r)?.detail).toBe('служебные объекты Cygwin заняты другой программой')
    p.kill()
  }, 60_000)

  it('numbers out of range (1e30) are refused without being quoted anywhere', async () => {
    const r = makeRoot('numbers', false)
    const st = await runRaw(r, {
      session: 'd'.repeat(32),
      pid: process.pid,
      cmd: 'run',
      gen: 1,
      ts: 1e30
    })
    expect(st).toMatchObject({ status: 'refused', error: 'no_request' })
    const st2 = await runRaw(r, {
      session: 'e'.repeat(32),
      pid: process.pid,
      cmd: 'run',
      gen: 1e30,
      ts: Date.now()
    })
    expect(st2).toMatchObject({ status: 'error', error: 'bad_request', detail: 'нет списков' })
    const log = existsSync(join(r.home, 'dpi-broker.log'))
      ? readFileSync(join(r.home, 'dpi-broker.log'), 'utf8')
      : ''
    for (const t of [JSON.stringify(st), JSON.stringify(st2), log])
      expect(t).not.toMatch(/e\+?30|E\+?30/)
    const st3 = await runRaw(r, {
      session: 'f'.repeat(32),
      pid: 1e30,
      cmd: 'run',
      gen: 1,
      ts: Date.now()
    })
    expect(st3).toMatchObject({ status: 'refused', error: 'no_request' })
  }, 60_000)

  it("an etc / tmp in Cygwin's root, or a changed file: zapret is never started", async () => {
    const r = makeRoot('cygroot', false)
    mkdirSync(join(r.root, 'dpi', 'etc'))
    const d = daemon(r)
    await expect(d.start(req())).rejects.toBeInstanceOf(DpiStartError)
    expect(state(r)?.detail).toContain('посторонняя папка в корне Cygwin: etc')
    rmSync(join(r.root, 'dpi', 'etc'), { recursive: true })
    const hashes = { ...r.hashes, 'WinDivert.dll': 'a'.repeat(64) }
    const d2 = daemon(r, brokerFile(r, { hashes }))
    await expect(d2.start(req())).rejects.toBeInstanceOf(DpiStartError)
    expect(state(r)?.detail).toContain('файл zapret изменён')
  }, 60_000)

  it('refuses without a fresh request', async () => {
    const st = await runRaw(fake, {
      session: 'a'.repeat(32),
      pid: process.pid,
      cmd: 'run',
      gen: 1,
      ts: Date.now() - 10 * 60_000
    })
    expect(st).toMatchObject({ status: 'refused', error: 'no_request' })
  }, 60_000)

  it('the adapter: an on-link (PPPoE) default route counts, our TUN / LAN never', async () => {
    const route = (alias: string, idx: number, hop: string, rm: number, im: number): string =>
      `[pscustomobject]@{ InterfaceAlias = '${alias}'; ifIndex = ${idx}; NextHop = '${hop}'; RouteMetric = ${rm}; InterfaceMetric = ${im} }`
    const run = (routes: string[]): Promise<string> =>
      ps(
        `$TunNames = @('CipherWay', 'CipherWay LAN')\n${PICK_IF_PS}\n$x = Pick-If @(${routes.join(', ')}); if ($x) { '' + $x.idx + '|' + $x.name } else { 'none' }`
      )
    // PPPoE (on-link, 0.0.0.0) next to our TUN with a better metric
    expect(
      await run([
        route('CipherWay', 40, '0.0.0.0', 0, 0),
        route('PPPoE Rostelecom', 23, '0.0.0.0', 0, 10),
        route('Ethernet', 17, '192.168.5.1', 0, 25)
      ])
    ).toBe('23|PPPoE Rostelecom')
    // a router: its gateway; LAN's adapter skipped
    expect(
      await run([
        route('CipherWay LAN', 50, '0.0.0.0', 0, 1),
        route('Wi-Fi', 9, '192.168.1.1', 0, 35)
      ])
    ).toBe('9|Wi-Fi')
    expect(await run([route('CipherWay', 40, '0.0.0.0', 0, 0)])).toBe('none')
  }, 60_000)

  it.skipIf(!haveReal)(
    'the official winws accepts the command line the broker built (--dry-run)',
    async () => {
      const real = makeRoot('real', true)
      const d = daemon(real, brokerFile(real, { dryRun: true }), {
        ...process.env,
        __COMPAT_LAYER: 'RunAsInvoker'
      })
      const st = await d.start(
        req({
          services: ['youtube', 'discord'],
          strategy: 'fake-multisplit-ts',
          ips: ['198.51.100.0/24']
        })
      )
      if (st.wait === 'no_network') return
      let end = state(real)
      for (let i = 0; i < 100 && end?.exitCode !== 0 && end?.wait !== 'exited'; i++) {
        await sleep(100)
        end = state(real)
      }
      expect(end?.exitCode).toBe(0)
      expect(end?.output).toMatch(/command line parameters verified/)
      await d.stop()
    },
    90_000
  )
})
