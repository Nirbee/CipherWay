import { describe, expect, it } from 'vitest'
import { brokerScript, hasTunAdapter, psQuote } from './broker'

describe('TUN broker script', () => {
  const script = brokerScript({
    exe: 'C:\\Program Files\\CipherWay VPN\\resources\\bin\\sing-box.exe',
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
      /if \(Test-Path \$restart\)[\s\S]*Stop-Process -Id \$p\.Id -Force[\s\S]*\$p = Start-Core/
    )
  })

  it('reports a core that died on its own, and dies with the app', () => {
    expect(script).toContain('Set-Content -Path $exitf -Value $p.ExitCode')
    expect(script).toContain('$parent = 4242')
    expect(script).toContain('Get-Process -Id $parent')
    // keeps the process handle so ExitCode is readable after the exit
    expect(script).toContain('$null = $c.Handle')
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
