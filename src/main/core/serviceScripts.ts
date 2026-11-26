import {
  CORE_PROCESS_PS,
  psGuid,
  psQuote,
  STALE_ADAPTER_PS,
  WINTUN_DEVICE_PS,
  wintunGuid
} from './broker'
import { CORE_EXE, DPI_ALL, DPI_EXE, LAN_EXE, LEGACY_EXES, TUN_INTERFACE } from './coreNames'

// ---------------------------------------------------------------------------
// «Служба TUN» (0.4.2): instead of a UAC prompt on every TUN connect, the
// user approves ONE prompt that registers a Task Scheduler task running as
// SYSTEM. After that the app starts it with `schtasks /run` (no prompt).
//
// The app lives in %LOCALAPPDATA%\Programs — writable by any process of the
// user. A task that ran anything from there with admin rights would be a
// UAC bypass for every piece of malware, so:
//  * the installer (under UAC) copies cipherway-core.exe + wintun.dll and writes the
//    broker script into %ProgramData%\CipherWay, created with a protected ACL
//    (SYSTEM / Administrators: full, users: read & execute). The task runs
//    only powershell.exe (System32) with that broker. A pre-existing folder
//    owned by someone else is moved away, not reused. File hashes are checked
//    after copying and again by the broker before every core start.
//  * the task's own security descriptor lets the user only read and run it
//    (FRFX) — not change its command.
//  * the broker treats everything in the user's run folder as hostile input:
//    it only READS there (never writes or deletes — no symlink / junction
//    write primitive), validates the sing-box config against an allow-list
//    (no file paths except our own rule-sets / log, no cache_file,
//    external_ui, certificates, endpoints, services; inbound = tun only;
//    Clash API on 127.0.0.1 only) and runs sing-box with a validated COPY
//    in its protected folder, so a later change of the user's file has no
//    effect. Rule-set files are copied too (fixed names, must start with
//    `{"version":`, size-limited), the core never reads the user's folder.
//  * a run needs a fresh request (tun-ctl.json, < 2 min old, live app pid).
// Talking to the broker (files, the broker polls every 250 ms):
//   <userRun>\tun-ctl.json   app → broker {session,pid,cmd,restart,rules,ts}
//   <home>\state.json        broker → app {session,status,restart,rules,exitCode,uptimeMs,
//                            stderr,stopReason,error,ts}
//   <home>\broker.log        what the broker did and why a core ended (for diagnostics)
// <home> = %ProgramData%\CipherWay\u\<user SID>. Pure — unit tested in
// broker.test.ts, the broker itself runs (non-elevated) in the e2e test.
// ---------------------------------------------------------------------------

export const SYSTEM_SID = 'S-1-5-18'

export interface BrokerHashes {
  [CORE_EXE]: string
  'wintun.dll': string
  /** the LAN daemon (0.5.0); absent in a build without it */
  [LAN_EXE]?: string
  /** zapret (0.7.0): cipherway-dpi.exe and its files (DPI_ALL); absent in a build without it */
  [name: string]: string | undefined
}

export interface ServiceBrokerParams {
  /** SID of the user the service belongs to (not the elevating admin) */
  sid: string
  /** the app's run folder (config.json, rules\, tun-ctl.json) — read only */
  userRunDir: string
  hashes: BrokerHashes
  /** tests only: a temp folder instead of %ProgramData%\CipherWay */
  rootOverride?: string
  /** tests only: the adapter this broker may wait for / remove */
  tunName?: string
}

const SID_RE = /^S-1-5-21(-\d{1,10}){3,6}$|^S-1-5-18$/
export function isValidSid(sid: string): boolean {
  return SID_RE.test(sid)
}
export const HASH_RE = /^[0-9a-f]{64}$/

export function taskName(sid: string): string {
  return `CipherWay TUN ${sid}`
}

/** The third task of the service: zapret (src/main/zapret/dpiBroker.ts), 0.7.0. */
export function dpiTaskName(sid: string): string {
  return `CipherWay DPI ${sid}`
}

/** The second task of the service: the LAN daemon (src/main/lan/lanBroker.ts). */
export function lanTaskName(sid: string): string {
  return `CipherWay LAN ${sid}`
}

export function rootExpr(override?: string): string {
  return override
    ? psQuote(override)
    : `(Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'CipherWay')`
}

/**
 * PowerShell helpers of both SYSTEM brokers (TUN and LAN). Expect $Utf8,
 * $BrokerLog, $State, $StateF, $CtlF. Everything from the user's run folder is
 * read with Read-UserFile: size-limited, never through a link.
 */
export const BROKER_HELPERS_PS = `
function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
# an unchecked value for a message: only a-z 0-9 . _ -, at most 40 characters
function Safe([string]$s) {
  $t = [regex]::Replace(([string]$s).ToLowerInvariant(), '[^a-z0-9._-]', '')
  if ($t.Length -gt 40) { $t = $t.Substring(0, 40) }
  return $t
}
# a JSON number of the request as a whole number, else -1 — the range is checked
# BEFORE any cast (a cast of 1e30 or of a string would quote the value in an error)
function Num($v) {
  if ($v -is [int] -or $v -is [long]) { return [long]$v }
  if ($v -is [double] -or $v -is [decimal]) {
    $d = [double]$v
    if ([double]::IsNaN($d) -or $d -gt 9007199254740991 -or $d -lt -9007199254740991) { return [long]-1 }
    return [long][math]::Truncate($d)
  }
  return [long]-1
}
function Is-Reparse([string]$p) {
  try { return (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) } catch { return $false }
}
# at most $max bytes of an open stream: read into max+1, more = refused (the size
# is never taken from the file system — it may change between a check and the read)
function Read-Bounded($fs, [long]$max) {
  $buf = New-Object byte[] ($max + 1)
  $n = 0
  while ($n -le $max) {
    $r = $fs.Read($buf, $n, $buf.Length - $n)
    if ($r -le 0) { break }
    $n += $r
  }
  if ($n -gt $max) { return $null }
  $off = 0
  if ($n -ge 3 -and $buf[0] -eq 0xEF -and $buf[1] -eq 0xBB -and $buf[2] -eq 0xBF) { $off = 3 }
  return $Utf8.GetString($buf, $off, $n - $off)
}
function Read-UserFile([string]$p, [long]$max) {
  try {
    $fi = New-Object IO.FileInfo($p)
    if (-not $fi.Exists) { return $null }
    if (($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
    $fs = New-Object IO.FileStream($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try { return (Read-Bounded $fs $max) } finally { $fs.Dispose() }
  } catch { return $null }
}
function Write-Atomic([string]$p, [string]$text) {
  $tmp = $p + '.tmp'
  [IO.File]::WriteAllText($tmp, $text, $Utf8)
  for ($i = 0; $i -lt 30; $i++) {
    try {
      if ([IO.File]::Exists($p)) { [IO.File]::Replace($tmp, $p, [NullString]::Value) } else { [IO.File]::Move($tmp, $p) }
      return
    } catch { Start-Sleep -Milliseconds 100 }
  }
  throw 'cw-write не удалось записать файл службы'
}
function Note([string]$m) {
  try {
    if ([IO.File]::Exists($BrokerLog) -and (New-Object IO.FileInfo($BrokerLog)).Length -gt 524288) { [IO.File]::WriteAllText($BrokerLog, '', $Utf8) }
    [IO.File]::AppendAllText($BrokerLog, ([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m + [Environment]::NewLine), $Utf8)
  } catch {}
}
function Save-State { $State.ts = Now-Ms; Write-Atomic $StateF (ConvertTo-Json -Compress -InputObject $State) }
function Alive($id) {
  try { $null = [Diagnostics.Process]::GetProcessById([int]$id); return $true } catch { return $false }
}
function Read-Ctl {
  $t = Read-UserFile $CtlF 4096
  if (-not $t) { return $null }
  try { $c = $t | ConvertFrom-Json } catch { return $null }
  if (-not ($c.session -is [string]) -or $c.session -cnotmatch '^[0-9a-f]{16,64}\\z') { return $null }
  return $c
}
function Sha([string]$p) {
  $h = [Security.Cryptography.SHA256]::Create()
  $f = [IO.File]::OpenRead($p)
  try { return ([BitConverter]::ToString($h.ComputeHash($f)) -replace '-', '').ToLowerInvariant() } finally { $f.Dispose() }
}
`.trim()

/** The SYSTEM-side broker (installed into <home>\broker.ps1). */
export function serviceBrokerScript(p: ServiceBrokerParams): string {
  if (!isValidSid(p.sid)) throw new Error('bad sid')
  for (const h of Object.values(p.hashes)) if (!HASH_RE.test(h ?? '')) throw new Error('bad hash')
  return `
# CipherWay VPN — TUN service broker. Runs as SYSTEM from Task Scheduler.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$Sid = ${psQuote(p.sid)}
$UserRun = ${psQuote(p.userRunDir)}
$Root = ${rootExpr(p.rootOverride)}
$Dir = Join-Path $Root ('u\\' + $Sid)
$Bin = Join-Path $Root 'bin'
$Exe = Join-Path $Bin ${psQuote(CORE_EXE)}
$CoreExe = $Exe
$CoreDir = $Bin
$TunName = ${psQuote(p.tunName ?? TUN_INTERFACE)}
$TunGuid = ${psGuid(wintunGuid(p.tunName ?? TUN_INTERFACE))}
$RulesOut = Join-Path $Dir 'rules'
$CfgOut = Join-Path $Dir 'config.json'
$CoreArgs = 'run -c "' + $CfgOut + '"'
$BrokerLog = Join-Path $Dir 'broker.log'
$LogOut = Join-Path $Dir 'sing-box.log'
$StateF = Join-Path $Dir 'state.json'
$CtlF = Join-Path $UserRun 'tun-ctl.json'
$CfgIn = Join-Path $UserRun 'config.json'
$RulesIn = Join-Path $UserRun 'rules'
$Hashes = @{ ${psQuote(CORE_EXE)} = ${psQuote(p.hashes[CORE_EXE])}; 'wintun.dll' = ${psQuote(p.hashes['wintun.dll'])} }
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$NameRe = '^cw-[0-9a-z-]{1,40}\\.json\\z'
$Forbidden = '(?i)(path|file|dir|_ui|download|certificate|key|script|command|exec|acme|cache|store|platform)'
$OkOut = @('direct', 'socks', 'hysteria2', 'vmess', 'selector', 'urltest')
$OkDns = @('https', 'udp', 'tcp', 'tls', 'local')

$State = @{ session = ''; status = 'starting'; restart = 0; rules = 0; corePid = 0; exitCode = $null; uptimeMs = $null; stderr = ''; stopReason = ''; error = ''; brokerPid = $PID; ts = 0 }
${BROKER_HELPERS_PS}
function Test-Keys($node, [string]$where) {
  if ($null -eq $node) { return }
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    foreach ($q in $node.PSObject.Properties) {
      $w = $where + '.' + $q.Name
      if ($q.Name -match $Forbidden -and $w -notmatch '^\\.route\\.(rule_set\\[\\d+\\]\\.path|rules\\[\\d+\\]\\.process_path)\\z') { throw ('cw-config запрещённое поле ' + (Safe $w)) }
      Test-Keys $q.Value $w
    }
  } elseif ($node -is [array]) {
    for ($i = 0; $i -lt $node.Count; $i++) { Test-Keys $node[$i] ($where + '[' + $i + ']') }
  }
}
function Test-Config([string]$text) {
  if (-not $text) { throw 'cw-config нет конфигурации' }
  try { $c = $text | ConvertFrom-Json } catch { throw 'cw-config не JSON' }
  if (-not ($c -is [System.Management.Automation.PSCustomObject])) { throw 'cw-config не объект' }
  foreach ($q in $c.PSObject.Properties) {
    if (@('log', 'dns', 'inbounds', 'outbounds', 'route', 'experimental') -notcontains $q.Name) { throw ('cw-config поле ' + (Safe $q.Name)) }
  }
  Test-Keys $c ''
  if ($null -ne $c.log) {
    foreach ($q in $c.log.PSObject.Properties) { if (@('level', 'output', 'timestamp', 'disabled') -notcontains $q.Name) { throw ('cw-config log.' + (Safe $q.Name)) } }
    if ($null -ne $c.log.output -and [string]$c.log.output -ne $LogOut) { throw 'cw-config log.output' }
  }
  if ($null -ne $c.experimental) {
    foreach ($q in $c.experimental.PSObject.Properties) { if ($q.Name -ne 'clash_api') { throw ('cw-config experimental.' + (Safe $q.Name)) } }
    $ca = $c.experimental.clash_api
    if ($null -ne $ca) {
      foreach ($q in $ca.PSObject.Properties) { if (@('external_controller', 'default_mode', 'secret') -notcontains $q.Name) { throw ('cw-config clash_api.' + (Safe $q.Name)) } }
      if ([string]$ca.external_controller -notmatch '^127\\.0\\.0\\.1:\\d{1,5}\\z') { throw 'cw-config clash_api.external_controller' }
    }
  }
  if ($null -ne $c.inbounds) { foreach ($x in @($c.inbounds)) { if ($x.type -ne 'tun') { throw ('cw-config вход ' + (Safe $x.type)) } } }
  if ($null -ne $c.outbounds) { foreach ($x in @($c.outbounds)) { if ($OkOut -notcontains $x.type) { throw ('cw-config выход ' + (Safe $x.type)) } } }
  if ($null -ne $c.dns -and $null -ne $c.dns.servers) { foreach ($x in @($c.dns.servers)) { if ($OkDns -notcontains $x.type) { throw ('cw-config DNS ' + (Safe $x.type)) } } }
  if ($null -ne $c.route -and $null -ne $c.route.rule_set) {
    foreach ($x in @($c.route.rule_set)) {
      if ($x.type -ne 'local' -or $x.format -ne 'source') { throw 'cw-config rule_set: только local/source' }
      $leaf = [IO.Path]::GetFileName([string]$x.path)
      if ($leaf -notmatch $NameRe -or [string]$x.path -ne (Join-Path $RulesOut $leaf)) { throw ('cw-config rule_set.path ' + (Safe ([IO.Path]::GetFileName([string]$x.path)))) }
    }
  }
}
function Sync-Rules {
  if (-not [IO.Directory]::Exists($RulesOut)) { $null = [IO.Directory]::CreateDirectory($RulesOut) }
  $want = @{}
  if ([IO.Directory]::Exists($RulesIn) -and -not (Is-Reparse $RulesIn)) {
    foreach ($f in [IO.Directory]::GetFiles($RulesIn, 'cw-*.json')) {
      $leaf = [IO.Path]::GetFileName($f)
      if ($leaf -notmatch $NameRe) { continue }
      $t = Read-UserFile $f 16777216
      if ($null -eq $t -or -not $t.StartsWith('{"version":')) { continue }
      $want[$leaf] = $t
    }
  }
  foreach ($leaf in @($want.Keys)) {
    $dest = Join-Path $RulesOut $leaf
    $cur = $null
    if ([IO.File]::Exists($dest)) { $cur = [IO.File]::ReadAllText($dest, $Utf8) }
    if ($cur -cne $want[$leaf]) { Write-Atomic $dest $want[$leaf] }
  }
  foreach ($f in [IO.Directory]::GetFiles($RulesOut, 'cw-*.json')) {
    if (-not $want.ContainsKey([IO.Path]::GetFileName($f))) { [IO.File]::Delete($f) }
  }
}
function Prepare {
  if (Is-Reparse $UserRun) { throw 'cw-link папка приложения — ссылка' }
  foreach ($k in @($Hashes.Keys)) {
    if ((Sha (Join-Path $Bin $k)) -ne $Hashes[$k]) { throw ('cw-core файл ядра изменён: ' + $k) }
  }
  $text = Read-UserFile $CfgIn 4194304
  Test-Config $text
  Write-Atomic $CfgOut $text
  Sync-Rules
}
${CORE_PROCESS_PS}
${WINTUN_DEVICE_PS}
${STALE_ADAPTER_PS}
function Start-Core {
  $p = Start-CoreProcess
  $State.corePid = $p.Id
  $State.exitCode = $null
  $State.uptimeMs = $null
  $State.stderr = ''
  Note ('ядро запущено, pid ' + $p.Id)
  return $p
}
function Stop-Core($p) {
  if ($null -eq $p) { return }
  try { if (-not $p.HasExited) { $p.Kill(); $null = $p.WaitForExit(5000) } } catch {}
}
function Report-Exit($p) {
  $State.exitCode = $p.ExitCode
  $State.uptimeMs = (Now-Ms) - $script:CoreStarted
  $State.stderr = Core-Output
  Note ('ядро завершилось само: код ' + $State.exitCode + ', через ' + [math]::Round($State.uptimeMs / 1000, 1) + ' с; вывод: ' + $State.stderr)
}
# a core of an earlier session that outlived its broker holds the adapter and the ports
function Stop-Orphan {
  try {
    if (-not [IO.File]::Exists($StateF)) { return }
    $prev = [IO.File]::ReadAllText($StateF, $Utf8) | ConvertFrom-Json
    if ([int]$prev.corePid -le 0) { return }
    $o = [Diagnostics.Process]::GetProcessById([int]$prev.corePid)
    if ($o.MainModule.FileName -ieq $Exe) {
      $o.Kill()
      $null = $o.WaitForExit(5000)
      Note ('остановлено ядро прошлого запуска, pid ' + $prev.corePid)
    }
  } catch {}
}

$core = $null
try {
  $ctl = Read-Ctl
  if ($null -ne $ctl) { $State.session = [string]$ctl.session }
  if ($null -eq $ctl -or $ctl.cmd -cne 'run' -or [math]::Abs((Now-Ms) - (Num $ctl.ts)) -gt 120000 -or -not (Alive (Num $ctl.pid))) {
    $State.status = 'refused'
    $State.error = 'no_request'
    exit 0
  }
  $State.session = [string]$ctl.session
  $State.restart = Num $ctl.restart
  $State.rules = Num $ctl.rules
  Stop-Orphan
  # the app waits for this session id: it knows the task really started
  Save-State
  Clear-StaleAdapter
  Prepare
  $core = Start-Core
  $State.status = 'running'
  Save-State
  $tick = 0
  $idle = 0
  $miss = 0
  while ($true) {
    Start-Sleep -Milliseconds 250
    $tick++
    $c = Read-Ctl
    if ($null -eq $c) {
      # one failed read (the app is replacing the file, an antivirus holds it) is no reason to
      # kill a working core; the file gone for 3 s means the app removed it
      $miss++
      if ($miss -gt 12) { $State.stopReason = 'нет файла запроса'; break }
      continue
    }
    $miss = 0
    if ($c.session -ne $State.session) { $State.stopReason = 'новая сессия'; break }
    if ($c.cmd -ne 'run') { $State.stopReason = 'команда остановки'; break }
    if ((Num $c.restart) -gt $State.restart) {
      Stop-Core $core
      $core = $null
      Clear-StaleAdapter
      Prepare
      $core = Start-Core
      $State.restart = Num $c.restart
      $State.rules = Num $c.rules
      $idle = 0
      Save-State
      continue
    }
    if ((Num $c.rules) -gt $State.rules) {
      Sync-Rules
      $State.rules = Num $c.rules
      Save-State
    }
    if ($core.HasExited) {
      if ($null -eq $State.exitCode) { Report-Exit $core; Save-State }
      $idle++
      if ($idle -gt 240) { $State.stopReason = 'ядро завершилось, перезапуск не запрошен'; break }
    }
    if (($tick % 8) -eq 0) {
      if (-not (Alive (Num $c.pid))) { $State.stopReason = 'приложение закрыто'; break }
      Save-State
    }
  }
  $State.status = 'stopped'
} catch {
  # the state gets a fixed code only (never an exception text or a piece of JSON);
  # the journal: our own message (values only through Safe) or the exception's type
  $m = [string]$_.Exception.Message
  $State.status = 'error'
  $State.error = 'failed'
  if ($m -cmatch '^cw-(config|core|link|write) ') { $State.error = @{ config = 'config'; core = 'core_changed'; link = 'link'; write = 'write' }[$Matches[1]] }
  Note ('ошибка: ' + $State.error + ' — ' + $(if ($m.StartsWith('cw-')) { $m.Substring($m.IndexOf(' ') + 1) } else { $_.Exception.GetType().Name }))
} finally {
  Stop-Core $core
  if ($State.stopReason) { Note ('ядро остановлено: ' + $State.stopReason) }
  if ($State.status -eq 'running' -or $State.status -eq 'starting') { $State.status = 'stopped' }
  try { Save-State } catch {}
}
`.trim()
}

export interface InstallParams {
  sid: string
  /** the app's resources\\bin (source of the core / wintun.dll) */
  srcBinDir: string
  brokerText: string
  hashes: BrokerHashes
  /** sha256 of brokerText, stored in the manifest */
  brokerHash: string
  /** the LAN broker (lanBrokerScript) + its sha256; absent = no LAN task */
  lanBrokerText?: string
  lanBrokerHash?: string
  /** the zapret broker (dpiBrokerScript) + its sha256; absent = no DPI task */
  dpiBrokerText?: string
  dpiBrokerHash?: string
  appVersion: string
  /**
   * tests only: run the file part (copy, hash check, removal of the old names,
   * manifest) in this temp folder without elevation — no ACLs, no task.
   */
  testRoot?: string
}

/**
 * PowerShell: removes what versions up to 0.4.2 left in $Bin: `sing-box.exe`.
 * Anything with the same name elsewhere (another VPN client's core!) is not
 * touched — a process is stopped only if it runs from exactly this file.
 */
export function legacyCleanupPs(): string {
  const names = LEGACY_EXES.map(psQuote).join(', ')
  return `
function Remove-LegacyCores {
  foreach ($name in @(${names})) {
    $path = Join-Path $Bin $name
    if (-not [IO.File]::Exists($path)) { continue }
    foreach ($p in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($name)) -ErrorAction SilentlyContinue)) {
      try { if ($p.Path -ieq $path) { $p.Kill(); $null = $p.WaitForExit(3000) } } catch {}
    }
    for ($i = 0; $i -lt 15 -and [IO.File]::Exists($path); $i++) {
      try { [IO.File]::Delete($path) } catch { Start-Sleep -Milliseconds 200 }
    }
  }
}
`.trim()
}

const TASK_DESCRIPTION = {
  tun: 'CipherWay VPN: ядро sing-box в режиме TUN без запроса прав при каждом подключении',
  lan: 'CipherWay VPN: LAN — виртуальная локальная сеть для игр с друзьями',
  dpi: 'CipherWay VPN: ускорение без VPN (zapret) для выбранных сайтов'
} as const

/**
 * XML of a task: SYSTEM, highest, on demand only, no time limit, also on
 * battery, normal priority (the default 7 would make sing-box «below normal»).
 * $PsX / $BrokerX (TUN), $LanBrokerX (LAN) or $DpiBrokerX (zapret) / $DirX are expanded
 * (XML-escaped) by the installer's PowerShell here-string.
 */
export function taskXml(kind: 'tun' | 'lan' | 'dpi' = 'tun'): string {
  const broker = kind === 'lan' ? '$LanBrokerX' : kind === 'dpi' ? '$DpiBrokerX' : '$BrokerX'
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>CipherWay VPN</Author><Description>${TASK_DESCRIPTION[kind]}</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>${SYSTEM_SID}</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>$PsX</Command><Arguments>-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${broker}"</Arguments><WorkingDirectory>$DirX</WorkingDirectory></Exec></Actions>
</Task>`
}

/** Elevated installer / updater (one UAC prompt). Exit 0 = ok. */
export function installScript(p: InstallParams): string {
  if (!isValidSid(p.sid)) throw new Error('bad sid')
  const b64 = Buffer.from(p.brokerText, 'utf8').toString('base64')
  const lan = !!(p.hashes[LAN_EXE] && p.lanBrokerText && p.lanBrokerHash)
  if (lan && (!HASH_RE.test(p.hashes[LAN_EXE] ?? '') || !HASH_RE.test(p.lanBrokerHash ?? ''))) {
    throw new Error('bad hash')
  }
  const lanB64 = lan ? Buffer.from(p.lanBrokerText ?? '', 'utf8').toString('base64') : ''
  const dpi = DPI_ALL.every((f) => !!p.hashes[f]) && !!p.dpiBrokerText && !!p.dpiBrokerHash
  if (
    dpi &&
    (!DPI_ALL.every((f) => HASH_RE.test(p.hashes[f] ?? '')) || !HASH_RE.test(p.dpiBrokerHash ?? ''))
  ) {
    throw new Error('bad hash')
  }
  const dpiB64 = dpi ? Buffer.from(p.dpiBrokerText ?? '', 'utf8').toString('base64') : ''
  const manifest = JSON.stringify({
    version: 1,
    app: p.appVersion,
    broker: p.brokerHash,
    ...(lan ? { lanBroker: p.lanBrokerHash } : {}),
    ...(dpi ? { dpiBroker: p.dpiBrokerHash } : {}),
    files: p.hashes
  })
  const want = [
    `${psQuote(CORE_EXE)} = ${psQuote(p.hashes[CORE_EXE])}`,
    `'wintun.dll' = ${psQuote(p.hashes['wintun.dll'])}`,
    ...(lan ? [`${psQuote(LAN_EXE)} = ${psQuote(p.hashes[LAN_EXE] ?? '')}`] : []),
    ...(dpi ? DPI_ALL.map((f) => `${psQuote(f)} = ${psQuote(p.hashes[f] ?? '')}`) : [])
  ].join('; ')
  // <Root>\lan\<SID>: the LAN daemon's node key — SYSTEM / Administrators only
  const secureDirs = p.testRoot
    ? `foreach ($d in @($Root, $Bin, (Join-Path $Root 'u'), $Dir, (Join-Path $Dir 'rules')${lan ? ", (Join-Path $Root 'lan'), $LanDir, (Join-Path $LanDir 'pd'), (Join-Path $LanDir 'tmp')" : ''}${dpi ? ', $DpiRoot, $DpiBin' : ''})) { $null = [IO.Directory]::CreateDirectory($d) }`
    : `Secure-Dir $Root $Shared
  Secure-Dir $Bin $Shared
  Secure-Dir (Join-Path $Root 'u') $Shared
  Secure-Dir $Dir $Mine
  Secure-Dir (Join-Path $Dir 'rules') $Mine${
    lan
      ? `
  Secure-Dir (Join-Path $Root 'lan') $Admins
  Secure-Dir $LanDir $Admins
  Secure-Dir (Join-Path $LanDir 'pd') $Admins
  Secure-Dir (Join-Path $LanDir 'tmp') $Admins`
      : ''
  }${
    dpi
      ? `
  Secure-Dir $DpiRoot $Admins
  Clean-CygwinRoot
  Secure-Dir $DpiBin $Admins
  Secure-Dir (Join-Path $Root 'tmp') $Admins`
      : ''
  }`
  const registerTask = p.testRoot
    ? ''
    : `$PsX = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\\v1.0\\powershell.exe'
  $DirX = [Security.SecurityElement]::Escape($Dir)
  $BrokerX = [Security.SecurityElement]::Escape($BrokerX)
  $PsX = [Security.SecurityElement]::Escape($PsX)
  $Xml = @"
${taskXml('tun')}
"@
  $svc = New-Object -ComObject 'Schedule.Service'
  $svc.Connect()
  $folder = $svc.GetFolder('\\')
  # the user may read and run the task (FRFX), never change it
  $TaskSddl = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;' + $Sid + ')'
  $null = $folder.RegisterTask($TaskName, $Xml, 6, $null, $null, 5, $TaskSddl)${
    lan
      ? `
  $LanBrokerX = [Security.SecurityElement]::Escape($LanBrokerX)
  $LanXml = @"
${taskXml('lan')}
"@
  $null = $folder.RegisterTask($LanTaskName, $LanXml, 6, $null, $null, 5, $TaskSddl)`
      : ''
  }${
    dpi
      ? `
  $DpiBrokerX = [Security.SecurityElement]::Escape($DpiBrokerX)
  $DpiXml = @"
${taskXml('dpi')}
"@
  $null = $folder.RegisterTask($DpiTaskName, $DpiXml, 6, $null, $null, 5, $TaskSddl)`
      : ''
  }`
  return `
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$Sid = ${psQuote(p.sid)}
$SrcBin = ${psQuote(p.srcBinDir)}
$TaskName = ${psQuote(taskName(p.sid))}
$LanTaskName = ${psQuote(lanTaskName(p.sid))}
$DpiTaskName = ${psQuote(dpiTaskName(p.sid))}
$Want = @{ ${want} }
$Manifest = ${psQuote(manifest)}
$BrokerText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$LanBrokerText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${lanB64}'))
$DpiBrokerText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${dpiB64}'))
$Root = ${rootExpr(p.testRoot)}
$Dir = Join-Path $Root ('u\\' + $Sid)
$Bin = Join-Path $Root 'bin'
$LanDir = Join-Path $Root ('lan\\' + $Sid)
# zapret: SYSTEM / Administrators only — cygwin1.dll takes its parent ($DpiRoot) as
# the Cygwin root (etc\fstab, passwd…), and no user process may load that copy
$DpiRoot = Join-Path $Root 'dpi'
$DpiBin = Join-Path $DpiRoot 'bin'
$Trusted = @('S-1-5-32-544', 'S-1-5-18')
$Shared = 'O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'
$Mine = 'O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $Sid + ')'
$Admins = 'O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$DpiNames = @(${DPI_ALL.map(psQuote).join(', ')})

function Sha([string]$p) {
  $h = [Security.Cryptography.SHA256]::Create()
  $f = [IO.File]::OpenRead($p)
  try { return ([BitConverter]::ToString($h.ComputeHash($f)) -replace '-', '').ToLowerInvariant() } finally { $f.Dispose() }
}
function Owner-Of([string]$p) {
  $fi = New-Object IO.FileInfo($p)
  if ([IO.Directory]::Exists($p)) { $fi = New-Object IO.DirectoryInfo($p) }
  return $fi.GetAccessControl('Owner').GetOwner([Security.Principal.SecurityIdentifier]).Value
}
function Secure-Dir([string]$path, [string]$sddl) {
  $ds = New-Object Security.AccessControl.DirectorySecurity
  $ds.SetSecurityDescriptorSddlForm($sddl)
  if ([IO.Directory]::Exists($path) -or [IO.File]::Exists($path)) {
    $reparse = ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if ($reparse -or -not [IO.Directory]::Exists($path) -or $Trusted -notcontains (Owner-Of $path)) {
      # planted by someone else: move it out of the way, never reuse it
      $junk = $path + '.untrusted-' + [Guid]::NewGuid().ToString('N')
      if ([IO.Directory]::Exists($path)) { [IO.Directory]::Move($path, $junk) } else { [IO.File]::Move($path, $junk) }
      if ($reparse) { try { [IO.Directory]::Delete($junk) } catch {} }
    } else {
      [IO.Directory]::SetAccessControl($path, $ds)
      foreach ($e in [IO.Directory]::GetFileSystemEntries($path)) {
        $bad = (([IO.File]::GetAttributes($e) -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or ($Trusted -notcontains (Owner-Of $e))
        if ($bad) {
          if ([IO.Directory]::Exists($e)) { [IO.Directory]::Move($e, $e + '.untrusted-' + [Guid]::NewGuid().ToString('N')) } else { [IO.File]::Delete($e) }
        }
      }
    }
  }
  if (-not [IO.Directory]::Exists($path)) { $null = [IO.Directory]::CreateDirectory($path, $ds) }
}
# a running LAN daemon (of any Windows user) holds its exe: it is stopped for the
# update — only processes of exactly this file; its broker reports the exit
function Stop-RunningFrom([string]$path) {
  foreach ($p in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($path)) -ErrorAction SilentlyContinue)) {
    try { if ($p.Path -ieq $path) { $p.Kill(); $null = $p.WaitForExit(5000) } } catch {}
  }
}
function Put-File([string]$src, [string]$name, [string]$dir = $Bin) {
  $dest = Join-Path $dir $name
  if ([IO.File]::Exists($dest) -and (Sha $dest) -eq $Want[$name]) { return }
  if (($name -eq ${psQuote(LAN_EXE)} -or $name -eq ${psQuote(DPI_EXE)}) -and [IO.File]::Exists($dest)) { Stop-RunningFrom $dest }
  $tmp = $dest + '.new'
  [IO.File]::Copy($src, $tmp, $true)
  if ((Sha $tmp) -ne $Want[$name]) { [IO.File]::Delete($tmp); throw ('файл подменён при копировании: ' + $name) }
  if (-not [IO.File]::Exists($dest)) { [IO.File]::Move($tmp, $dest); return }
  try { [IO.File]::Replace($tmp, $dest, [NullString]::Value) } catch {
    # a loaded driver / DLL can't be overwritten but can be renamed (zapret's WinDivert)
    if ($DpiNames -notcontains $name) { throw }
    [IO.File]::Move($dest, $dest + '.old-' + [Guid]::NewGuid().ToString('N'))
    [IO.File]::Move($tmp, $dest)
  }
}
# renamed copies of a loaded WinDivert / DLL (Put-File) — gone once nothing holds them
function Remove-OldDpi([string]$dir) {
  if (-not [IO.Directory]::Exists($dir)) { return }
  foreach ($n in $DpiNames) {
    foreach ($f in [IO.Directory]::GetFiles($dir, $n + '.old-*')) { try { [IO.File]::Delete($f) } catch {} }
  }
}
# the Cygwin root holds only its bin folder — nothing else (etc, tmp…) may steer the SYSTEM copy
function Clean-CygwinRoot {
  foreach ($e in [IO.Directory]::GetFileSystemEntries($DpiRoot)) {
    try {
      $leaf = [IO.Path]::GetFileName($e)
      $link = ([IO.File]::GetAttributes($e) -band [IO.FileAttributes]::ReparsePoint) -ne 0
      $isDir = [IO.Directory]::Exists($e)
      if ($leaf -eq 'bin' -and $isDir -and -not $link) { continue }
      if ($link) {
        # a link itself is removed, never what it points to
        if ($isDir) { [IO.Directory]::Delete($e) } else { [IO.File]::Delete($e) }
      } elseif ($leaf -like '*.untrusted-*') {
        # moved aside earlier: left as it is, never deleted recursively
        continue
      } elseif ($isDir -or $Trusted -notcontains (Owner-Of $e)) {
        # an etc / tmp (or anything of somebody else): moved aside, never deleted recursively
        $junk = $e + '.untrusted-' + [Guid]::NewGuid().ToString('N')
        if ($isDir) { [IO.Directory]::Move($e, $junk) } else { [IO.File]::Move($e, $junk) }
      } else { [IO.File]::Delete($e) }
    } catch {}
  }
}
# 0.7.0 test builds put zapret into the shared bin (users: read & run): moved out
function Remove-DpiFromBin {
  foreach ($n in $DpiNames) {
    $f = Join-Path $Bin $n
    if (-not [IO.File]::Exists($f)) { continue }
    if ($n -eq ${psQuote(DPI_EXE)}) { Stop-RunningFrom $f }
    try { [IO.File]::Delete($f) } catch {
      # a loaded WinDivert64.sys: renamed now, deleted by a later install
      try { [IO.File]::Move($f, $f + '.old-' + [Guid]::NewGuid().ToString('N')) } catch {}
    }
  }
  Remove-OldDpi $Bin
}
${legacyCleanupPs()}

try {
  ${secureDirs}
  Put-File (Join-Path $SrcBin ${psQuote(CORE_EXE)}) ${psQuote(CORE_EXE)}
  Put-File (Join-Path $SrcBin 'wintun.dll') 'wintun.dll'
  $BrokerX = Join-Path $Dir 'broker.ps1'
  [IO.File]::WriteAllText($BrokerX, $BrokerText, (New-Object Text.UTF8Encoding($true)))${
    lan
      ? `
  Put-File (Join-Path $SrcBin ${psQuote(LAN_EXE)}) ${psQuote(LAN_EXE)}
  $LanBrokerX = Join-Path $Dir 'lan-broker.ps1'
  [IO.File]::WriteAllText($LanBrokerX, $LanBrokerText, (New-Object Text.UTF8Encoding($true)))`
      : ''
  }${
    dpi
      ? `
  try { Remove-OldDpi $DpiBin } catch {}
${DPI_ALL.map((f) => `  Put-File (Join-Path $SrcBin ${psQuote(f)}) ${psQuote(f)} $DpiBin`).join('\n')}
  try { Remove-DpiFromBin } catch {}
  $DpiBrokerX = Join-Path $Dir 'dpi-broker.ps1'
  [IO.File]::WriteAllText($DpiBrokerX, $DpiBrokerText, (New-Object Text.UTF8Encoding($true)))`
      : ''
  }
  ${registerTask}
  [IO.File]::WriteAllText((Join-Path $Dir 'manifest.json'), $Manifest, (New-Object Text.UTF8Encoding($false)))
  try { [IO.File]::Delete((Join-Path $Dir 'install-error.txt')) } catch {}
  # last: until here the old setup still works if something above fails
  try { Remove-LegacyCores } catch {}
  exit 0
} catch {
  try { [IO.File]::WriteAllText((Join-Path $Dir 'install-error.txt'), [string]$_.Exception.Message, (New-Object Text.UTF8Encoding($false))) } catch {}
  exit 2
}
`.trim()
}

/** Elevated remover («Удалить службу TUN»). Exit 0 = ok. */
export function uninstallScript(sid: string): string {
  if (!isValidSid(sid)) throw new Error('bad sid')
  return `
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$Sid = ${psQuote(sid)}
$TaskName = ${psQuote(taskName(sid))}
$LanTaskName = ${psQuote(lanTaskName(sid))}
$DpiTaskName = ${psQuote(dpiTaskName(sid))}
$Root = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'CipherWay'
$Dir = Join-Path $Root ('u\\' + $Sid)
$LanDir = Join-Path $Root ('lan\\' + $Sid)
$LanExe = Join-Path (Join-Path $Root 'bin') ${psQuote(LAN_EXE)}
$DpiExes = @((Join-Path $Root ('dpi\\bin\\' + ${psQuote(DPI_EXE)})), (Join-Path (Join-Path $Root 'bin') ${psQuote(DPI_EXE)}))
$DpiHosts = Join-Path $Dir 'dpi\\hosts.txt'
try {
  $svc = New-Object -ComObject 'Schedule.Service'
  $svc.Connect()
  try { $svc.GetFolder('\\').DeleteTask($TaskName, 0) } catch {}
  try { $svc.GetFolder('\\').DeleteTask($LanTaskName, 0) } catch {}
  try { $svc.GetFolder('\\').DeleteTask($DpiTaskName, 0) } catch {}
  # this user's zapret (its pid from the broker's state, only if it runs our file)
  try {
    $st = [IO.File]::ReadAllText((Join-Path $Dir 'dpi-state.json')) | ConvertFrom-Json
    $o = [Diagnostics.Process]::GetProcessById([int]$st.dpiPid)
    $cl = [string](Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$o.Id)).CommandLine
    $mine = $cl.IndexOf('"--hostlist=' + $DpiHosts + '"', [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($DpiExes -contains $o.MainModule.FileName -and $mine) { $o.Kill(); $null = $o.WaitForExit(5000) }
  } catch {}
  # this user's LAN daemon (its pid from the broker's state, only if it runs our file)
  try {
    $st = [IO.File]::ReadAllText((Join-Path $Dir 'lan-state.json')) | ConvertFrom-Json
    $o = [Diagnostics.Process]::GetProcessById([int]$st.pid)
    $cl = [string](Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$o.Id)).CommandLine
    $mine = $cl.IndexOf('"--statedir=' + $LanDir + '"', [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($o.MainModule.FileName -ieq $LanExe -and $mine) { $o.Kill(); $null = $o.WaitForExit(5000) }
  } catch {}
  # our own folders only ever contain files the installer / broker / daemon wrote
  if ([IO.Directory]::Exists($Dir)) { [IO.Directory]::Delete($Dir, $true) }
  if ([IO.Directory]::Exists($LanDir)) { [IO.Directory]::Delete($LanDir, $true) }
  $u = Join-Path $Root 'u'
  if ([IO.Directory]::Exists($u) -and [IO.Directory]::GetFileSystemEntries($u).Length -eq 0) {
    try { [IO.Directory]::Delete($Root, $true) } catch {}
  }
  exit 0
} catch {
  exit 2
}
`.trim()
}

/**
 * Non-elevated launcher of an elevated script: one UAC prompt.
 * Exit code: the script's own, 1223 = the user said no.
 */
export function elevateCommand(scriptPath: string): string {
  return `try { $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psQuote(`"${scriptPath}"`)}); exit $p.ExitCode } catch { exit 1223 }`
}
