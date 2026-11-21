import { describe, expect, it } from 'vitest'
import { LAN_EXE } from '../core/coreNames'
import { installScript, serviceBrokerScript, uninstallScript } from '../core/serviceScripts'
import { generateSingboxConfig } from '../core/configGen'
import { TEST_SETTINGS } from '../core/fixtures'
import { lanBrokerScript, lanPipeName, lanTaskName, parseLanState } from './lanBroker'

const sid = 'S-1-5-21-1000000001-1000000002-1000000003-1001'
const H = { [LAN_EXE]: 'a'.repeat(64), 'wintun.dll': 'b'.repeat(64) }
const script = lanBrokerScript({ sid, userRunDir: "C:\\Users\\O'Neil $x\\run", hashes: H })

describe('LAN broker allow-list (security)', () => {
  it('runs only <Root>\\bin\\cipherway-lan.exe, hash-checked before every start', () => {
    expect(script).toContain("$Exe = Join-Path $Bin 'cipherway-lan.exe'")
    expect(script).toContain(
      `$Hashes = @{ 'cipherway-lan.exe' = '${'a'.repeat(64)}'; 'wintun.dll' = '${'b'.repeat(64)}' }`
    )
    expect(script).toMatch(
      /function Start-Daemon \{\s+foreach \(\$k in @\(\$Hashes\.Keys\)\) \{\s+if \(\(Sha \(Join-Path \$Bin \$k\)\) -ne \$Hashes\[\$k\]\) \{ throw/
    )
    expect(script).toContain('Start-Process -FilePath $Exe -ArgumentList (Daemon-Args)')
    // exactly one process start in the whole script
    expect(script.match(/Start-Process/g)).toHaveLength(1)
  })

  it('the command line is fixed: own state dir, own pipe, own adapter and port, no log upload', () => {
    const args = /function Daemon-Args \{\s+return \((.*)\)\s+\}/.exec(script)?.[1]
    expect(args).toBe(
      `'"--statedir=' + $LanDir + '" "--socket=' + $Pipe + '" "--tun=' + $TunName + '" --port=' + $Port + ' --no-logs-no-support "--syspolicy-file=' + $PolicyF + '"'`
    )
    // its own fixed device policy, written by the broker (never the user's)
    expect(script).toContain("$PolicyF = Join-Path $LanDir 'syspolicy.json'")
    expect(script).toContain(
      `$Policy = '{"InstallUpdates":"never","CheckUpdates":"never","UseTailscaleDNSSettings":"never","UseTailscaleSubnets":"never","AdvertiseExitNode":"never"}'`
    )
    expect(script).toContain('Write-Atomic $PolicyF $Policy')
    expect(script).toContain("$LanDir = Join-Path $Root ('lan\\' + $Sid)")
    expect(script).toContain(
      `$Pipe = '\\\\.\\pipe\\ProtectedPrefix\\Administrators\\CipherWay\\lan-${sid}'`
    )
    expect(script).toContain("$TunName = 'CipherWay LAN'")
    expect(script).toContain('$Port = 41642')
    expect(script).toContain('$env:TS_LOGS_DIR = $LanDir')
  })

  it('reads from the user only lan-ctl.json (size-limited, no links) and only cmd / pid / ts of it', () => {
    expect(script).toContain("$CtlF = Join-Path $UserRun 'lan-ctl.json'")
    expect(script).toContain('$t = Read-UserFile $CtlF 4096')
    expect(script).toContain('ReparsePoint')
    // no other path below the user's folder is ever used
    expect(script.match(/\$UserRun/g)).toHaveLength(2)
    // a stale request or a dead app pid: no start
    expect(script).toContain(
      '[math]::Abs((Now-Ms) - [long]$ctl.ts) -gt 120000 -or -not (Alive $ctl.pid)'
    )
    // user-provided strings are single-quoted literals
    expect(script).toContain("$UserRun = 'C:\\Users\\O''Neil $x\\run'")
  })

  it('never next to the user’s Tailscale: service / process / adapter GUID checked, before and while running', () => {
    expect(script).toContain("$OtherService = 'Tailscale'")
    expect(script).toContain("$OtherProcess = 'tailscaled'")
    expect(script).toContain("$OtherGuid = '{37217669-42da-4657-a55b-0d995d328250}'")
    expect(script).toMatch(
      /\$busy = Other-Tailscale \$true\s+if \(\$busy\) \{\s+\$State\.status = 'refused'\s+\$State\.error = 'tailscale_running'/
    )
    expect(script).toMatch(
      /\$busy = Other-Tailscale \$false\s+if \(\$busy\) \{\s+\$State\.error = 'tailscale_running'/
    )
    // and nothing of it is ever touched: no Stop-Service, no netsh, no registry
    expect(script).not.toMatch(/Stop-Service|Set-Service|netsh|HKLM:|Remove-Item/i)
  })

  it('ProgramData / ALLUSERSPROFILE / TEMP of the daemon: admin-only folders, never links (env-file injection)', () => {
    expect(script).toContain("$Pd = Join-Path $LanDir 'pd'")
    expect(script).toContain("$TmpD = Join-Path $LanDir 'tmp'")
    for (const v of ['ProgramData', 'ALLUSERSPROFILE']) expect(script).toContain(`$env:${v} = $Pd`)
    for (const v of ['TEMP', 'TMP']) expect(script).toContain(`$env:${v} = $TmpD`)
    expect(script).toContain(
      "if ((Is-Reparse $d) -or -not [IO.Directory]::Exists($d)) { throw ('папка LAN подменена: ' + $d) }"
    )
    // set before the one Start-Process
    expect(script.indexOf('$env:ProgramData = $Pd')).toBeLessThan(script.indexOf('Start-Process'))
  })

  it('an orphan is stopped only by its recorded pid, our file AND our state dir in its command line', () => {
    expect(script).toContain('if ($o.MainModule.FileName -ine $Exe) { return $false }')
    expect(script).toContain(
      `$cl.IndexOf('"--statedir=' + $LanDir + '"', [StringComparison]::OrdinalIgnoreCase) -ge 0`
    )
    expect(script).toContain('if (Is-OurDaemon $o) {')
  })

  it('the adapter: a leftover device of its GUID goes before the start, only after the Tailscale check', () => {
    expect(script).toContain("$OwnGuid = '{37217669-42DA-4657-A55B-0D995D328250}'")
    expect(script).toMatch(
      /Own-Adapter\); \$i\+\+\) \{ Start-Sleep -Milliseconds 250 \}\s+Remove-WintunGhost \$OwnGuid\s+Rotate \$LogF/
    )
    expect(script.indexOf('$busy = Other-Tailscale $true')).toBeLessThan(
      script.indexOf('$daemon = Start-Daemon')
    )
    // the it-test's fake «other Tailscale» GUID is used for its own daemon too
    const fake = lanBrokerScript({
      sid,
      userRunDir: 'C:\r',
      hashes: H,
      other: { service: 'x', process: 'y', adapterGuid: '{00000000-0000-0000-0000-000000000001}' }
    })
    expect(fake).toContain("$OwnGuid = '{00000000-0000-0000-0000-000000000001}'")
    expect(fake).not.toContain('37217669')
  })

  it('the daemon is never killed while it is creating its adapter (≤ 20 s, «stopping»)', () => {
    const kill = /function Kill-Daemon\(\$p, \[bool\]\$report\) \{([\s\S]*?)\n\}/.exec(
      script.replace(/\r\n/g, '\n')
    )?.[1]
    expect(kill).toBeTruthy()
    expect(kill).toContain('if (Wintun-Creating $OwnGuid $TunName) {')
    expect(kill).toContain('$end = (Now-Ms) + 20000')
    expect(kill).toContain("if ($report) { $State.status = 'stopping' }")
    expect(kill).toMatch(
      /\$State\.status = \$was\s+\}\s+if \(-not \$p\.HasExited\) \{ \$p\.Kill\(\)/
    )
    // every kill of the daemon goes through it
    expect(script.match(/\.Kill\(\)/g)).toHaveLength(1)
    expect(script).toContain('try { Kill-Daemon $d $true } catch {}')
    expect(script).toContain('Kill-Daemon $o $false')
    // the session is reported before an orphan (maybe creating its adapter) is waited for
    expect(script).toMatch(/Save-State\s+Stop-Orphan\s+\$busy = Other-Tailscale \$true/)
  })

  it('«LAN busy» counts only processes of our exact file, not anything called cipherway-lan', () => {
    expect(script).toContain('| Where-Object { $_.Path -ieq $Exe }).Count -gt 0) {')
  })

  it('bad input never makes a script', () => {
    expect(() =>
      lanBrokerScript({ sid: 'S-1-5-21-1; calc', userRunDir: 'C:\\r', hashes: H })
    ).toThrow()
    expect(() =>
      lanBrokerScript({ sid, userRunDir: 'C:\\r', hashes: { ...H, 'wintun.dll': 'x' } })
    ).toThrow()
    expect(() => lanPipeName('S-1-5-21-x')).toThrow()
  })

  it('names', () => {
    expect(lanTaskName(sid)).toBe(`CipherWay LAN ${sid}`)
    expect(lanPipeName(sid)).toBe(
      `\\\\.\\pipe\\ProtectedPrefix\\Administrators\\CipherWay\\lan-${sid}`
    )
  })
})

describe('installer / remover with LAN', () => {
  const hashes = {
    'cipherway-core.exe': 'c'.repeat(64),
    'wintun.dll': 'b'.repeat(64),
    [LAN_EXE]: 'a'.repeat(64)
  }
  const base = {
    sid,
    srcBinDir: 'C:\\b',
    brokerText: 'tun',
    brokerHash: 'd'.repeat(64),
    appVersion: '0.5.0'
  }

  it('one installer (one UAC prompt) sets up both tasks, the LAN state folder for admins only', () => {
    const s = installScript({
      ...base,
      hashes,
      lanBrokerText: 'lan',
      lanBrokerHash: 'e'.repeat(64)
    })
    expect(s).toContain(`$LanTaskName = 'CipherWay LAN ${sid}'`)
    expect(s).toContain("$Admins = 'O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'")
    expect(s).toContain('Secure-Dir $LanDir $Admins')
    expect(s).toContain("Secure-Dir (Join-Path $LanDir 'pd') $Admins")
    expect(s).toContain("Put-File (Join-Path $SrcBin 'cipherway-lan.exe') 'cipherway-lan.exe'")
    expect(s).toContain(
      '$null = $folder.RegisterTask($LanTaskName, $LanXml, 6, $null, $null, 5, $TaskSddl)'
    )
    expect(s).toContain('-File "$LanBrokerX"')
    expect(s).toContain(`"lanBroker":"${'e'.repeat(64)}"`)
    // the running daemon is stopped only to replace its file, and only processes of that file
    expect(s).toContain('if ($p.Path -ieq $path)')
  })

  it('without the LAN exe the installer stays as it was (no LAN task)', () => {
    const { [LAN_EXE]: _lan, ...tunOnly } = hashes
    void _lan
    const s = installScript({ ...base, hashes: tunOnly })
    expect(s).not.toContain('RegisterTask($LanTaskName')
    expect(s).not.toContain('Secure-Dir $LanDir')
    expect(s).not.toContain('lanBroker')
  })

  it('the remover takes the LAN task, its daemon and its state along', () => {
    const s = uninstallScript(sid)
    expect(s).toContain('DeleteTask($LanTaskName, 0)')
    expect(s).toContain('$o.MainModule.FileName -ieq $LanExe -and $mine')
    expect(s).toContain(`$cl.IndexOf('"--statedir=' + $LanDir + '"'`)
    expect(s).toContain('[IO.Directory]::Delete($LanDir, $true)')
  })
})

describe('the TUN broker still accepts the VPN config with the LAN rules', () => {
  it('no key of the generated TUN config hits the broker’s forbidden list', () => {
    const tunBroker = serviceBrokerScript({
      sid,
      userRunDir: 'C:\\r',
      hashes: { 'cipherway-core.exe': 'c'.repeat(64), 'wintun.dll': 'b'.repeat(64) }
    })
    const forbidden = /\$Forbidden = '\(\?i\)(.*)'/.exec(tunBroker)?.[1]
    expect(forbidden).toBeTruthy()
    const re = new RegExp(forbidden!, 'i')
    const cfg = generateSingboxConfig({
      outbounds: [],
      activeOutboundId: undefined,
      slots: { groups: 0, dir: 'C:\\rules', selectors: {} },
      settings: { ...TEST_SETTINGS, proxyMode: 'tun' },
      socksPort: 1,
      httpPort: 2,
      clashApiPort: 3,
      logFile: 'C:\\l.log',
      xrayPorts: {},
      lan: { exePath: 'C:\\ProgramData\\CipherWay\\bin\\cipherway-lan.exe' }
    })
    // the broker's own exceptions, taken from the script itself
    const src = /\$w -notmatch '([^']*)'\)/.exec(tunBroker)?.[1]
    expect(src).toBeTruthy()
    const allowed = new RegExp(src!)
    expect(allowed.test('.route.rules[0].process_path')).toBe(true)
    expect(allowed.test('.route.rule_set[3].path')).toBe(true)
    expect(allowed.test('.log.path')).toBe(false)
    expect(allowed.test('.route.rules[0].process_path_regex')).toBe(false)
    const bad: string[] = []
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) node.forEach((x, i) => walk(x, `${where}[${i}]`))
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          const w = `${where}.${k}`
          if (re.test(k) && !allowed.test(w)) bad.push(w)
          walk(v, w)
        }
      }
    }
    walk(cfg, '')
    expect(bad).toEqual([])
  })
})

describe('parseLanState', () => {
  it('reads the broker’s file, garbage gives null / unknown values dropped', () => {
    expect(
      parseLanState(
        '\ufeff{"session":"ab","status":"running","error":"","pid":7,"exitCode":null,"ts":5}'
      )
    ).toMatchObject({ session: 'ab', status: 'running', error: '', pid: 7, exitCode: null, ts: 5 })
    expect(parseLanState('{"status":"weird","error":"evil"}')).toMatchObject({
      status: undefined,
      error: undefined
    })
    expect(parseLanState('nope')).toBeNull()
    expect(parseLanState('{"status":"stopping"}')?.status).toBe('stopping')
  })
})
