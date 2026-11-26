import { describe, expect, it } from 'vitest'
import { DPI_ALL } from '../core/coreNames'
import {
  CYGWIN_DIR_SDDL,
  cygwinKey,
  DPI_NO_HOST,
  dpiBrokerScript,
  ipPlansPs,
  parseDpiState,
  plansPs,
  servicesPs,
  type DpiHashes
} from './dpiBroker'
import { STRATEGIES } from './strategies'
import { SERVICE_DEFS } from './lists'

const SID = 'S-1-5-21-1000000001-1000000002-1000000003-1001'
const HASHES = Object.fromEntries(DPI_ALL.map((f, i) => [f, String(i).repeat(64)])) as DpiHashes
const APP = "C:\\Users\\O'Neil\\AppData\\Local\\Programs\\CipherWay VPN\\CipherWay VPN.exe"

describe('dpiBrokerScript', () => {
  const P = {
    sid: SID,
    userRunDir: "C:\\Users\\O'Neil\\AppData\\run",
    appExe: APP,
    hashes: HASHES
  }
  const ps = dpiBrokerScript(P)

  it('pins every file of zapret by its hash; they live in the admin-only <Root>\\dpi\\bin', () => {
    for (const f of DPI_ALL) expect(ps).toContain(`'${f}' = '${HASHES[f]}'`)
    expect(ps).toContain("$DpiRoot = Join-Path $Root 'dpi'")
    expect(ps).toContain("$DpiBin = Join-Path $DpiRoot 'bin'")
    expect(ps).toContain("$Exe = Join-Path $DpiBin 'cipherway-dpi.exe'")
    expect(ps).toContain('(Sha (Join-Path $DpiBin $k)) -ne $Hashes[$k]')
    // Cygwin's root: no etc / tmp, nobody but SYSTEM / Administrators (checked in production)
    expect(ps).toContain("foreach ($n in @('etc', 'tmp'))")
    expect(ps).toContain('$CheckAcl = $true')
    expect(ps).toContain("$Trusted = @('S-1-5-18', 'S-1-5-32-544')")
    expect(ps).toContain('$Trusted -notcontains $r.IdentityReference.Value')
  })

  it("the strategy table, the service domains and Discord's ranges are baked in", () => {
    for (const s of STRATEGIES) {
      expect(ps).toContain(`'${s.id}|0' = @(`)
      expect(ps).toContain(`'${s.id}|1' = @(`)
    }
    expect(servicesPs()).toContain("'youtube' = @('youtube.com'")
    expect(servicesPs()).toContain("'discord.media'")
    expect(plansPs()).not.toMatch(/[A-Za-z]:\\/)
    expect(plansPs()).toContain("'--ipset=%DISCORD_IPS%'")
    expect(ps).toContain(`$DiscordIps = @('${SERVICE_DEFS.discord.cidrs[0]}'`)
    expect(ps).toContain(".Replace('%DISCORD_IPS%', $DiscordF)")
    // 0.7.2: the user's IP rules — their own profiles, appended only for a non-empty ipset
    for (const s of STRATEGIES) expect(ipPlansPs()).toContain(`'${s.id}' = @('--new'`)
    expect(ipPlansPs()).not.toMatch(/%HOSTS%|[A-Za-z]:\\/)
    expect(ps).toContain('if ($l.ips.Count -gt 0) {')
    expect(ps).toContain(".Replace('%USER_IPS%', $IpsF)")
    expect(ps).toContain(`$NoHost = '${DPI_NO_HOST}'`)
  })

  it('TCP timestamps: two fixed netsh calls, exit code checked, read back; only by the lock holder', () => {
    expect(ps).toContain("$Netsh = Join-Path ([Environment]::GetFolderPath('System')) 'netsh.exe'")
    expect(ps).not.toContain('$env:SystemRoot')
    expect(ps).toContain("$si.Arguments = 'interface tcp set global timestamps=' + $v")
    expect(ps).toContain("if ($v -cne 'enabled' -and $v -cne 'disabled') { return $false }")
    expect(ps).toContain('return ($pr.ExitCode -eq 0)')
    expect(ps).not.toMatch(/netsh[^\n]*2>&1/)
    // read through CIM (the template applied to Internet connections), not localized text
    expect(ps).toContain(
      `-ClassName 'MSFT_NetTCPSetting' -Filter "SettingName='Internet'"`
    )
    expect(ps).toContain("$TsF = Join-Path $Tmp 'dpi-tcp-ts.txt'")
    // already on: nothing touched, no marker
    expect(ps).toContain("if ((Tcp-Ts) -ne 'Disabled') { return }")
    // the marker goes only after a confirmed return
    expect(ps).toContain("if (-not $ok -or (Tcp-Ts) -ne $orig) {")
    expect(ps).toContain('$TcpTs = $true')
    expect(ps.indexOf('  Enable-TcpTs\n')).toBeGreaterThan(ps.indexOf('$lock = Take-Lock'))
    expect(ps).toContain('if ($null -ne $lock) { Restore-TcpTs }')
    // cleanup / no request: put back if the lock is free
    expect(ps).toMatch(/Stop-Orphan\n\s+Restore-IfIdle\n\s+\$State.status = 'stopped'/)
    expect(ps).toMatch(/Restore-IfIdle\n\s+\$State.status = 'refused'/)
    // tests (a temp root) never touch the computer's setting; a fake only on request
    expect(dpiBrokerScript({ ...P, rootOverride: 'C:\\tmp\\x' })).toContain('$TcpTs = $false')
    expect(() =>
      dpiBrokerScript({ ...P, tcpTsTest: { netsh: 'C:\\x\\n.cmd', stateFile: 'C:\\x\\s' } })
    ).toThrow()
  })

  it('patterns use [0-9], never \\d (a Unicode digit is not a digit here)', () => {
    const pats = [...ps.matchAll(/\$(V4Re|V6Re) = '([^']+)'/g)].map((m) => m[2])
    expect(pats).toHaveLength(2)
    for (const s of pats) expect(s).not.toContain('\\d')
    const v4 = new RegExp(pats[0].replace(/\\z/g, '$(?![\\s\\S])'))
    expect(v4.test('198.51.100.0/24')).toBe(true)
    // Arabic-Indic / full-width digits
    expect(v4.test('١٩٨.51.100.0/24')).toBe(false)
    expect(v4.test('198.51.100.0/２４')).toBe(false)
    expect(ps).toContain('function Test-UserIp([string]$s) {')
    expect(ps).toContain("if (-not ($x -is [string]) -or -not (Test-UserIp $x)) { throw 'cw-bad_request адрес' }")
  })

  it('every pattern is anchored with \\z: a value ending in a newline never matches', () => {
    const anchors = [...ps.matchAll(/\$(DomRe|V4Re|V6Re|IdRe) = '([^']+)'/g)]
    expect(anchors.map((m) => m[1])).toEqual(['DomRe', 'V4Re', 'V6Re', 'IdRe'])
    for (const m of anchors) {
      expect(m[2].endsWith('\\z')).toBe(true)
      expect(m[2]).not.toMatch(/\$(\)|$)/)
    }
    // the same semantics in JS: \z = end of input, a trailing \n is not «the end»
    const dom = new RegExp(anchors[0][2].replace(/\\z/g, '$(?![\\s\\S])'))
    expect(dom.test('example.org')).toBe(true)
    expect(dom.test('example.org\n')).toBe(false)
    // the request's session (shared helpers)
    expect(ps).toContain("$c.session -cnotmatch '^[0-9a-f]{16,64}\\z'")
  })

  it('a refused value is never put into an error, the state or the log', () => {
    expect(ps).toContain("throw 'cw-bad_request стратегия'")
    expect(ps).not.toMatch(/throw \('cw-bad_request[^']*' \+/)
    // numbers of the request are read without a cast that would quote them
    expect(ps).toContain('(Num $ctl.ts)')
    expect(ps).toContain('$gen = Num $ctl.gen')
  })

  it('public suffixes are refused as own domains', () => {
    expect(ps).toContain('$PublicSuffixes -ccontains $d')
    expect(ps).toMatch(/\$PublicSuffixes = @\([^)]*'com\.ru'/)
  })

  it('the user folder: never through a link, files checked by their final path', () => {
    expect(ps).toContain("if (Is-Reparse $UserRun) { throw 'cw-failed папка приложения — ссылка' }")
    expect(ps).toContain(
      "if (Is-Reparse $UserRun) { $State.stopReason = 'папка приложения стала ссылкой'; break }"
    )
    expect(ps).toContain('GetFinalPathNameByHandleW')
    // the broker's own Read-UserFile comes after (and replaces) the shared one
    expect(ps.lastIndexOf('function Read-UserFile')).toBeGreaterThan(
      ps.indexOf('function Read-Ctl')
    )
    // read into max+1 bytes: more = refused
    expect(ps).toContain('return (Read-Bounded $fs $max)')
    expect(ps).toContain('$buf = New-Object byte[] ($max + 1)')
    expect(ps).toContain('if ($n -gt $max) { return $null }')
  })

  it('Windows functions: declared in memory (Reflection.Emit), never compiled — inside the try', () => {
    expect(ps).not.toContain('Add-Type')
    expect(ps).not.toContain('$env:TEMP')
    expect(ps).toContain('DefinePInvokeMethod')
    expect(ps.indexOf('$Native = New-Native')).toBeGreaterThan(ps.indexOf('\n$dpi = $null\ntry {'))
    expect(ps).toContain("} catch { throw 'cw-failed не удалось подготовить системные функции' }")
  })

  it('the app: a live process of exactly our exe, owned by this user', () => {
    expect(ps).toContain(
      "$AppExe = 'C:\\Users\\O''Neil\\AppData\\Local\\Programs\\CipherWay VPN\\CipherWay VPN.exe'"
    )
    expect(ps).toContain('$p.MainModule.FileName -ine $AppExe')
    expect(ps).toContain('-MethodName GetOwnerSid).Sid -eq $Sid')
    expect(ps).toContain('(App-Alive $ctl.pid)')
    expect(ps).toContain('(App-Alive $c.pid)')
    expect(ps).not.toContain('(Alive $c.pid)')
  })

  it("one winws per computer (a lock file in the admin-only tmp), an orphan only if it carries this user's hostlist", () => {
    expect(ps).not.toMatch(/Mutex/)
    expect(ps).toContain("$LockF = Join-Path $Tmp 'dpi.lock'")
    expect(ps).toContain(
      '[IO.File]::Open($LockF, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)'
    )
    expect(ps).toMatch(/Prepare-Tmp\s+\$lock = Take-Lock/)
    expect(ps).toContain('Test-AdminOnly $Tmp')
    expect(ps).toContain(`$cl.IndexOf('"--hostlist=' + $HostsF + '"'`)
    expect(ps).toMatch(/if \(Is-OurDpi \$o\)/)
    // the orphan's pid is read before this broker's first Save-State replaces it
    expect(ps).toMatch(/\n {2}Stop-Orphan\n[^\n]*\n {2}Save-State\n {2}\$busy = Foreign-Dpi/)
  })

  it('another DPI bypass / our winws elsewhere: only processes with admin rights / of SYSTEM count', () => {
    expect(ps).toContain('if ($null -ne $r -and $r.admin) { return')
    expect(ps).toContain('if ($null -ne $r -and $r.system) { $n++ }')
    expect(ps).toContain('[Security.Principal.WindowsBuiltInRole]::Administrator')
  })

  it("Cygwin's object directory: created first with SYSTEM / Administrators only, a foreign one refused", () => {
    expect(ps).toContain(`$CygwinSddl = '${CYGWIN_DIR_SDDL}'`)
    expect(CYGWIN_DIR_SDDL).toBe('D:P(A;;GA;;;SY)(A;;GA;;;BA)')
    expect(ps).toContain("$name = 'cygwin1S5-' + (Cygwin-Key (Join-Path $DpiBin 'cygwin1.dll'))")
    expect(ps).toContain('if ($Trusted -contains $own) { return $o.handle }')
    expect(ps).toContain("Refuse 'foreign_dpi' 'служебные объекты Cygwin заняты другой программой'")
    // held while the broker runs, closed at the end
    expect(ps).toContain('$null = $Native::NtClose($cygDir)')
  })

  it('the Cygwin key = what cygwin1.dll 3.4.10 really uses (checked on a live winws)', () => {
    // seen as \BaseNamedObjects\cygwin1S5-2b927ab2bb5c61cd while winws ran from resources\bin
    expect(
      cygwinKey('\\\\?\\E:\\Development\\Projects\\MAINVPN\\VPN\\resources\\bin\\cygwin1.dll')
    ).toBe('2b927ab2bb5c61cd')
    expect(cygwinKey('\\\\?\\C:\\ProgramData\\CipherWay\\dpi\\bin\\cygwin1.dll')).toMatch(
      /^[0-9a-f]{16}$/
    )
  })

  it('the catch: fixed texts only, never an exception text', () => {
    expect(ps).toContain("$State.detail = 'внутренняя ошибка службы zapret'")
    expect(ps).not.toMatch(/\$State\.detail = \$msg/)
    expect(ps).toContain(
      "Note ('ошибка: ' + $State.detail + ' (' + $_.Exception.GetType().Name + ')')"
    )
  })

  it('a WinDivert driver of another program is refused; ours (or its renamed copy) is not', () => {
    expect(ps).toContain(`Get-CimInstance Win32_SystemDriver -Filter "Name LIKE 'WinDivert%'"`)
    expect(ps).toContain("return 'драйвер WinDivert другой программы'")
    expect(ps).toContain("$pn.Substring($f.Length + 5) -cmatch '^[0-9a-f]{32}\\z'")
  })

  it('the adapter: our TUN / LAN skipped, an on-link (PPPoE) default route accepted', () => {
    expect(ps).toContain("$TunNames = @('CipherWay', 'CipherWay LAN')")
    expect(ps).not.toContain("NextHop -ne '0.0.0.0'")
  })

  it('production: the real root, no dry-run, no compat layer', () => {
    expect(ps).toContain('$DryRun = $false')
    expect(ps).not.toContain('__COMPAT_LAYER = ')
    expect(ps).toContain(
      "Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'CipherWay'"
    )
  })

  it('refuses a bad sid / hash / app exe / object DACL', () => {
    const base = { sid: SID, userRunDir: 'x', appExe: APP, hashes: HASHES }
    expect(() => dpiBrokerScript({ ...base, sid: 'S-1-5-32-544' })).toThrow()
    expect(() => dpiBrokerScript({ ...base, hashes: { ...HASHES, 'cygwin1.dll': 'zz' } })).toThrow()
    expect(() => dpiBrokerScript({ ...base, appExe: 'C:\\x.exe"; calc' })).toThrow()
    expect(() => dpiBrokerScript({ ...base, appExe: 'relative.exe' })).toThrow()
    expect(() => dpiBrokerScript({ ...base, cygwinDirSddl: 'D:P(A;;GA;;;WD)' })).toThrow()
    expect(() => dpiBrokerScript({ ...base, cygwinDirSddl: "D:P(A;;GA;;;SY)')" })).toThrow()
  })
})

describe('parseDpiState', () => {
  it('known fields only; garbage → null / undefined', () => {
    expect(
      parseDpiState(
        '\ufeff{"session":"ab","status":"running","gen":2,"strategy":"sniext","ifIdx":17,"dpiPid":42,"wait":"","error":"","exitCode":null,"ts":5}'
      )
    ).toMatchObject({ session: 'ab', status: 'running', gen: 2, ifIdx: 17, dpiPid: 42, wait: '' })
    expect(parseDpiState('{"status":"pwned","error":"x","wait":"y"}')).toMatchObject({
      status: undefined,
      error: undefined,
      wait: undefined
    })
    expect(parseDpiState('{half')).toBeNull()
  })
})
