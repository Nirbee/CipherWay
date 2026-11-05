import { describe, expect, it } from 'vitest'
import {
  elevateCommand,
  installScript,
  isValidSid,
  serviceBrokerScript,
  taskName,
  uninstallScript
} from './serviceScripts'

describe('«Служба TUN» scripts (0.4.2)', () => {
  const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
  const hashes = { 'sing-box.exe': 'a'.repeat(64), 'wintun.dll': 'b'.repeat(64) }
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
    expect(broker).toContain(`$psi.Arguments = 'run -c "' + $CfgOut + '"'`)
    expect(broker).toContain('$psi.FileName = $Exe')
    for (const k of ['cache', 'path', '_ui', 'download', 'certificate', 'platform'])
      expect(broker).toMatch(new RegExp(`\\$Forbidden = .*${k}`))
    expect(broker).toContain("'^127\\.0\\.0\\.1:\\d{1,5}$'")
    expect(broker).toContain("if ($x.type -ne 'tun')")
    expect(broker).toContain("$x.type -ne 'local' -or $x.format -ne 'source'")
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

  it('remover and the UAC launcher', () => {
    expect(uninstallScript(sid)).toContain('DeleteTask($TaskName, 0)')
    expect(elevateCommand("C:\\Users\\O'Нил\\x.ps1")).toContain(
      `'-File','"C:\\Users\\O''Нил\\x.ps1"'`
    )
    expect(elevateCommand('C:\\x.ps1')).toContain('catch { exit 1223 }')
  })
})
