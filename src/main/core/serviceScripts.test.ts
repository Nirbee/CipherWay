import { describe, expect, it } from 'vitest'
import {
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
    expect(broker).toContain("'^127\\.0\\.0\\.1:\\d{1,5}$'")
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
    expect(broker).toContain('$o.MainModule.FileName -ieq $Exe')
    expect(broker).toContain("'/remove-device' $id")
  })

  it('no trace of the old names in what runs as SYSTEM', () => {
    expect(broker).not.toContain('sing-box.exe')
    expect(broker).not.toContain('xray.exe')
  })

  it('needs a fresh request from a live app', () => {
    expect(broker).toContain("$ctl.cmd -ne 'run'")
    expect(broker).toContain('-gt 120000')
    expect(broker).toContain('Alive $ctl.pid')
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
