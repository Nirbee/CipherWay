import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { LAN_EXE } from '../core/coreNames'
import { installScript, serviceBrokerScript, uninstallScript } from '../core/serviceScripts'
import { psQuote } from '../core/broker'
import { lanBrokerScript, lanPipeName, parseLanState } from './lanBroker'
import { LanDaemon, LanStartError } from './LanDaemon'

// The LAN broker for real, without elevation: a temp «ProgramData», a fake
// daemon (a tiny C# exe that records its command line and environment and
// writes log lines to stderr), the app side (LanDaemon) talking to it through
// the files. What can't run here: the SYSTEM task itself, the real
// tailscaled (needs admin for its wintun adapter) and a real Headscale.

const win = process.platform === 'win32'
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const FAKE_DAEMON_CS = `
using System; using System.IO; using System.Threading;
public static class P { public static int Main(string[] a) {
  string dir = Environment.CurrentDirectory;
  string pd = Environment.GetEnvironmentVariable("ProgramData");
  string envFile = Path.Combine(Path.Combine(pd, "Tailscale"), "tailscaled-env.txt");
  File.WriteAllText(Path.Combine(dir, "fake-args.txt"), Environment.CommandLine + "\\n" + Environment.GetEnvironmentVariable("TS_LOGS_DIR") + "\\n" + pd + "\\n" + Environment.GetEnvironmentVariable("ALLUSERSPROFILE") + "\\n" + Environment.GetEnvironmentVariable("TEMP") + "\\n" + (File.Exists(envFile) ? "env-file:" + File.ReadAllText(envFile) : "env-file:none"));
  int n = a.Length > 0 && a[0] == "--short" ? 5 : 1200;
  for (int i = 0; i < n; i++) { Console.Error.WriteLine("2026/11/18 20:00:00 fake line " + i + " --auth-key=tskey-auth-secret123"); Console.Error.Flush(); Thread.Sleep(100); }
  return 3; } }
`

describe.skipIf(!win)('LAN broker (no elevation, fake daemon)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cw-lan-it-'))
  const sid = 'S-1-5-21-1000000001-1000000002-1000000003-1001'
  const root = join(tmp, 'ProgramData', 'CipherWay')
  const bin = join(root, 'bin')
  const home = join(root, 'u', sid)
  const lanDir = join(root, 'lan', sid)
  const userRun = join(tmp, "пользователь O'Neil", 'run')
  const fakeExe = join(tmp, 'fake.exe')
  const otherName = `cwfakets${randomBytes(3).toString('hex')}`
  const other = {
    service: 'CipherWayNoSuchService',
    process: otherName,
    adapterGuid: '{00000000-0000-0000-0000-000000000001}'
  }
  const procs: ChildProcess[] = []
  /** the «real» ProgramData of the test: any user may create Tailscale\\ in it */
  const plantedPd = join(tmp, 'RealProgramData')

  beforeAll(() => {
    for (const d of [bin, home, lanDir, userRun]) mkdirSync(d, { recursive: true })
    mkdirSync(join(plantedPd, 'Tailscale'), { recursive: true })
    writeFileSync(
      join(plantedPd, 'Tailscale', 'tailscaled-env.txt'),
      `TS_LOGS_DIR=${join(tmp, 'junction-to-system32')}\n`
    )
    const mk = join(tmp, 'mk.ps1')
    writeFileSync(join(tmp, 'fake.cs'), FAKE_DAEMON_CS)
    writeFileSync(
      mk,
      `Add-Type -TypeDefinition ([IO.File]::ReadAllText($args[0])) -OutputAssembly $args[1] -OutputType ConsoleApplication`
    )
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', mk, join(tmp, 'fake.cs'), fakeExe],
      { windowsHide: true, timeout: 60_000 }
    )
    copyFileSync(fakeExe, join(bin, LAN_EXE))
    writeFileSync(join(bin, 'wintun.dll'), 'not really wintun')
  }, 90_000)

  afterEach(async () => {
    for (const p of procs.splice(0)) if (p.exitCode === null) p.kill()
    await sleep(300)
  })
  afterAll(() => {
    try {
      execFileSync('taskkill', ['/f', '/im', LAN_EXE], { stdio: 'ignore' })
    } catch {
      /* none left */
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  function brokerFile(
    hashes = { [LAN_EXE]: sha(join(bin, LAN_EXE)), 'wintun.dll': sha(join(bin, 'wintun.dll')) }
  ): string {
    const file = join(home, 'lan-broker.ps1')
    writeFileSync(
      file,
      '\ufeff' + lanBrokerScript({ sid, userRunDir: userRun, hashes, rootOverride: root, other })
    )
    return file
  }

  /** LanDaemon with the «task» = this broker run without elevation */
  function daemon(file = brokerFile()): LanDaemon {
    return new LanDaemon({
      runDir: userRun,
      home,
      task: 'unused',
      log: () => undefined,
      runTask: async () => {
        const p = spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
          {
            windowsHide: true,
            env: { ...process.env, ProgramData: plantedPd, ALLUSERSPROFILE: plantedPd }
          }
        )
        procs.push(p)
        return { code: 0, out: '' }
      }
    })
  }
  const state = () => {
    try {
      return parseLanState(readFileSync(join(home, 'lan-state.json'), 'utf8'))
    } catch {
      return null
    }
  }

  it('starts only our exe with the fixed arguments, stops on «stop», the log is readable', async () => {
    const d = daemon()
    await d.start()
    const st = state()
    expect(st?.status).toBe('running')
    expect(st?.pid).toBeGreaterThan(0)

    // the command line the daemon got: nothing of the user's Tailscale, nothing from the user
    let args = ''
    for (let i = 0; i < 30 && !existsSync(join(lanDir, 'fake-args.txt')); i++) await sleep(100)
    args = readFileSync(join(lanDir, 'fake-args.txt'), 'utf8')
    const [cmd, logsDir, pd, allUsers, temp, envFile] = args.split('\n')
    expect(cmd).toContain(`"--statedir=${lanDir}"`)
    expect(cmd).toContain(`"--socket=${lanPipeName(sid)}"`)
    expect(cmd).toContain('"--tun=CipherWay LAN"')
    expect(cmd).toContain('--port=41642')
    expect(cmd).toContain('--no-logs-no-support')
    expect(cmd).toContain(`"--syspolicy-file=${join(lanDir, 'syspolicy.json')}"`)
    expect(JSON.parse(readFileSync(join(lanDir, 'syspolicy.json'), 'utf8'))).toEqual({
      InstallUpdates: 'never',
      CheckUpdates: 'never',
      UseTailscaleDNSSettings: 'never',
      UseTailscaleSubnets: 'never',
      AdvertiseExitNode: 'never'
    })
    expect(cmd).not.toMatch(/Tailscale\\tailscaled|ProgramData\\Tailscale|41641/i)
    expect(logsDir.trim()).toBe(lanDir)
    // envknob reads %ProgramData%\\Tailscale\\tailscaled-env.txt: the daemon's
    // ProgramData is the admin-only <statedir>\\pd — the planted file is never seen
    expect(pd.trim()).toBe(join(lanDir, 'pd'))
    expect(allUsers.trim()).toBe(join(lanDir, 'pd'))
    expect(temp.trim()).toBe(join(lanDir, 'tmp'))
    expect(envFile.trim()).toBe('env-file:none')

    // the app reads the daemon's log while it runs (shared read)
    await sleep(800)
    const lines = await d.readLog()
    expect(lines.length).toBeGreaterThan(2)
    expect(lines[0]).toContain('fake line 0')

    await d.stop()
    const end = state()
    expect(end?.status).toBe('stopped')
    expect(end?.stopReason).toBe('команда остановки')
    expect(existsSync(join(userRun, 'lan-ctl.json'))).toBe(false)
    // the daemon is gone
    await sleep(500)
    expect(() => process.kill(st!.pid!, 0)).toThrow()
  }, 60_000)

  it('refuses without a fresh request of a live app', async () => {
    const file = brokerFile()
    writeFileSync(
      join(userRun, 'lan-ctl.json'),
      JSON.stringify({
        session: 'a'.repeat(32),
        pid: process.pid,
        cmd: 'run',
        ts: Date.now() - 10 * 60_000
      })
    )
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      windowsHide: true
    })
    procs.push(p)
    await new Promise((r) => p.on('exit', r))
    expect(state()).toMatchObject({ status: 'refused', error: 'no_request' })
    expect(state()?.pid).toBe(0)
  }, 30_000)

  it('refuses a changed exe (hash baked into the broker)', async () => {
    const d = daemon(
      brokerFile({ [LAN_EXE]: 'b'.repeat(64), 'wintun.dll': sha(join(bin, 'wintun.dll')) })
    )
    const err = await d.start().then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(LanStartError)
    expect((err as LanStartError).code).toBe('failed')
    expect((err as LanStartError).message).toContain('файл LAN изменён')
    await d.stop()
  }, 30_000)

  it('never runs next to another Tailscale: refuses, and yields when one starts', async () => {
    const otherExe = join(tmp, `${otherName}.exe`)
    copyFileSync(fakeExe, otherExe)
    const o = spawn(otherExe, [], { cwd: tmp, windowsHide: true })
    procs.push(o)
    await sleep(500)
    const d = daemon()
    const err = await d.start().then(
      () => null,
      (e: unknown) => e
    )
    expect((err as LanStartError).code).toBe('tailscale_running')
    expect((err as LanStartError).detail).toContain(otherName)
    await d.stop()
    o.kill()
    await sleep(500)

    // started first, then «Tailscale» comes up: ours stops
    const d2 = daemon()
    await d2.start()
    const o2 = spawn(otherExe, [], { cwd: tmp, windowsHide: true })
    procs.push(o2)
    let st = state()
    for (let i = 0; i < 40 && st?.status === 'running'; i++) {
      await sleep(250)
      st = state()
    }
    expect(st).toMatchObject({ status: 'stopped', error: 'tailscale_running' })
    await d2.stop()
  }, 60_000)

  it("psQuote: a value with \u2018 \u2019 \u201a \u201b and ' stays one literal in real PowerShell", async () => {
    const value = "O\u2019Brien\u2018 \u201a\u201b'; Write-Output pwned; '$env:x`n"
    const out = join(tmp, 'quote-out.txt')
    const file = join(tmp, 'quote.ps1')
    writeFileSync(
      file,
      '\ufeff' +
        `[IO.File]::WriteAllText(${psQuote(out)}, ${psQuote(value)}, (New-Object Text.UTF8Encoding($false)))`
    )
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      windowsHide: true
    })
    expect(readFileSync(out, 'utf8')).toBe(value)
  }, 30_000)

  it('every generated PowerShell script parses', async () => {
    const h = {
      'cipherway-core.exe': 'a'.repeat(64),
      'wintun.dll': 'b'.repeat(64),
      [LAN_EXE]: 'c'.repeat(64)
    }
    const lan = lanBrokerScript({
      sid,
      userRunDir: 'C:\\r',
      hashes: { [LAN_EXE]: h[LAN_EXE], 'wintun.dll': h['wintun.dll'] }
    })
    const scripts: Record<string, string> = {
      lan,
      install: installScript({
        sid,
        srcBinDir: 'C:\\b',
        brokerText: serviceBrokerScript({ sid, userRunDir: 'C:\\r', hashes: h }),
        hashes: h,
        brokerHash: 'd'.repeat(64),
        lanBrokerText: lan,
        lanBrokerHash: 'e'.repeat(64),
        appVersion: '0.5.0'
      }),
      installTest: installScript({
        sid,
        srcBinDir: 'C:\\b',
        brokerText: 'x',
        hashes: h,
        brokerHash: 'd'.repeat(64),
        lanBrokerText: lan,
        lanBrokerHash: 'e'.repeat(64),
        appVersion: '0.5.0',
        testRoot: 'C:\\t'
      }),
      remove: uninstallScript(sid)
    }
    for (const [name, text] of Object.entries(scripts)) {
      const file = join(tmp, `parse-${name}.ps1`)
      writeFileSync(file, '\ufeff' + text)
      const out = await new Promise<string>((res) =>
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count`
          ],
          { windowsHide: true },
          (_e, o) => res(String(o).trim())
        )
      )
      expect(out, name).toBe('0')
    }
  }, 30_000)

  it('the installer (file part) copies the LAN exe, makes its state folder, records it in the manifest', async () => {
    const r2 = join(tmp, 'install-root')
    const src = join(tmp, 'srcbin')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'cipherway-core.exe'), 'core')
    writeFileSync(join(src, 'wintun.dll'), 'wintun')
    copyFileSync(fakeExe, join(src, LAN_EXE))
    const h = {
      'cipherway-core.exe': sha(join(src, 'cipherway-core.exe')),
      'wintun.dll': sha(join(src, 'wintun.dll')),
      [LAN_EXE]: sha(join(src, LAN_EXE))
    }
    const file = join(tmp, 'install.ps1')
    writeFileSync(
      file,
      '\ufeff' +
        installScript({
          sid,
          srcBinDir: src,
          brokerText: 'tun broker',
          hashes: h,
          brokerHash: 'd'.repeat(64),
          lanBrokerText: 'lan broker',
          lanBrokerHash: 'e'.repeat(64),
          appVersion: '0.5.0',
          testRoot: r2
        })
    )
    const code = await new Promise<number | null>((res) => {
      const p = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
        {
          windowsHide: true
        }
      )
      p.on('exit', res)
    })
    expect(code).toBe(0)
    expect(sha(join(r2, 'bin', LAN_EXE))).toBe(h[LAN_EXE])
    expect(existsSync(join(r2, 'lan', sid))).toBe(true)
    expect(readFileSync(join(r2, 'u', sid, 'lan-broker.ps1'), 'utf8').replace(/^\ufeff/, '')).toBe(
      'lan broker'
    )
    const manifest = JSON.parse(readFileSync(join(r2, 'u', sid, 'manifest.json'), 'utf8'))
    expect(manifest.lanBroker).toBe('e'.repeat(64))
    expect(manifest.files[LAN_EXE]).toBe(h[LAN_EXE])
  }, 60_000)
})
