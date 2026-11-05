import { describe, expect, it } from 'vitest'
import { brokerScript, hasTunAdapter, parseCoreExit, psQuote } from './broker'

describe('TUN broker script', () => {
  const script = brokerScript({
    exe: 'C:\\Program Files\\CipherWay VPN\\resources\\bin\\cipherway-core.exe',
    config: "C:\\Users\\O'Neil $user\\AppData\\Roaming\\cipherway\\run\\config.json",
    workDir: 'C:\\bin',
    stopFile: 'C:\\run\\stop.signal',
    restartFile: 'C:\\run\\restart.signal',
    exitFile: 'C:\\run\\core.exit',
    parentPid: 4242
  })

  it('paths are single-quoted literals (no $ / backtick expansion, quotes doubled)', () => {
    expect(psQuote("a'b$c`d")).toBe("'a''b$c`d'")
    expect(script).toContain(
      "$cfg = 'C:\\Users\\O''Neil $user\\AppData\\Roaming\\cipherway\\run\\config.json'"
    )
  })

  it('restart signal: kills the core and starts a fresh one (no second UAC prompt)', () => {
    expect(script).toMatch(
      /if \(Test-Path \$restart\)[\s\S]*Stop-Process -Id \$p\.Id -Force[\s\S]*Clear-StaleAdapter[\s\S]*\$p = Start-CoreProcess/
    )
  })

  it('reports a core that died on its own: code, time, stderr; and dies with the app', () => {
    expect(script).toContain('if (-not (Test-Path $exitf)) { Write-Exit $p }')
    expect(script).toContain('@{ code = $c.ExitCode; uptimeMs =')
    expect(script).toContain('stderr = (Core-Output)')
    expect(script).toContain('$psi.RedirectStandardError = $true')
    expect(script).toContain('$parent = 4242')
    expect(script).toContain('Get-Process -Id $parent')
  })

  it('the report is written atomically: a half-written file is never read', () => {
    expect(script).toContain("$tmp = $exitf + '.tmp'")
    expect(script).toContain('[IO.File]::Move($tmp, $exitf)')
  })

  it('the old adapter goes first', () => {
    expect(script).toMatch(/Clear-StaleAdapter\s+\$p = Start-CoreProcess\s+\$idle = 0/)
    expect(script).toContain("$TunName = 'CipherWay'")
  })
})

describe('parseCoreExit', () => {
  it('reads the report of the broker', () => {
    expect(parseCoreExit('{"code":1,"uptimeMs":12500,"stderr":"FATAL boom"}')).toEqual({
      code: 1,
      uptimeMs: 12500,
      stderr: 'FATAL boom'
    })
    expect(parseCoreExit('\ufeff{"code":0}').code).toBe(0)
  })
  it('garbage gives no details rather than an error', () => {
    const empty = { code: null, uptimeMs: null, stderr: '' }
    expect(parseCoreExit('')).toEqual(empty)
    expect(parseCoreExit('1')).toEqual(empty)
    expect(parseCoreExit('{"code":"x","stderr":5}')).toEqual(empty)
  })
})

describe('hasTunAdapter', () => {
  it('looks for our address on any interface', () => {
    expect(hasTunAdapter({ Ethernet: [{ address: '192.168.1.5' }] }, '172.19.0.1')).toBe(false)
    expect(
      hasTunAdapter(
        {
          Ethernet: [{ address: '192.168.1.5' }],
          CipherWay: [{ address: 'fdfe::1' }, { address: '172.19.0.1' }]
        },
        '172.19.0.1'
      )
    ).toBe(true)
    expect(hasTunAdapter({ x: undefined }, '172.19.0.1')).toBe(false)
  })
})
