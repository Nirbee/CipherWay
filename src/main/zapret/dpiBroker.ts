import { psQuote } from '../core/broker'
import {
  DPI_ALL,
  DPI_EXE,
  DPI_FAKE_QUIC,
  DPI_FAKE_TLS,
  FOREIGN_DPI_PROCESSES,
  FOREIGN_DPI_SERVICES,
  LAN_TUN_NAME,
  TUN_INTERFACE
} from '../core/coreNames'
import { BROKER_HELPERS_PS, HASH_RE, isValidSid, rootExpr } from '../core/serviceScripts'
import { PUBLIC_SUFFIXES, ZAPRET_CUSTOM_MAX, ZAPRET_SERVICE_IDS } from '@shared/zapret'
import { SERVICE_DEFS } from './lists'
import {
  STRATEGIES,
  tokenProblems,
  userIpTokens,
  WF_MAX_TESTS,
  wfParts,
  winwsTokens
} from './strategies'

// ---------------------------------------------------------------------------
// «Ускорение без VPN (zapret)» (0.7.0): winws needs SYSTEM rights (it opens
// the WinDivert driver). It runs through the same «Служба CipherWay» as the TUN
// core and LAN: a third Task Scheduler task «CipherWay DPI <SID>», registered
// by the same installer (one UAC prompt), runs this broker as SYSTEM.
//
// Threat model — what crosses from the user's side to SYSTEM, and how it is
// checked (nothing else does):
//  * the program: only <Root>\dpi\bin\cipherway-dpi.exe and its files
//    (WinDivert.dll, WinDivert64.sys, cygwin1.dll, two fake payloads) — copies
//    the installer made into a folder of SYSTEM / Administrators only: users
//    can't read or run them, so no user process loads THIS cygwin1.dll.
//    cygwin1.dll takes <Root>\dpi as the Cygwin root (etc\fstab, passwd…):
//    admin-only too, the broker refuses to start if an etc / tmp appears in it.
//    The files' SHA-256 (= the pinned hashes of the zapret release, coreNames.ts
//    DPI_HASHES) are baked into this script and checked before every start.
//  * Cygwin's shared memory: cygwin1.dll keeps its shared state in the object
//    directory \BaseNamedObjects\cygwin1S5-<installation key> (key = a hash of
//    the DLL's path, Cygwin's init_installation_root / hash_path_name — checked
//    against the object a real cygwin1.dll 3.4.10 creates) and creates it with
//    access for Everyone. The broker creates that directory FIRST, with access
//    for SYSTEM / Administrators only, and holds it while it runs (Cygwin opens
//    an existing one — OBJ_OPENIF); one that already exists and is owned by
//    somebody else → refused (`foreign_dpi`). RESIDUAL RISK: the sections
//    Cygwin creates inside (shared.5…) still get an Everyone DACL, and every
//    user has «bypass traverse checking» (SeChangeNotifyPrivilege): who knows
//    the full name can open such a section directly, past the directory's DACL.
//    The name needs the key (derivable from the public path), so a local user
//    could write into the shared state of the SYSTEM winws. There is no other
//    winws build (only the Cygwin one); the window is limited to processes of
//    this computer's users — documented, not solved.
//  * the request <userRun>\dpi-ctl.json {session, pid, cmd, gen, ts} (≤ 4 KB)
//    and the lists <userRun>\dpi-lists.json: read through a handle whose final
//    path (GetFinalPathNameByHandle) must be exactly the expected one, never
//    while <userRun> is a link, never more than the limit (read into max+1).
//    `cmd` ∈ run | stop | cleanup; a run needs a fresh request (< 2 min) from a
//    live process of the app: its exe must be the app's exe this broker was
//    installed with, its owner this user's SID. Numbers are range-checked
//    before any cast (Num) — a value never ends up in a message.
//  * the lists {gen, strategy, services, hosts, exclude} (≤ 256 KB, read only
//    when `gen` grows):
//      strategy — an id of the table below (baked in at install), else refused;
//      services — ids of the built-in services; their domains are baked in here;
//      hosts    — own domains: ≤ 200, each must match a strict lower-case domain
//                 pattern (labels a-z0-9-, ≤ 253 chars, a letter / xn-- TLD),
//                 not a public suffix (com.ru, github.io…);
//      exclude  — our VPN servers' addresses: ≤ 512 IPv4 / IPv6 / CIDR, parsed;
//      ips      — the user's «Напрямую + zapret» IP rules (0.7.2): the same
//                 format and check as exclude, ≤ 512; only lines of ips.txt;
//    every pattern is anchored with \z (a value ending in a newline fails);
//    anything else → the broker refuses (`bad_request`) and stops; the state
//    and the journal only ever get our own fixed texts.
//  * the command line is built HERE from the strategy table + its own paths:
//    the hostlist / ipset files are written by the broker into <home>\dpi
//    (user: read only), the user's strings only ever end up as lines of those
//    files, never as arguments. No path, option or file of the user reaches winws.
//    Discord's voice profile only acts on Discord's own ranges (an ipset).
//  * the WinDivert filter (0.7.3, --wf-raw-part=@<home>\dpi\windivert.txt): the
//    fixed parts of strategies.ts (wfParts, baked in) + our VPN servers'
//    addresses of `exclude`, each re-made from its numbers (Wf-Tests: octets /
//    the 16 bytes of the parsed address, masked) — never the request's text.
//    Their packets never reach winws (the tunnel is not slowed down by it).
//  * --wf-iface: the broker itself finds the adapter of the default route that
//    is not ours (not «CipherWay», not «CipherWay LAN»; an on-link route such as
//    PPPoE counts) — WinDivert must never touch packets inside the tunnel — and
//    restarts winws when it changes (another network).
//  * never next to another DPI bypass: a winws.exe / goodbyedpi.exe running
//    with admin rights (SYSTEM or an elevated token — WinDivert needs them; a
//    renamed program of a plain user does not count), a «zapret» / «GoodbyeDPI»
//    service, a WinDivert driver that is not our file → refused (`foreign_dpi`),
//    and ours stops when one appears. One winws of ours per computer: a lock
//    file in the admin-only <Root>\tmp, held open while the broker runs; another
//    Windows user's one → `dpi_busy`.
//  * winws stops with the broker: «stop», a new session, the app gone, the
//    request file gone; a winws left by an earlier broker is killed first thing
//    (before this broker's state replaces the file with its pid) or by
//    `cleanup` — only that pid, only if it runs our file AND has this user's
//    hostlist in its command line.
//  * TCP timestamps (0.7.2; the «ts» strategies fool the DPI with them): turned
//    on with ONE fixed command (netsh … timestamps=enabled) when Windows has
//    them off, by the broker that holds the lock; the original value is
//    remembered in the admin-only <Root>\tmp\dpi-tcp-ts.txt and put back when
//    that broker ends (and by the service removal). A failure is only noted.
//  * Windows functions (final path, object directories, process tokens) are
//    declared in memory with Reflection.Emit — no csc, no temporary files.
// Talking to the app (files, the broker polls every 500 ms):
//   <userRun>\dpi-ctl.json, dpi-lists.json  app → broker
//   <home>\dpi-state.json  broker → app {session,status,gen,strategy,ifIdx,ifName,
//                          dpiPid,wait,exitCode,output,error,detail,stopReason,ts}
//   <home>\dpi-out.log / dpi-err.log  winws output;  <home>\dpi-broker.log  what the broker did
// Pure — unit tested in dpiBroker.test.ts, the broker itself runs (non-elevated,
// a fake winws and the real one with --dry-run) in dpiBroker.it.test.ts.
// ---------------------------------------------------------------------------

export type DpiHashes = Record<(typeof DPI_ALL)[number], string>

/** «another DPI bypass is running»: what the broker looks for (tests: fake names) */
export interface ForeignDpi {
  processes: readonly string[]
  services: readonly string[]
}

export const OFFICIAL_FOREIGN: ForeignDpi = {
  processes: FOREIGN_DPI_PROCESSES,
  services: FOREIGN_DPI_SERVICES
}

/** access to Cygwin's object directory: SYSTEM / Administrators only */
export const CYGWIN_DIR_SDDL = 'D:P(A;;GA;;;SY)(A;;GA;;;BA)'

export interface DpiBrokerParams {
  sid: string
  /** the app's run folder (dpi-ctl.json, dpi-lists.json) — read only */
  userRunDir: string
  /**
   * the app's exe (process.execPath at install: CipherWay VPN.exe, electron.exe
   * in dev) — the request's pid must be a process of exactly this file
   */
  appExe: string
  hashes: DpiHashes
  /** tests only: a temp folder instead of %ProgramData%\CipherWay */
  rootOverride?: string
  /** tests only */
  foreign?: ForeignDpi
  /** tests only: start winws with --dry-run appended (it checks the line and exits) */
  dryRun?: boolean
  /**
   * tests only: TCP timestamps through a fake — `netsh` is run instead of the
   * real one, the «Windows setting» is the text of `stateFile` (enabled / disabled)
   */
  tcpTsTest?: { netsh: string; stateFile: string }
  /**
   * tests only: the DACL of Cygwin's object directory — a non-elevated test
   * winws needs its own user in it (production: CYGWIN_DIR_SDDL)
   */
  cygwinDirSddl?: string
}

/** Broker error codes in dpi-state.json (the app turns them into Russian text). */
export type DpiBrokerError =
  '' | 'no_request' | 'foreign_dpi' | 'dpi_busy' | 'bad_request' | 'exited' | 'failed'

/** why the broker runs without winws right now */
export type DpiWait = '' | 'no_network' | 'no_hosts' | 'exited'

/** the most lists a request may carry (the broker refuses more) */
export const DPI_MAX_HOSTS = ZAPRET_CUSTOM_MAX
export const DPI_MAX_EXCLUDE = 512

/** LAN ranges zapret never touches (winws filters them too — belt and braces) */
const ALWAYS_EXCLUDE = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  'fc00::/7',
  'fe80::/10'
]

const psList = (xs: readonly string[]): string => `@(${xs.map(psQuote).join(', ')})`

/** `$Plans`: strategy id + `|0` / `|1` (Discord profiles off / on) → tokens with placeholders. */
export function plansPs(): string {
  const rows: string[] = []
  for (const s of STRATEGIES) {
    if (!/^[a-z0-9-]{1,40}$/.test(s.id)) throw new Error(`bad strategy id ${s.id}`)
    for (const discord of [false, true]) {
      const tokens = winwsTokens(s, discord)
      const bad = tokenProblems(tokens)
      if (bad.length) throw new Error(`bad token in ${s.id}: ${bad.join(' ')}`)
      rows.push(`  ${psQuote(`${s.id}|${discord ? 1 : 0}`)} = ${psList(tokens)}`)
    }
  }
  return `@{\n${rows.join('\n')}\n}`
}

/** `$WfOut` / `$WfIn`: `0` / `1` (Discord off / on) → the fixed parts of our WinDivert filter. */
export function wfPartsPs(): { out: string; in: string } {
  const row = (k: 'out' | 'in'): string =>
    `@{ '0' = ${psQuote(wfParts(false)[k])}; '1' = ${psQuote(wfParts(true)[k])} }`
  for (const d of [false, true]) {
    const p = wfParts(d)
    // only the WinDivert words, numbers and operators — never a path or a quote
    for (const s of [p.out, p.in]) {
      if (!/^[a-zA-Z0-9 .()=<>![\]]+$/.test(s)) throw new Error('bad filter part')
    }
  }
  return { out: row('out'), in: row('in') }
}

/** `$IpPlans`: strategy id → the profiles of the user's IP rules (appended when ips.txt is not empty). */
export function ipPlansPs(): string {
  const rows: string[] = []
  for (const s of STRATEGIES) {
    const tokens = userIpTokens(s)
    const bad = tokenProblems(tokens)
    if (bad.length) throw new Error(`bad token in ${s.id}: ${bad.join(' ')}`)
    rows.push(`  ${psQuote(s.id)} = ${psList(tokens)}`)
  }
  return `@{\n${rows.join('\n')}\n}`
}

/** a hostlist entry that never matches: the hostlist profiles stay inert when only IP rules are on */
export const DPI_NO_HOST = 'none.cipherway.invalid'

/** `$ServiceDomains`: built-in service id → its domains (the hostlist part the user can't change). */
export function servicesPs(): string {
  const rows = ZAPRET_SERVICE_IDS.map(
    (id) => `  ${psQuote(id)} = ${psList(SERVICE_DEFS[id].domains)}`
  )
  return `@{\n${rows.join('\n')}\n}`
}

/**
 * Cygwin's installation key of a cygwin1.dll (winsup/cygwin/mm/cygheap.cc
 * init_installation_root + path.cc hash_path_name + strfuncs.cc
 * RtlInt64ToHexUnicodeString): the DLL's final path as `\??\C:\…\cygwin1.dll`,
 * folded as hash = upcase(ch) + (hash << 6) + (hash << 16) − hash (64 bit),
 * 16 lower-case hex digits. Its shared objects live in
 * \BaseNamedObjects\cygwin1S5-<key>. The broker computes the same in
 * PowerShell (CYGWIN_KEY_PS); this one is for the tests.
 */
export function cygwinKey(finalPath: string): string {
  const p = finalPath.startsWith('\\\\?\\') ? `\\??\\${finalPath.slice(4)}` : finalPath
  const mask = (1n << 64n) - 1n
  let h = 0n
  for (const ch of p) {
    const u = BigInt(ch.toUpperCase().charCodeAt(0))
    h = (u + (h << 6n) + (h << 16n) - h) & mask
  }
  return h.toString(16).padStart(16, '0')
}

/**
 * PowerShell: the adapter winws watches — the default route with the lowest
 * metric that is not ours. An on-link default route counts (PPPoE of
 * Rostelecom & co: no gateway address); only our own adapters are skipped.
 * Expects $TunNames. Unit tested on its own (dpiBroker.it.test.ts).
 */
export const PICK_IF_PS = `
function Pick-If($routes) {
  $r = @($routes | Where-Object { $null -ne $_ -and $TunNames -notcontains [string]$_.InterfaceAlias } |
    Sort-Object { [long]$_.RouteMetric + [long]$_.InterfaceMetric })
  if ($r.Count -eq 0) { return $null }
  return @{ idx = [int]$r[0].ifIndex; name = [string]$r[0].InterfaceAlias }
}
`.trim()

/**
 * PowerShell: the Windows functions the broker needs, declared in memory
 * (Reflection.Emit + DefinePInvokeMethod): no Add-Type, no csc, no temporary
 * files. Sets $Native. Structures are laid out by hand (x64).
 */
export const NATIVE_PS = `
function New-Native {
  $an = New-Object Reflection.AssemblyName('CipherWayNative')
  $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly($an, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $tb = $ab.DefineDynamicModule('CipherWayNative').DefineType('CipherWayNative', [Reflection.TypeAttributes]'Public, Class, Sealed, Abstract')
  $attr = [Reflection.MethodAttributes]'Public, Static, PinvokeImpl'
  $def = {
    param([string]$dll, [string]$name, [type]$ret, [type[]]$params)
    $m = $tb.DefinePInvokeMethod($name, $dll, $attr, [Reflection.CallingConventions]::Standard, $ret, $params, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  & $def 'kernel32.dll' 'GetFinalPathNameByHandleW' ([uint32]) @([IntPtr], [Text.StringBuilder], [uint32], [uint32])
  & $def 'ntdll.dll' 'NtCreateDirectoryObject' ([int]) @([IntPtr], [uint32], [IntPtr])
  & $def 'ntdll.dll' 'NtOpenDirectoryObject' ([int]) @([IntPtr], [uint32], [IntPtr])
  & $def 'ntdll.dll' 'NtClose' ([int]) @([IntPtr])
  & $def 'advapi32.dll' 'GetSecurityInfo' ([uint32]) @([IntPtr], [int], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr])
  & $def 'kernel32.dll' 'LocalFree' ([IntPtr]) @([IntPtr])
  & $def 'kernel32.dll' 'OpenProcess' ([IntPtr]) @([uint32], [int], [uint32])
  & $def 'advapi32.dll' 'OpenProcessToken' ([int]) @([IntPtr], [uint32], [IntPtr])
  & $def 'kernel32.dll' 'CloseHandle' ([int]) @([IntPtr])
  return $tb.CreateType()
}
$Native = New-Native
$Mem = [Runtime.InteropServices.Marshal]
function Final-Of($fs) {
  $b = New-Object Text.StringBuilder(1024)
  $r = $Native::GetFinalPathNameByHandleW($fs.SafeFileHandle.DangerousGetHandle(), $b, 1024, 0)
  if ($r -eq 0 -or $r -ge 1024) { return $null }
  return $b.ToString()
}
# \\BaseNamedObjects\\<name>: create it with $sddl, or open it to read its owner
function Object-Dir([string]$name, [string]$sddl) {
  $full = '\\BaseNamedObjects\\' + $name
  $buf = $Mem::StringToHGlobalUni($full)
  $us = $Mem::AllocHGlobal(16)
  $oa = $Mem::AllocHGlobal(48)
  $hp = $Mem::AllocHGlobal(8)
  $sd = [IntPtr]::Zero
  try {
    $Mem::WriteInt16($us, 0, [int16]($full.Length * 2))
    $Mem::WriteInt16($us, 2, [int16]($full.Length * 2 + 2))
    $Mem::WriteInt32($us, 4, 0)
    $Mem::WriteIntPtr($us, 8, $buf)
    for ($i = 0; $i -lt 48; $i += 8) { $Mem::WriteInt64($oa, $i, 0) }
    $Mem::WriteInt32($oa, 0, 48)
    $Mem::WriteIntPtr($oa, 16, $us)
    $Mem::WriteInt32($oa, 24, 0x40)
    $Mem::WriteInt64($hp, 0, 0)
    if ($sddl) {
      $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
      $bin = New-Object byte[] $raw.BinaryLength
      $raw.GetBinaryForm($bin, 0)
      $sd = $Mem::AllocHGlobal($bin.Length)
      $Mem::Copy($bin, 0, $sd, $bin.Length)
      $Mem::WriteIntPtr($oa, 32, $sd)
      $st = $Native::NtCreateDirectoryObject($hp, 0xF000F, $oa)
    } else {
      $st = $Native::NtOpenDirectoryObject($hp, 0x20000, $oa)
    }
    return @{ status = ('{0:X8}' -f $st); handle = $Mem::ReadIntPtr($hp) }
  } finally {
    foreach ($x in @($buf, $us, $oa, $hp, $sd)) { if ($x -ne [IntPtr]::Zero) { $Mem::FreeHGlobal($x) } }
  }
}
function Owner-Of-Handle([IntPtr]$h) {
  $po = $Mem::AllocHGlobal(8)
  $psd = $Mem::AllocHGlobal(8)
  try {
    if ($Native::GetSecurityInfo($h, 6, 1, $po, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, $psd) -ne 0) { return $null }
    $sid = (New-Object Security.Principal.SecurityIdentifier($Mem::ReadIntPtr($po))).Value
    $null = $Native::LocalFree($Mem::ReadIntPtr($psd))
    return $sid
  } finally { $Mem::FreeHGlobal($po); $Mem::FreeHGlobal($psd) }
}
# the token of a process: SYSTEM? administrator (elevated)? null = can't tell
function Proc-Rights([int]$id) {
  $h = $Native::OpenProcess(0x1000, 0, [uint32]$id)
  if ($h -eq [IntPtr]::Zero) { return $null }
  $tp = $Mem::AllocHGlobal(8)
  try {
    $Mem::WriteInt64($tp, 0, 0)
    # TOKEN_QUERY | TOKEN_DUPLICATE (IsInRole works on a duplicate of the token)
    if ($Native::OpenProcessToken($h, 0x000A, $tp) -eq 0) { return $null }
    $t = $Mem::ReadIntPtr($tp)
    try {
      $wi = New-Object Security.Principal.WindowsIdentity($t)
      try {
        $sys = $wi.User.Value -eq 'S-1-5-18'
        # an elevated administrator: the Administrators group enabled (its token owner, too)
        $adm = $wi.Owner.Value -eq 'S-1-5-32-544'
        try { $adm = $adm -or (New-Object Security.Principal.WindowsPrincipal($wi)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch {}
        return @{ system = $sys; admin = ($sys -or $adm) }
      } finally { $wi.Dispose() }
    } finally { $null = $Native::CloseHandle($t) }
  } catch { return $null
  } finally { $Mem::FreeHGlobal($tp); $null = $Native::CloseHandle($h) }
}
`.trim()

/**
 * PowerShell: Cygwin's installation key of a cygwin1.dll (see cygwinKey):
 * the same fold over the DLL's final path. Expects Final-Of.
 */
export const CYGWIN_KEY_PS = `
function Cygwin-Key([string]$dll) {
  $fs = New-Object IO.FileStream($dll, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try { $p = Final-Of $fs } finally { $fs.Dispose() }
  if (-not $p -or -not $p.StartsWith('\\\\?\\') -or $p.StartsWith('\\\\?\\UNC\\')) { throw 'cw-cygwin путь к cygwin1.dll не локальный' }
  $p = '\\??' + $p.Substring(3)
  $m = [Numerics.BigInteger]::Pow(2, 64)
  $h = [Numerics.BigInteger]::Zero
  foreach ($c in $p.ToCharArray()) {
    $h = ([int][char]::ToUpperInvariant($c) + ($h * 64) + ($h * 65536) - $h) % $m
    if ($h -lt 0) { $h += $m }
  }
  return ([uint64]$h).ToString('x16')
}
`.trim()

/**
 * PowerShell: read a file of the user's folder only if the handle really leads
 * to that path (no link / junction anywhere on the way: GetFinalPathNameByHandle)
 * and <userRun> itself is not a link; never more than $max bytes (Read-Bounded).
 * Overrides Read-UserFile of BROKER_HELPERS_PS. Expects NATIVE_PS.
 */
export const FINAL_PATH_PS = `
function Same-Path([string]$final, [string]$want) {
  if (-not $final) { return $false }
  if ($final.StartsWith('\\\\?\\UNC\\')) { $final = '\\\\' + $final.Substring(8) }
  elseif ($final.StartsWith('\\\\?\\')) { $final = $final.Substring(4) }
  return [string]::Equals($final, [IO.Path]::GetFullPath($want), [StringComparison]::OrdinalIgnoreCase)
}
function Read-UserFile([string]$p, [long]$max) {
  try {
    if (Is-Reparse $UserRun) { return $null }
    $fs = New-Object IO.FileStream($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
      if (-not (Same-Path (Final-Of $fs) $p)) { return $null }
      return (Read-Bounded $fs $max)
    } finally { $fs.Dispose() }
  } catch { return $null }
}
`.trim()

/** The SYSTEM-side DPI broker (installed into <home>\dpi-broker.ps1). */
export function dpiBrokerScript(p: DpiBrokerParams): string {
  if (!isValidSid(p.sid)) throw new Error('bad sid')
  for (const f of DPI_ALL) if (!HASH_RE.test(p.hashes[f] ?? '')) throw new Error('bad hash')
  if (!/^[A-Za-z]:\\[^"\r\n]*\.exe$/i.test(p.appExe)) throw new Error('bad app exe')
  if (p.tcpTsTest && !p.rootOverride) throw new Error('tcpTsTest is for tests only')
  const sddl = p.cygwinDirSddl ?? CYGWIN_DIR_SDDL
  if (!/^D:P(\(A;;GA;;;(SY|BA|S-1-5-21(-\d+){3,6})\))+$/.test(sddl)) throw new Error('bad sddl')
  const foreign = p.foreign ?? OFFICIAL_FOREIGN
  const hashes = DPI_ALL.map((f) => `${psQuote(f)} = ${psQuote(p.hashes[f])}`).join('; ')
  return `
# CipherWay VPN — DPI service broker («Ускорение без VPN»). Runs as SYSTEM from Task Scheduler.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$Sid = ${psQuote(p.sid)}
$UserRun = ${psQuote(p.userRunDir)}
$AppExe = ${psQuote(p.appExe)}
$Root = ${rootExpr(p.rootOverride)}
$Dir = Join-Path $Root ('u\\' + $Sid)
$LegacyBin = Join-Path $Root 'bin'
$DpiRoot = Join-Path $Root 'dpi'
$DpiBin = Join-Path $DpiRoot 'bin'
$Tmp = Join-Path $Root 'tmp'
$LockF = Join-Path $Tmp 'dpi.lock'
$Exe = Join-Path $DpiBin ${psQuote(DPI_EXE)}
$DpiDir = Join-Path $Dir 'dpi'
$HostsF = Join-Path $DpiDir 'hosts.txt'
$ExclF = Join-Path $DpiDir 'exclude.txt'
$DiscordF = Join-Path $DpiDir 'discord-ips.txt'
$IpsF = Join-Path $DpiDir 'ips.txt'
$WfF = Join-Path $DpiDir 'windivert.txt'
$NoHost = ${psQuote(DPI_NO_HOST)}
$TsF = Join-Path $Tmp 'dpi-tcp-ts.txt'
$TcpTs = ${!p.rootOverride || p.tcpTsTest ? '$true' : '$false'}
$Netsh = ${p.tcpTsTest ? psQuote(p.tcpTsTest.netsh) : "Join-Path ([Environment]::GetFolderPath('System')) 'netsh.exe'"}
$TcpTsTest = ${p.tcpTsTest ? psQuote(p.tcpTsTest.stateFile) : "''"}
$FakeTls = Join-Path $DpiBin ${psQuote(DPI_FAKE_TLS)}
$FakeQuic = Join-Path $DpiBin ${psQuote(DPI_FAKE_QUIC)}
$StateF = Join-Path $Dir 'dpi-state.json'
$BrokerLog = Join-Path $Dir 'dpi-broker.log'
$OutF = Join-Path $Dir 'dpi-out.log'
$ErrF = Join-Path $Dir 'dpi-err.log'
$CtlF = Join-Path $UserRun 'dpi-ctl.json'
$ListsF = Join-Path $UserRun 'dpi-lists.json'
$Hashes = @{ ${hashes} }
$Trusted = @('S-1-5-18', 'S-1-5-32-544')
$CygwinSddl = ${psQuote(sddl)}
$TunNames = ${psList([TUN_INTERFACE, LAN_TUN_NAME])}
$ForeignProc = ${psList(foreign.processes)}
$ForeignSvc = ${psList(foreign.services)}
$AlwaysExclude = ${psList(ALWAYS_EXCLUDE)}
$DiscordIps = ${psList(SERVICE_DEFS.discord.cidrs)}
$PublicSuffixes = ${psList(PUBLIC_SUFFIXES)}
$CheckAcl = ${p.rootOverride ? '$false' : '$true'}
$DryRun = ${p.dryRun ? '$true' : '$false'}
${
  // tests only: winws asks for admin rights in its manifest; --dry-run needs none
  p.dryRun ? "$env:__COMPAT_LAYER = 'RunAsInvoker'\n" : ''
}$MaxHosts = ${DPI_MAX_HOSTS}
$MaxExcl = ${DPI_MAX_EXCLUDE}
$DomRe = '^(?=.{4,253}\\z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})\\z'
$V4Re = '^([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})(/([0-9]{1,2}))?\\z'
$V6Re = '^[0-9a-f:.]{2,45}(/[0-9]{1,3})?\\z'
$IdRe = '^[a-z0-9-]{1,40}\\z'
$ServiceDomains = ${servicesPs()}
$Plans = ${plansPs()}
$IpPlans = ${ipPlansPs()}
$WfOut = ${wfPartsPs().out}
$WfIn = ${wfPartsPs().in}
$WfMax = ${WF_MAX_TESTS}
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$State = @{ session = ''; status = 'starting'; gen = 0; strategy = ''; ifIdx = 0; ifName = ''; dpiPid = 0; wait = ''; exitCode = $null; output = ''; error = ''; detail = ''; stopReason = ''; tcpTs = ''; wfExcl = 0; brokerPid = $PID; ts = 0 }
${BROKER_HELPERS_PS}
${PICK_IF_PS}
function Test-Cidr([string]$s) {
  if ($s -cmatch $V4Re) {
    for ($i = 1; $i -le 4; $i++) { if ([int]$Matches[$i] -gt 255) { return $false } }
    if ($Matches[6] -and [int]$Matches[6] -gt 32) { return $false }
    return $true
  }
  if ($s.Contains(':') -and $s -cmatch $V6Re) {
    $parts = $s.Split('/')
    $a = $null
    if (-not [Net.IPAddress]::TryParse($parts[0], [ref]$a)) { return $false }
    if ($a.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetworkV6) { return $false }
    if ($parts.Count -gt 1 -and [int]$parts[1] -gt 128) { return $false }
    return $true
  }
  return $false
}
# a user's «Напрямую + zapret» address: a range no wider than /8 (IPv4) or /32 (IPv6)
function Test-UserIp([string]$s) {
  if (-not (Test-Cidr $s)) { return $false }
  $parts = $s.Split('/')
  if ($parts.Count -lt 2) { return $true }
  $bits = [int]$parts[1]
  if ($s.Contains(':')) { return ($bits -ge 32) }
  return ($bits -ge 8)
}
# one validated exclusion (Test-Cidr) → the WinDivert tests that leave it out,
# made from its numbers: IPv4 octets as Test-Cidr reads them (decimal), IPv6 the
# 16 bytes of the parsed address; masked to the range, printed by us
function Wf-Tests([string]$s, [string]$dir) {
  $parts = $s.Split('/')
  if ($s.Contains(':')) {
    $b = ([Net.IPAddress]::Parse($parts[0])).GetAddressBytes()
    $f = 'ipv6.' + $dir + 'Addr'
  } else {
    if ($s -cnotmatch $V4Re) { throw 'cw-bad_request адрес' }
    $b = [byte[]]@([byte][int]$Matches[1], [byte][int]$Matches[2], [byte][int]$Matches[3], [byte][int]$Matches[4])
    $f = 'ip.' + $dir + 'Addr'
  }
  $bits = $(if ($parts.Count -gt 1) { [int]$parts[1] } else { 8 * $b.Length })
  $lo = New-Object byte[] $b.Length
  $hi = New-Object byte[] $b.Length
  for ($i = 0; $i -lt $b.Length; $i++) {
    $keep = [Math]::Max(0, [Math]::Min(8, $bits - 8 * $i))
    $m = (0xFF -shl (8 - $keep)) -band 0xFF
    $lo[$i] = [byte]($b[$i] -band $m)
    $hi[$i] = [byte]($lo[$i] -bor (0xFF -bxor $m))
  }
  $txt = {
    param($x)
    if ($x.Length -eq 4) { return ($x -join '.') }
    return ((0..7 | ForEach-Object { '{0:x}' -f ([int]$x[2 * $_] * 256 + [int]$x[2 * $_ + 1]) }) -join ':')
  }
  $l = & $txt $lo
  $h = & $txt $hi
  $v6 = $b.Length -eq 16
  if ($l -ceq $h) { return @{ key = $l + '-' + $h; n = 1; v6 = $v6; text = $f + '!=' + $l } }
  return @{ key = $l + '-' + $h; n = 2; v6 = $v6; text = '(' + $f + '<' + $l + ' or ' + $f + '>' + $h + ')' }
}
# each family's tests behind a guard: a test of a field the packet lacks is false
# (an IPv4 address test fails on an IPv6 packet, != too)
function Wf-Excl($tests) {
  $v4 = @($tests | Where-Object { -not $_.v6 } | ForEach-Object { $_.text })
  $v6 = @($tests | Where-Object { $_.v6 } | ForEach-Object { $_.text })
  $g = New-Object Collections.Generic.List[string]
  if ($v4.Count -gt 0) { $g.Add('(ipv6 or (' + ($v4 -join ' and ') + '))') }
  if ($v6.Count -gt 0) { $g.Add('(ip or (' + ($v6 -join ' and ') + '))') }
  return ($g -join ' and ')
}
# the --wf-raw-part file: our fixed parts, our VPN servers left out in the kernel
# (too many for WinDivert → none left out, --ipset-exclude still skips them)
function Wf-Filter($l) {
  $k = $(if ($l.services.Contains('discord')) { '1' } else { '0' })
  $out = $WfOut[$k]
  $in = $WfIn[$k]
  $seen = New-Object Collections.Generic.HashSet[string]
  $dst = New-Object Collections.Generic.List[object]
  $src = New-Object Collections.Generic.List[object]
  $n = 0
  foreach ($x in $l.exclude) {
    $d = Wf-Tests $x 'Dst'
    if (-not $seen.Add($d.key)) { continue }
    $n += $d.n
    $dst.Add($d)
    $src.Add((Wf-Tests $x 'Src'))
  }
  $State.wfExcl = $seen.Count
  if ($n -gt $WfMax) {
    $State.wfExcl = -1
    Note ('адресов серверов VPN слишком много для фильтра WinDivert (' + $seen.Count + ') — их трафик проходит через zapret')
  } elseif ($dst.Count -gt 0) {
    $out = $out + ' and ' + (Wf-Excl $dst)
    $in = $in + ' and ' + (Wf-Excl $src)
  }
  $lf = [string][char]10
  return '(' + $out + ')' + $lf + 'or' + $lf + '(' + $in + ')' + $lf
}
# the lists of request generation $gen, validated (null = not written yet);
# a refused value is never repeated in the message
function Load-Lists([long]$gen) {
  $t = Read-UserFile $ListsF 262144
  if (-not $t) { return $null }
  try { $l = $t | ConvertFrom-Json } catch { return $null }
  if ($null -eq $l -or (Num $l.gen) -ne $gen) { return $null }
  $id = $l.strategy
  if (-not ($id -is [string]) -or $id -cnotmatch $IdRe -or -not $Plans.ContainsKey($id + '|0')) { throw 'cw-bad_request стратегия' }
  $picked = New-Object Collections.Generic.List[string]
  foreach ($s in @($l.services)) {
    if ($null -eq $s) { continue }
    if (-not ($s -is [string]) -or $s -cnotmatch $IdRe -or -not $ServiceDomains.ContainsKey($s)) { throw 'cw-bad_request сервис' }
    if (-not $picked.Contains($s)) { $picked.Add($s) }
  }
  $hosts = New-Object Collections.Generic.List[string]
  foreach ($d in @($l.hosts)) {
    if ($null -eq $d) { continue }
    if (-not ($d -is [string]) -or $d -cnotmatch $DomRe -or $PublicSuffixes -ccontains $d) { throw 'cw-bad_request домен' }
    if (-not $hosts.Contains($d)) { $hosts.Add($d) }
    if ($hosts.Count -gt $MaxHosts) { throw 'cw-bad_request слишком много доменов' }
  }
  $ex = New-Object Collections.Generic.List[string]
  foreach ($x in @($l.exclude)) {
    if ($null -eq $x) { continue }
    if (-not ($x -is [string]) -or -not (Test-Cidr $x)) { throw 'cw-bad_request адрес' }
    if (-not $ex.Contains($x)) { $ex.Add($x) }
    if ($ex.Count -gt $MaxExcl) { throw 'cw-bad_request слишком много адресов' }
  }
  $ips = New-Object Collections.Generic.List[string]
  foreach ($x in @($l.ips)) {
    if ($null -eq $x) { continue }
    if (-not ($x -is [string]) -or -not (Test-UserIp $x)) { throw 'cw-bad_request адрес' }
    if (-not $ips.Contains($x)) { $ips.Add($x) }
    if ($ips.Count -gt $MaxExcl) { throw 'cw-bad_request слишком много адресов' }
  }
  return @{ gen = $gen; strategy = $id; services = $picked; hosts = $hosts; exclude = $ex; ips = $ips }
}
# the request's pid: a live process of OUR app's exe, owned by THIS user
function App-Alive($v) {
  $id = Num $v
  if ($id -le 0 -or $id -gt [int]::MaxValue) { return $false }
  try {
    $p = [Diagnostics.Process]::GetProcessById([int]$id)
    if ($p.MainModule.FileName -ine $AppExe) { return $false }
    $w = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$id)
    return ([string](Invoke-CimMethod -InputObject $w -MethodName GetOwnerSid).Sid -eq $Sid)
  } catch { return $false }
}
# only SYSTEM / Administrators may have any access (production only)
function Test-AdminOnly([string]$d) {
  if (-not $CheckAcl) { return }
  $acl = (New-Object IO.DirectoryInfo($d)).GetAccessControl('Access')
  foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ([string]$r.AccessControlType -eq 'Allow' -and $Trusted -notcontains $r.IdentityReference.Value) {
      throw 'cw-failed папка zapret доступна не только администраторам — обновите службу'
    }
  }
}
# the admin-only folder of zapret (Cygwin's root): no link, no etc / tmp in it
function Test-DpiFolder {
  foreach ($d in @($DpiRoot, $DpiBin)) {
    if (-not [IO.Directory]::Exists($d) -or (Is-Reparse $d)) { throw 'cw-failed нет защищённой папки zapret — обновите службу' }
  }
  foreach ($n in @('etc', 'tmp')) {
    $e = Join-Path $DpiRoot $n
    if ([IO.Directory]::Exists($e) -or [IO.File]::Exists($e)) { throw ('cw-failed посторонняя папка в корне Cygwin: ' + $n) }
  }
  foreach ($d in @($DpiRoot, $DpiBin)) { Test-AdminOnly $d }
}
# <Root>\\tmp: the lock lives there — admin-only, never a link
function Prepare-Tmp {
  if ((Is-Reparse $Tmp) -or [IO.File]::Exists($Tmp)) { throw 'cw-failed папка tmp подменена' }
  if (-not [IO.Directory]::Exists($Tmp)) {
    if ($CheckAcl) {
      $ds = New-Object Security.AccessControl.DirectorySecurity
      $ds.SetSecurityDescriptorSddlForm('O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
      $null = [IO.Directory]::CreateDirectory($Tmp, $ds)
    } else { $null = [IO.Directory]::CreateDirectory($Tmp) }
  }
  Test-AdminOnly $Tmp
}
# one winws of ours per computer: a lock file in the admin-only tmp, held open
# (FileShare.None) while this broker lives — a user can't take or squat it
function Take-Lock {
  if (Is-Reparse $LockF) { return $null }
  try { return [IO.File]::Open($LockF, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { return $null }
}
# Cygwin's object directory, created by us with access for SYSTEM / Administrators
# only (see the header); an existing one must be owned by them. null = refused
function Hold-CygwinDir {
  $name = 'cygwin1S5-' + (Cygwin-Key (Join-Path $DpiBin 'cygwin1.dll'))
  $r = Object-Dir $name $CygwinSddl
  if ($r.status -eq '00000000') { return $r.handle }
  if ($r.status -ne 'C0000035') { throw 'cw-failed не удалось создать объекты Cygwin' }
  $o = Object-Dir $name ''
  if ($o.status -ne '00000000') { return $null }
  $own = Owner-Of-Handle $o.handle
  if ($Trusted -contains $own) { return $o.handle }
  $null = $Native::NtClose($o.handle)
  return $null
}
function Ensure-DpiDir {
  if ((Is-Reparse $Dir) -or -not [IO.Directory]::Exists($Dir)) { throw 'cw-failed нет защищённой папки — обновите службу' }
  if ([IO.Directory]::Exists($DpiDir) -or [IO.File]::Exists($DpiDir)) {
    if ((Is-Reparse $DpiDir) -or -not [IO.Directory]::Exists($DpiDir)) { throw 'cw-failed папка zapret подменена' }
  } else { $null = [IO.Directory]::CreateDirectory($DpiDir) }
  foreach ($f in @($HostsF, $ExclF, $DiscordF, $IpsF, $WfF)) { if (Is-Reparse $f) { throw 'cw-failed файл zapret подменён' } }
}
# the hostlist / ipset files winws reads: written here, one entry per line
function Write-Lists($l) {
  $all = New-Object Collections.Generic.List[string]
  foreach ($s in $l.services) { foreach ($d in $ServiceDomains[$s]) { if (-not $all.Contains($d)) { $all.Add($d) } } }
  foreach ($d in $l.hosts) { if (-not $all.Contains($d)) { $all.Add($d) } }
  $n = $all.Count + $l.ips.Count
  # only IP rules: the hostlist profiles get a name that never matches (an empty hostlist matches everything)
  if ($all.Count -eq 0) { $all.Add($NoHost) }
  Write-Atomic $HostsF (($all -join [string][char]10) + [string][char]10)
  $ex = @($AlwaysExclude) + @($l.exclude)
  Write-Atomic $ExclF (($ex -join [string][char]10) + [string][char]10)
  Write-Atomic $DiscordF (($DiscordIps -join [string][char]10) + [string][char]10)
  Write-Atomic $IpsF (($l.ips -join [string][char]10) + [string][char]10)
  Write-Atomic $WfF (Wf-Filter $l)
  return $n
}
# the only command line winws ever gets: the table + the broker's own paths
function Build-Args($l, [int]$ifIdx) {
  $key = $l.strategy + '|' + $(if ($l.services.Contains('discord')) { '1' } else { '0' })
  $out = New-Object Collections.Generic.List[string]
  $out.Add('"--wf-iface=' + $ifIdx + '"')
  foreach ($t in $Plans[$key]) {
    $out.Add('"' + $t.Replace('%TLS%', $FakeTls).Replace('%QUIC%', $FakeQuic).Replace('%HOSTS%', $HostsF).Replace('%EXCL%', $ExclF).Replace('%DISCORD_IPS%', $DiscordF).Replace('%WF%', $WfF) + '"')
  }
  if ($l.ips.Count -gt 0) {
    foreach ($t in $IpPlans[$l.strategy]) {
      $out.Add('"' + $t.Replace('%TLS%', $FakeTls).Replace('%QUIC%', $FakeQuic).Replace('%EXCL%', $ExclF).Replace('%USER_IPS%', $IpsF) + '"')
    }
  }
  if ($DryRun) { $out.Add('"--dry-run"') }
  return ($out -join ' ')
}
function Physical-If {
  try {
    return (Pick-If (Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore -ErrorAction Stop))
  } catch { return $null }
}
# WinDivert of another program: its driver (another file) would be what our
# WinDivert.dll starts — only ours, or the copy an update renamed, is accepted
function Our-Driver([string]$pn) {
  foreach ($d in @($DpiBin, $LegacyBin)) {
    $f = Join-Path $d 'WinDivert64.sys'
    if ($pn -ieq $f) { return $true }
    if ($pn.Length -eq $f.Length + 37 -and $pn.StartsWith($f + '.old-', [StringComparison]::OrdinalIgnoreCase) -and $pn.Substring($f.Length + 5) -cmatch '^[0-9a-f]{32}\\z') { return $true }
  }
  return $false
}
function Foreign-Driver {
  try {
    foreach ($d in @(Get-CimInstance Win32_SystemDriver -Filter "Name LIKE 'WinDivert%'" -ErrorAction Stop)) {
      $pn = [string]$d.PathName
      if ($pn.StartsWith('\\??\\') -or $pn.StartsWith('\\\\?\\')) { $pn = $pn.Substring(4) }
      if (-not (Our-Driver $pn)) { return 'драйвер WinDivert другой программы' }
    }
  } catch {}
  return $null
}
# another DPI bypass: only a process with admin rights counts (WinDivert needs
# them) — a plain user's program called winws.exe does not stop zapret
function Foreign-Dpi {
  foreach ($n in $ForeignProc) {
    foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) {
      $r = Proc-Rights $p.Id
      if ($null -ne $r -and $r.admin) { return ('процесс ' + $n + '.exe') }
    }
  }
  foreach ($n in $ForeignSvc) {
    try {
      $s = Get-Service -Name $n -ErrorAction Stop
      if ([string]$s.Status -ne 'Stopped') { return ('служба ' + $n) }
    } catch {}
  }
  return (Foreign-Driver)
}
# our winws of another Windows user: our file, run by SYSTEM (through a broker)
function Ours-Running {
  $n = 0
  foreach ($p in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($Exe)) -ErrorAction SilentlyContinue)) {
    try {
      if ($p.Path -ine $Exe) { continue }
      $r = Proc-Rights $p.Id
      if ($null -ne $r -and $r.system) { $n++ }
    } catch {}
  }
  return $n
}
function Kill-Dpi($p) {
  if ($null -eq $p) { return }
  try { if (-not $p.HasExited) { $p.Kill(); $null = $p.WaitForExit(5000) } } catch {}
}
# our winws = our file AND this user's hostlist in its command line (a pid may be
# reused, the same file runs for another Windows user)
function Is-OurDpi($o) {
  try {
    if ($o.MainModule.FileName -ine $Exe) { return $false }
    $cl = [string](Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$o.Id)).CommandLine
    return $cl.IndexOf('"--hostlist=' + $HostsF + '"', [StringComparison]::OrdinalIgnoreCase) -ge 0
  } catch { return $false }
}
# a winws of an earlier broker that outlived it (only that pid, only ours) —
# called before this broker's first Save-State replaces the file with its pid
function Stop-Orphan {
  try {
    if (-not [IO.File]::Exists($StateF)) { return }
    $id = Num ([IO.File]::ReadAllText($StateF, $Utf8) | ConvertFrom-Json).dpiPid
    if ($id -le 0 -or $id -gt [int]::MaxValue) { return }
    $o = [Diagnostics.Process]::GetProcessById([int]$id)
    if (Is-OurDpi $o) {
      Kill-Dpi $o
      Note ('остановлен zapret прошлого запуска, pid ' + $id)
    }
  } catch {}
}
function Rotate([string]$f) {
  try {
    if ([IO.File]::Exists($f)) {
      $old = $f + '.1'
      if ([IO.File]::Exists($old)) { [IO.File]::Delete($old) }
      [IO.File]::Move($f, $old)
    }
  } catch {}
}
function Dpi-Output {
  $t = ''
  foreach ($f in @($ErrF, $OutF)) {
    try { if ([IO.File]::Exists($f)) { $t += [IO.File]::ReadAllText($f, $Utf8) } } catch {}
  }
  $lines = @($t -split '\\r?\\n' | Where-Object { $_ -ne '' })
  if ($lines.Count -gt 12) { $lines = $lines[($lines.Count - 12)..($lines.Count - 1)] }
  $t = $lines -join [string][char]10
  if ($t.Length -gt 2000) { $t = $t.Substring($t.Length - 2000) }
  return $t
}
# TCP timestamps: on while our zapret runs (fixed commands only; a failure is only noted).
# Read: CIM MSFT_NetTCPSetting «Internet» — the template Windows applies to
# connections to the Internet, the store netsh writes; 0 = Disabled, 1 = Enabled.
# Written: netsh … timestamps=enabled|disabled, its exit code checked, then read back.
function Tcp-Ts {
  try {
    if ($TcpTsTest) {
      $v = ([IO.File]::ReadAllText($TcpTsTest)).Trim()
    } else {
      $v = [string][int](Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName 'MSFT_NetTCPSetting' -Filter "SettingName='Internet'" -ErrorAction Stop).Timestamps
    }
    if ($v -ceq '0' -or $v -ceq 'disabled') { return 'Disabled' }
    if ($v -ceq '1' -or $v -ceq 'enabled') { return 'Enabled' }
    return ''
  } catch { return '' }
}
# netsh with ONE of two fixed values; true only for exit code 0 (no reliance on error streams)
function Run-Netsh([string]$v) {
  if ($v -cne 'enabled' -and $v -cne 'disabled') { return $false }
  try {
    $si = New-Object Diagnostics.ProcessStartInfo
    $si.FileName = $Netsh
    $si.Arguments = 'interface tcp set global timestamps=' + $v
    $si.UseShellExecute = $false
    $si.CreateNoWindow = $true
    $si.RedirectStandardOutput = $true
    $si.RedirectStandardError = $true
    $pr = [Diagnostics.Process]::Start($si)
    $null = $pr.StandardOutput.ReadToEnd()
    $null = $pr.StandardError.ReadToEnd()
    if (-not $pr.WaitForExit(15000)) { try { $pr.Kill() } catch {}; return $false }
    return ($pr.ExitCode -eq 0)
  } catch { return $false }
}
# the original value from the marker (only «Disabled» is ever written), '' = none / not ours
function TcpTs-Marker {
  if ((Is-Reparse $TsF) -or -not [IO.File]::Exists($TsF)) { return '' }
  if ((New-Object IO.FileInfo($TsF)).Length -gt 64) { return '' }
  $v = ([IO.File]::ReadAllText($TsF)).Trim()
  if ($v -ceq 'Disabled') { return $v }
  return ''
}
function Enable-TcpTs {
  if (-not $TcpTs) { return }
  try {
    # already on (or unknown): nothing is touched, no marker
    if ((Tcp-Ts) -ne 'Disabled') { return }
    if (Is-Reparse $TsF) { return }
    if ((TcpTs-Marker) -eq '') { Write-Atomic $TsF 'Disabled' }
    if ((Run-Netsh 'enabled') -and (Tcp-Ts) -eq 'Enabled') {
      $State.tcpTs = 'enabled'
      Note 'метки времени TCP включены (были выключены)'
      return
    }
    Note 'метки времени TCP не включились'
    # nothing changed: no marker left behind
    if ((Tcp-Ts) -eq 'Disabled') { [IO.File]::Delete($TsF) }
  } catch { Note 'метки времени TCP: не удалось включить' }
}
# back to the original value; the marker goes only once that is confirmed
function Restore-TcpTs {
  if (-not $TcpTs) { return }
  try {
    $orig = TcpTs-Marker
    if ($orig -eq '') { return }
    if ((Tcp-Ts) -ne $orig) {
      $ok = Run-Netsh 'disabled'
      if (-not $ok -or (Tcp-Ts) -ne $orig) { Note 'метки времени TCP: не удалось вернуть — попробуем при следующем запуске'; return }
    }
    [IO.File]::Delete($TsF)
    $State.tcpTs = ''
    Note 'метки времени TCP выключены, как было'
  } catch { Note 'метки времени TCP: не удалось вернуть' }
}
# a broker that runs no winws (cleanup / no request): puts them back if nobody holds the lock
function Restore-IfIdle {
  if (-not $TcpTs) { return }
  try {
    if ((Is-Reparse $Tmp) -or -not [IO.Directory]::Exists($Tmp) -or -not [IO.File]::Exists($TsF)) { return }
    Test-AdminOnly $Tmp
    $lk = Take-Lock
    if ($null -eq $lk) { return }
    try { Restore-TcpTs } finally { $lk.Dispose() }
  } catch {}
}
function Start-Dpi($l, $nic) {
  Test-DpiFolder
  foreach ($k in @($Hashes.Keys)) {
    if ((Sha (Join-Path $DpiBin $k)) -ne $Hashes[$k]) { throw ('cw-failed файл zapret изменён: ' + $k) }
  }
  Ensure-DpiDir
  $n = Write-Lists $l
  $State.strategy = $l.strategy
  $State.exitCode = $null
  $State.output = ''
  if ($n -eq 0) { $State.wait = 'no_hosts'; $State.dpiPid = 0; return $null }
  if ($null -eq $nic) { $State.wait = 'no_network'; $State.dpiPid = 0; return $null }
  $State.ifIdx = $nic.idx
  $State.ifName = $nic.name
  Rotate $OutF
  Rotate $ErrF
  $p = Start-Process -FilePath $Exe -ArgumentList (Build-Args $l $nic.idx) -WorkingDirectory $DpiBin -NoNewWindow -PassThru -RedirectStandardOutput $OutF -RedirectStandardError $ErrF
  $null = $p.Handle
  $State.dpiPid = $p.Id
  $State.wait = ''
  Note ('zapret запущен: стратегия ' + $l.strategy + ', адаптер ' + $nic.name + ' (' + $nic.idx + '), pid ' + $p.Id)
  return $p
}
function Refuse([string]$code, [string]$detail) {
  $State.status = 'refused'
  $State.error = $code
  $State.detail = $detail
  Note ('не запускаем: ' + $detail)
}

$dpi = $null
$lock = $null
$cygDir = [IntPtr]::Zero
try {
  # Windows functions: declared in memory (no csc / temporary files); a failure is reported
  try {
    ${NATIVE_PS.split('\n').join('\n    ')}
  } catch { throw 'cw-failed не удалось подготовить системные функции' }
  ${FINAL_PATH_PS.split('\n').join('\n  ')}
  ${CYGWIN_KEY_PS.split('\n').join('\n  ')}
  if (Is-Reparse $UserRun) { throw 'cw-failed папка приложения — ссылка' }
  $ctl = Read-Ctl
  if ($null -ne $ctl) { $State.session = [string]$ctl.session }
  $fresh = $null -ne $ctl -and [math]::Abs((Now-Ms) - (Num $ctl.ts)) -le 120000 -and (App-Alive $ctl.pid)
  if ($fresh -and $ctl.cmd -ceq 'cleanup') {
    Stop-Orphan
    Restore-IfIdle
    $State.status = 'stopped'
    $State.stopReason = 'очистка'
    exit 0
  }
  if (-not $fresh -or $ctl.cmd -cne 'run') {
    Restore-IfIdle
    $State.status = 'refused'
    $State.error = 'no_request'
    exit 0
  }
  # the previous winws first: the state file still holds its pid
  Stop-Orphan
  # the app waits for this session id: it knows the task really started
  Save-State
  $busy = Foreign-Dpi
  if ($busy) { Refuse 'foreign_dpi' $busy; exit 0 }
  Prepare-Tmp
  $lock = Take-Lock
  if ($null -eq $lock -or (Ours-Running) -gt 0) {
    Refuse 'dpi_busy' 'zapret CipherWay уже работает у другого пользователя Windows'
    exit 0
  }
  Test-DpiFolder
  $h = Hold-CygwinDir
  if ($null -eq $h) {
    Refuse 'foreign_dpi' 'служебные объекты Cygwin заняты другой программой'
    exit 0
  }
  $cygDir = $h
  Enable-TcpTs
  $gen = Num $ctl.gen
  $lists = $null
  for ($i = 0; $i -lt 20 -and $null -eq $lists; $i++) {
    $lists = Load-Lists $gen
    if ($null -eq $lists) { Start-Sleep -Milliseconds 150 }
  }
  if ($null -eq $lists) { throw 'cw-bad_request нет списков' }
  $State.gen = $gen
  $nic = Physical-If
  $dpi = Start-Dpi $lists $nic
  $State.status = 'running'
  Save-State
  $tick = 0
  $miss = 0
  $fails = 0
  $retryAt = 0
  while ($true) {
    Start-Sleep -Milliseconds 500
    $tick++
    if (Is-Reparse $UserRun) { $State.stopReason = 'папка приложения стала ссылкой'; break }
    if ($null -ne $dpi -and $dpi.HasExited) {
      $State.exitCode = $dpi.ExitCode
      $State.output = Dpi-Output
      $State.dpiPid = 0
      $State.wait = 'exited'
      $dpi = $null
      $fails++
      $retryAt = (Now-Ms) + 5000
      Note ('zapret завершился сам: код ' + $State.exitCode + '; вывод: ' + $State.output)
      if ($DryRun -and $State.exitCode -eq 0) { $fails = 99 }
      Save-State
    }
    $c = Read-Ctl
    if ($null -eq $c) {
      $miss++
      if ($miss -gt 6) { $State.stopReason = 'нет файла запроса'; break }
      continue
    }
    $miss = 0
    if ($c.session -cne $State.session) { $State.stopReason = 'новая сессия'; break }
    if ($c.cmd -cne 'run') { $State.stopReason = 'команда остановки'; break }
    $cgen = Num $c.gen
    if ($cgen -gt $State.gen) {
      $l2 = Load-Lists $cgen
      if ($null -ne $l2) {
        Kill-Dpi $dpi
        $dpi = $null
        $lists = $l2
        $State.gen = $cgen
        $fails = 0
        $nic = Physical-If
        $dpi = Start-Dpi $lists $nic
        Save-State
        continue
      }
    }
    if (($tick % 8) -eq 0) {
      if (-not (App-Alive $c.pid)) { $State.stopReason = 'приложение закрыто'; break }
      $busy = Foreign-Dpi
      if ($busy) {
        $State.error = 'foreign_dpi'
        $State.detail = $busy
        $State.stopReason = 'запущен другой обход блокировок (' + $busy + ')'
        break
      }
      $cur = Physical-If
      $changed = ($null -eq $cur) -ne ($null -eq $nic) -or ($null -ne $cur -and $null -ne $nic -and $cur.idx -ne $nic.idx)
      if ($changed) {
        Note ('сеть сменилась: ' + $(if ($cur) { $cur.name + ' (' + $cur.idx + ')' } else { 'нет' }))
        Kill-Dpi $dpi
        $dpi = $null
        $nic = $cur
        $fails = 0
        $dpi = Start-Dpi $lists $nic
      } elseif ($null -eq $dpi -and $State.wait -eq 'exited' -and $fails -le 3 -and (Now-Ms) -ge $retryAt) {
        $dpi = Start-Dpi $lists $nic
      }
      if (-not $DryRun -and $fails -gt 3 -and $State.error -eq '') { $State.error = 'exited' }
      Save-State
    }
  }
  $State.status = 'stopped'
} catch {
  # the state and the journal get our own fixed texts only (cw-<code> <text>);
  # anything else: a generic text, the exception's type in the journal
  $m = [string]$_.Exception.Message
  $State.status = 'error'
  if ($m -cmatch '^cw-(bad_request|failed|cygwin) ') {
    $State.error = $(if ($Matches[1] -eq 'bad_request') { 'bad_request' } else { 'failed' })
    $State.detail = $m.Substring($m.IndexOf(' ') + 1)
    Note ('ошибка: ' + $State.detail)
  } else {
    $State.error = 'failed'
    $State.detail = 'внутренняя ошибка службы zapret'
    Note ('ошибка: ' + $State.detail + ' (' + $_.Exception.GetType().Name + ')')
  }
} finally {
  Kill-Dpi $dpi
  $State.dpiPid = 0
  if ($cygDir -ne [IntPtr]::Zero) { try { $null = $Native::NtClose($cygDir) } catch {} }
  # only the broker that holds the lock turned them on
  if ($null -ne $lock) { Restore-TcpTs }
  if ($null -ne $lock) { try { $lock.Dispose() } catch {} }
  if ($State.stopReason) { Note ('zapret остановлен: ' + $State.stopReason) }
  if ($State.status -eq 'running' -or $State.status -eq 'starting') { $State.status = 'stopped' }
  try { Save-State } catch {}
}
`.trim()
}

/** What dpi-state.json holds (written by the broker above). */
export interface DpiBrokerState {
  session?: string
  status?: 'starting' | 'running' | 'stopped' | 'refused' | 'error'
  /** the request generation the broker runs (lists + strategy) */
  gen?: number
  strategy?: string
  ifIdx?: number
  ifName?: string
  /** winws pid; 0 = not running right now (see wait) */
  dpiPid?: number
  wait?: DpiWait
  exitCode?: number | null
  output?: string
  error?: DpiBrokerError
  detail?: string
  stopReason?: string
  /** 'enabled' = this broker turned TCP timestamps on (put back when it ends) */
  tcpTs?: string
  /**
   * 0.7.3: how many of our servers' addresses / ranges the WinDivert filter
   * leaves out (their packets never reach winws); -1 = too many, none left out
   */
  wfExcl?: number
  ts?: number
}

const STATUSES = ['starting', 'running', 'stopped', 'refused', 'error'] as const
const ERRORS = [
  '',
  'no_request',
  'foreign_dpi',
  'dpi_busy',
  'bad_request',
  'exited',
  'failed'
] as const
const WAITS = ['', 'no_network', 'no_hosts', 'exited'] as const

/** A state file → DpiBrokerState; a half-written or foreign file gives null. */
export function parseDpiState(text: string): DpiBrokerState | null {
  try {
    const o = JSON.parse(text.replace(/^\ufeff/, '')) as Record<string, unknown>
    if (!o || typeof o !== 'object') return null
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
    return {
      session: str(o.session),
      status: STATUSES.find((s) => s === o.status),
      gen: num(o.gen),
      strategy: str(o.strategy),
      ifIdx: num(o.ifIdx),
      ifName: str(o.ifName),
      dpiPid: num(o.dpiPid),
      wait: WAITS.find((s) => s === o.wait),
      exitCode: typeof o.exitCode === 'number' ? o.exitCode : null,
      output: str(o.output),
      error: ERRORS.find((s) => s === o.error),
      detail: str(o.detail),
      stopReason: str(o.stopReason),
      tcpTs: str(o.tcpTs),
      wfExcl: num(o.wfExcl),
      ts: num(o.ts)
    }
  } catch {
    return null
  }
}
