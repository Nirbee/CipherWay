import { describe, expect, it } from 'vitest'
import {
  brokerScript,
  hasTunAdapter,
  parseCoreExit,
  psGuid,
  psQuote,
  WINTUN_DEVICE_PS,
  wintunGuid
} from './broker'
import { TAILSCALE_ADAPTER_GUID } from './coreNames'

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
    // PowerShell also ends a single-quoted string at ‘ ’ ‚ ‛ — doubled too
    expect(psQuote('a\u2018b\u2019c\u201ad\u201be')).toBe(
      "'a\u2018\u2018b\u2019\u2019c\u201a\u201ad\u201b\u201be'"
    )
    expect(psQuote("C:\\Users\\O\u2019Brien'; calc; '")).toBe(
      "'C:\\Users\\O\u2019\u2019Brien''; calc; '''"
    )
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

  it('…and the device a killed core left behind (only our GUID)', () => {
    expect(script).toContain("$TunGuid = '{3D56CD02-D8B1-21DE-B21B-2D7CFA71C8E3}'")
    expect(script).toMatch(
      /function Clear-StaleAdapter \{\s+Clear-StaleNamed\s+Remove-WintunGhost \$TunGuid\s+\}/
    )
    expect(script).toContain(WINTUN_DEVICE_PS)
    // a test adapter name gets its own GUID: tests never touch the real device
    const other = brokerScript({
      exe: 'C:\\x.exe',
      config: 'C:\\c.json',
      workDir: 'C:\\w',
      stopFile: 'C:\\s',
      restartFile: 'C:\\r',
      exitFile: 'C:\\e',
      parentPid: 1,
      tunName: 'CipherWay E2E'
    })
    expect(other).toContain(`$TunGuid = '${wintunGuid('CipherWay E2E')}'`)
    expect(other).not.toContain('3D56CD02')
  })
})

describe('wintun device of our adapters', () => {
  it('GUID of an adapter name = what sing-tun asks wintun for', () => {
    // the «CipherWay» adapter on a real PC: Get-NetAdapter InterfaceGuid
    expect(wintunGuid('CipherWay')).toBe('{3D56CD02-D8B1-21DE-B21B-2D7CFA71C8E3}')
    expect(wintunGuid('CipherWay LAN')).not.toBe(wintunGuid('CipherWay'))
    expect(wintunGuid('x')).toMatch(/^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/)
  })

  it('only a well-formed GUID gets into a script', () => {
    expect(psGuid(TAILSCALE_ADAPTER_GUID)).toBe("'{37217669-42DA-4657-A55B-0D995D328250}'")
    for (const bad of ["{1'; calc; '}", '37217669-42da-4657-a55b-0d995d328250', '{x}', ''])
      expect(() => psGuid(bad)).toThrow()
  })

  it('removes only a device that is registered but not present, by its exact id', () => {
    const ghost = WINTUN_DEVICE_PS.slice(WINTUN_DEVICE_PS.indexOf('function Remove-WintunGhost'))
    expect(ghost).toMatch(/if \(-not \(Wintun-Known \$guid\)\) \{ return \}/)
    expect(ghost).toMatch(/if \(Wintun-Present \$guid\) \{ return \}/)
    expect(ghost).toContain("'pnputil.exe') '/remove-device' $id")
    expect(ghost.indexOf('if (Wintun-Present $guid) { return }')).toBeLessThan(
      ghost.indexOf("'/remove-device'")
    )
    expect(WINTUN_DEVICE_PS).toContain(
      "function Wintun-Id([string]$guid) { return ('SWD\\Wintun\\' + $guid) }"
    )
    expect(WINTUN_DEVICE_PS).toContain(
      "OpenSubKey('SYSTEM\\CurrentControlSet\\Enum\\' + (Wintun-Id $guid))"
    )
    // WQL needs the backslashes doubled
    expect(WINTUN_DEVICE_PS).toContain(".Replace('\\', '\\\\')")
  })

  it('«being created» = the device is there but the interface is not', () => {
    const fn = WINTUN_DEVICE_PS.slice(WINTUN_DEVICE_PS.indexOf('function Wintun-Creating'))
    expect(fn).toMatch(
      /if \(\$n\.Name -eq \$name\) \{ return \$false \}[\s\S]*return \(Wintun-Present \$guid\)/
    )
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
