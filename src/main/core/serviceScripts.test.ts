import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DPI_ALL } from './coreNames'
import {
  dpiTaskName,
  elevateCommand,
  installScript,
  isValidSid,
  legacyCleanupPs,
  serviceBrokerScript,
  taskName,
  uninstallScript
} from './serviceScripts'

describe('«Служба TUN» scripts (0.4.2)', () => {
  const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
  const hashes = { 'cipherway-core.exe': 'a'.repeat(64), 'wintun.dll': 'b'.repeat(64) }
  const broker = serviceBrokerScript({
    sid,
    userRunDir: "C:\\Users\\O'Нил $x\\AppData\\Roaming\\cipherway-vpn\\run",
    hashes
  })

  it('refuses a malformed SID / hash (they end up in an elevated script)', () => {
    expect(() =>
      serviceBrokerScript({ sid: "S-1-5-21-1'; calc", userRunDir: 'C:\\r', hashes })
    ).toThrow()
    expect(() =>
      serviceBrokerScript({ sid, userRunDir: 'C:\\r', hashes: { ...hashes, 'wintun.dll': "x'" } })
    ).toThrow()
    expect(() =>
      installScript({
        sid: 'S-1-1-0',
        srcBinDir: 'x',
        brokerText: '',
        hashes,
        brokerHash: '',
        appVersion: ''
      })
    ).toThrow()
    expect(isValidSid(sid)).toBe(true)
    expect(isValidSid('S-1-5-32-544')).toBe(false)
  })

  it('the user folder is a quoted literal; modules only from $PSHOME', () => {
    expect(broker).toContain(
      "$UserRun = 'C:\\Users\\O''Нил $x\\AppData\\Roaming\\cipherway-vpn\\run'"
    )
    expect(broker).toContain("$env:PSModulePath = Join-Path $PSHOME 'Modules'")
    expect(broker).toContain("[Environment]::GetFolderPath('CommonApplicationData')")
  })

  it('writes only into its protected folder, never into the user folder', () => {
    const writes = [...broker.matchAll(/Write-Atomic (\$\w+)/g)].map((m) => m[1])
    expect(new Set(writes)).toEqual(new Set(['$StateF', '$CfgOut', '$dest']))
    // $dest is always inside $RulesOut; files are deleted only there
    expect(broker).toContain('$dest = Join-Path $RulesOut $leaf')
    const deletes = [...broker.matchAll(/\[IO\.File\]::Delete\((\$\w+)\)/g)].map((m) => m[1])
    expect(deletes).toEqual(['$f'])
    expect(broker).toContain("foreach ($f in [IO.Directory]::GetFiles($RulesOut, 'cw-*.json'))")
  })

  it('validates the config and the core files before every start; runs only the copy', () => {
    expect(broker).toMatch(
      /function Prepare[\s\S]*Sha \(Join-Path \$Bin \$k\)[\s\S]*Test-Config \$text[\s\S]*Write-Atomic \$CfgOut \$text/
    )
    expect(broker).toContain(`$CoreArgs = 'run -c "' + $CfgOut + '"'`)
    expect(broker).toContain("$Exe = Join-Path $Bin 'cipherway-core.exe'")
    expect(broker).toContain('$CoreExe = $Exe')
    expect(broker).toContain('$psi.FileName = $CoreExe')
    for (const k of ['cache', 'path', '_ui', 'download', 'certificate', 'platform'])
      expect(broker).toMatch(new RegExp(`\\$Forbidden = .*${k}`))
    expect(broker).toContain("'^127\\.0\\.0\\.1:[0-9]{1,5}\\z'")
    expect(broker).toContain("if ($x.type -ne 'tun')")
    expect(broker).toContain("$x.type -ne 'local' -or $x.format -ne 'source'")
  })

  it('reports why a core ended: exit code, time, what it printed (a FATAL goes to stderr only)', () => {
    expect(broker).toContain('$psi.RedirectStandardError = $true')
    expect(broker).toContain('$c.StandardError.ReadToEndAsync()')
    expect(broker).toMatch(
      /function Report-Exit[\s\S]*\$State\.exitCode = \$p\.ExitCode[\s\S]*\$State\.uptimeMs =[\s\S]*\$State\.stderr = Core-Output/
    )
    expect(broker).toContain("[IO.File]::AppendAllText($BrokerLog,")
    expect(broker).toContain("$BrokerLog = Join-Path $Dir 'broker.log'")
    for (const why of ['нет файла запроса', 'новая сессия', 'команда остановки', 'приложение закрыто'])
      expect(broker).toContain(`$State.stopReason = '${why}'`)
  })

  it('one failed read of the request file does not kill a working core', () => {
    expect(broker).not.toContain("if ($null -eq $c -or $c.session -ne $State.session")
    expect(broker).toMatch(/if \(\$null -eq \$c\) \{[\s\S]*\$miss\+\+[\s\S]*-gt 12\)[\s\S]*continue/)
  })

  it('a stale adapter and an orphaned core are dealt with before every start', () => {
    expect(broker).toMatch(/Stop-Orphan[\s\S]*Save-State\s+Clear-StaleAdapter\s+Prepare\s+\$core = Start-Core/)
    expect(broker).toMatch(/Stop-Core \$core\s+\$core = \$null\s+Clear-StaleAdapter\s+Prepare/)
    // only our adapter; only a process running our protected file
    expect(broker).toContain("$TunName = 'CipherWay'")
    expect(broker).toContain("$TunGuid = '{3D56CD02-D8B1-21DE-B21B-2D7CFA71C8E3}'")
    expect(broker).toContain('Remove-WintunGhost $TunGuid')
    expect(broker).toContain('$o.MainModule.FileName -ieq $Exe')
    expect(broker).toContain("'/remove-device' $id")
  })

  it('no trace of the old names in what runs as SYSTEM', () => {
    expect(broker).not.toContain('sing-box.exe')
    expect(broker).not.toContain('xray.exe')
  })

  it('needs a fresh request from a live app', () => {
    expect(broker).toContain("$ctl.cmd -cne 'run'")
    expect(broker).toContain('-gt 120000')
    // numbers of the request: range-checked before any cast (never quoted in an error)
    expect(broker).toContain('(Num $ctl.ts)')
    expect(broker).toContain('Alive (Num $ctl.pid)')
    expect(broker).not.toMatch(/\[long\]\$c(tl)?\./)
  })

  const install = installScript({
    sid,
    srcBinDir: 'C:\\Users\\me\\AppData\\Local\\Programs\\CipherWay VPN\\resources\\bin',
    brokerText: broker,
    hashes,
    brokerHash: 'c'.repeat(64),
    appVersion: '0.4.2'
  })

  it('installer: protected folders, the user may only read; planted folders are not reused', () => {
    expect(install).toContain(
      "'O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'"
    )
    expect(install).toContain("(A;OICI;0x1200a9;;;' + $Sid + ')")
    expect(install).toContain('[IO.Directory]::CreateDirectory($path, $ds)')
    expect(install).toContain('.untrusted-')
    expect(install).toContain("$Trusted = @('S-1-5-32-544', 'S-1-5-18')")
    // the broker travels as base64 — no quoting issues inside the installer
    expect(install).toContain(Buffer.from(broker, 'utf8').toString('base64'))
  })

  it('installer: hash re-checked after copying; the task runs as SYSTEM, user gets FRFX only', () => {
    expect(install).toMatch(
      /\[IO\.File\]::Copy\(\$src, \$tmp, \$true\)\s+if \(\(Sha \$tmp\) -ne \$Want\[\$name\]\)/
    )
    expect(install).toContain('<UserId>S-1-5-18</UserId>')
    expect(install).toContain('<RunLevel>HighestAvailable</RunLevel>')
    expect(install).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(install).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
    expect(install).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>')
    expect(install).toContain('<Priority>4</Priority>')
    expect(install).toContain("'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;' + $Sid + ')'")
    expect(install).toContain(
      "Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\\v1.0\\powershell.exe'"
    )
    expect(install).toContain(`$TaskName = '${taskName(sid)}'`)
  })

  it('update from 0.4.2: the new core is copied, the old file removed only after everything else', () => {
    expect(install).toContain("Put-File (Join-Path $SrcBin 'cipherway-core.exe') 'cipherway-core.exe'")
    expect(install).toMatch(/RegisterTask[\s\S]*manifest\.json[\s\S]*try \{ Remove-LegacyCores \}/)
    const cleanup = legacyCleanupPs()
    expect(cleanup).toContain("@('sing-box.exe', 'xray.exe')")
    // somebody else's sing-box.exe (Happ…) is never stopped
    expect(cleanup).toContain('$p.Path -ieq $path')
    expect(cleanup).toContain('$path = Join-Path $Bin $name')
  })

  it('the test mode of the installer is off by default', () => {
    expect(install).toContain("[Environment]::GetFolderPath('CommonApplicationData')")
    expect(install).toContain('Secure-Dir $Dir $Mine')
    expect(install).toContain('RegisterTask')
    const t = installScript({
      sid,
      srcBinDir: 'C:\\b',
      brokerText: '',
      hashes,
      brokerHash: '',
      appVersion: '',
      testRoot: 'C:\\t'
    })
    expect(t).not.toContain('RegisterTask')
    expect(t).not.toContain('Secure-Dir $Dir $Mine')
  })

  it('remover and the UAC launcher', () => {
    expect(uninstallScript(sid)).toContain('DeleteTask($TaskName, 0)')
    expect(elevateCommand("C:\\Users\\O'Нил\\x.ps1")).toContain(
      `'-File','"C:\\Users\\O''Нил\\x.ps1"'`
    )
    expect(elevateCommand('C:\\x.ps1')).toContain('catch { exit 1223 }')
  })
})

describe('the zapret task of the service (0.7.0)', () => {
  const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
  const base = { 'cipherway-core.exe': 'a'.repeat(64), 'wintun.dll': 'b'.repeat(64) }
  const dpiHashes = Object.fromEntries(DPI_ALL.map((f, i) => [f, String(i + 1).repeat(64)]))
  const params = {
    sid,
    srcBinDir: 'C:\b',
    brokerText: 'tun',
    brokerHash: 'c'.repeat(64),
    appVersion: '0.7.0'
  }

  it('copies every zapret file (hash-checked) and registers «CipherWay DPI <SID>» as SYSTEM', () => {
    const install = installScript({
      ...params,
      hashes: { ...base, ...dpiHashes },
      dpiBrokerText: 'dpi',
      dpiBrokerHash: 'd'.repeat(64)
    })
    for (const f of DPI_ALL) {
      expect(install).toContain(`'${f}' = '${dpiHashes[f]}'`)
      expect(install).toContain(`Put-File (Join-Path $SrcBin '${f}') '${f}' $DpiBin`)
    }
    expect(install).toContain(`$DpiTaskName = '${dpiTaskName(sid)}'`)
    expect(install).toContain('RegisterTask($DpiTaskName, $DpiXml, 6, $null, $null, 5, $TaskSddl)')
    expect(install).toContain('-File "$DpiBrokerX"')
    expect(install).toContain('"dpiBroker":"' + 'd'.repeat(64) + '"')
    // a loaded WinDivert can't be overwritten: renamed instead, only for zapret's files
    expect(install).toContain('if ($DpiNames -notcontains $name) { throw }')
  })

  it('a build without zapret: no DPI task, nothing of it copied', () => {
    const install = installScript({ ...params, hashes: base })
    expect(install).not.toContain('DpiXml')
    expect(install).not.toContain("Put-File (Join-Path $SrcBin 'cipherway-dpi.exe')")
    expect(() =>
      installScript({
        ...params,
        hashes: { ...base, ...dpiHashes, 'cygwin1.dll': 'zz' },
        dpiBrokerText: 'dpi',
        dpiBrokerHash: 'd'.repeat(64)
      })
    ).toThrow()
  })

  it('removal deletes the DPI task and stops only our winws', () => {
    const u = uninstallScript(sid)
    expect(u).toContain('DeleteTask($DpiTaskName, 0)')
    // our file (new or old place) AND this user's hostlist in its command line
    expect(u).toContain("$DpiHosts = Join-Path $Dir 'dpi\\hosts.txt'")
    expect(u).toContain(`$cl.IndexOf('"--hostlist=' + $DpiHosts + '"'`)
    expect(u).toContain('$DpiExes -contains $o.MainModule.FileName -and $mine')
    // TCP timestamps (0.7.2): only while no broker holds the lock; confirmed before the marker goes
    expect(u).toContain(
      '[IO.File]::Open($LockF, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)'
    )
    expect(u).toContain("$Netsh = Join-Path ([Environment]::GetFolderPath('System')) 'netsh.exe'")
    expect(u).not.toContain('$env:SystemRoot')
    expect(u).toContain("$si.Arguments = 'interface tcp set global timestamps=disabled'")
    expect(u).toContain('$done = $pr.WaitForExit(15000) -and $pr.ExitCode -eq 0')
    expect(u).toContain('if ($done -and (& $tsNow) -eq 0) { [IO.File]::Delete($TsF) }')
  })

  it("zapret's files: admin-only <Root>\\dpi\\bin (Cygwin's root <Root>\\dpi holds nothing else); out of the shared bin", () => {
    const install = installScript({
      ...params,
      hashes: { ...base, ...dpiHashes },
      dpiBrokerText: 'dpi',
      dpiBrokerHash: 'd'.repeat(64)
    })
    expect(install).toContain("$DpiRoot = Join-Path $Root 'dpi'")
    expect(install).toMatch(
      /Secure-Dir \$DpiRoot \$Admins\s+Clean-CygwinRoot\s+Secure-Dir \$DpiBin \$Admins/
    )
    expect(install).toContain("Secure-Dir (Join-Path $Root 'tmp') $Admins")
    expect(install).toContain("if ($leaf -eq 'bin' -and $isDir -and -not $link) { continue }")
    // links removed as links (no recursion into them); anything else moved aside, never deleted recursively
    expect(install).toContain('if ($isDir) { [IO.Directory]::Delete($e) } else { [IO.File]::Delete($e) }')
    expect(install).toContain("} elseif ($leaf -like '*.untrusted-*') {")
    const clean = install.slice(install.indexOf('function Clean-CygwinRoot'), install.indexOf('function Remove-DpiFromBin'))
    expect(clean).not.toContain('Delete($e, $true)')
    // the old place: removed after the new copies are in (a loaded driver: renamed)
    expect(install).toMatch(
      /Put-File \(Join-Path \$SrcBin 'quic_initial_www_google_com\.bin'\)[^\n]*\n\s+try \{ Remove-DpiFromBin \}/
    )
    expect(install).toContain(
      "[IO.File]::Move($f, $f + '.old-' + [Guid]::NewGuid().ToString('N'))"
    )
    expect(install).not.toMatch(/'cipherway-dpi\.exe'\) 'cipherway-dpi\.exe'\s*$/m)
  })

  it('anchors of the shared broker helpers and the TUN config check: \\z, refused values cleaned', () => {
    const tun = serviceBrokerScript({ sid, userRunDir: 'C:\\r', hashes: base })
    expect(tun).toContain("$c.session -cnotmatch '^[0-9a-f]{16,64}\\z'")
    expect(tun).toContain("$NameRe = '^cw-[0-9a-z-]{1,40}\\.json\\z'")
    expect(tun).toContain("'^127\\.0\\.0\\.1:[0-9]{1,5}\\z'")
    expect(tun).not.toMatch(/match '[^']*\$'/)
    expect(tun).toContain("throw ('cw-config выход ' + (Safe $x.type))")
    expect(tun).toContain("[regex]::Replace(([string]$s).ToLowerInvariant(), '[^a-z0-9._-]', '')")
    // the state: a fixed code only; the JSON parse never quotes the config
    expect(tun).toContain("try { $c = $text | ConvertFrom-Json } catch { throw 'cw-config не JSON' }")
    expect(tun).toContain("$State.error = 'failed'")
    expect(tun).not.toContain('$State.error = [string]$_.Exception.Message')
  })
})

describe.skipIf(process.platform !== 'win32')('the removal script is valid PowerShell', () => {
  it('no parse errors (Windows PowerShell 5.1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-un-'))
    const f = join(dir, 'un.ps1')
    writeFileSync(f, '\ufeff' + uninstallScript('S-1-5-21-1111111111-2222222222-3333333333-1001'))
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$e); $e.Count`
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
    )
    rmSync(dir, { recursive: true, force: true })
    expect(out.trim()).toBe('0')
  })
})
