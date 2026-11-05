import { psQuote } from './broker'

// ---------------------------------------------------------------------------
// «Служба TUN» (0.4.2): instead of a UAC prompt on every TUN connect, the
// user approves ONE prompt that registers a Task Scheduler task running as
// SYSTEM. After that the app starts it with `schtasks /run` (no prompt).
//
// The app lives in %LOCALAPPDATA%\Programs — writable by any process of the
// user. A task that ran anything from there with admin rights would be a
// UAC bypass for every piece of malware, so:
//  * the installer (under UAC) copies sing-box.exe + wintun.dll and writes the
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
//   <home>\state.json        broker → app {session,status,restart,rules,exitCode,error,ts}
// <home> = %ProgramData%\CipherWay\u\<user SID>. Pure — unit tested in
// broker.test.ts, the broker itself runs (non-elevated) in the e2e test.
// ---------------------------------------------------------------------------

export const SYSTEM_SID = 'S-1-5-18'

export interface BrokerHashes {
  'sing-box.exe': string
  'wintun.dll': string
}

export interface ServiceBrokerParams {
  /** SID of the user the service belongs to (not the elevating admin) */
  sid: string
  /** the app's run folder (config.json, rules\, tun-ctl.json) — read only */
  userRunDir: string
  hashes: BrokerHashes
  /** tests only: a temp folder instead of %ProgramData%\CipherWay */
  rootOverride?: string
}

const SID_RE = /^S-1-5-21(-\d{1,10}){3,6}$|^S-1-5-18$/
export function isValidSid(sid: string): boolean {
  return SID_RE.test(sid)
}
const HASH_RE = /^[0-9a-f]{64}$/

export function taskName(sid: string): string {
  return `CipherWay TUN ${sid}`
}

function rootExpr(override?: string): string {
  return override
    ? psQuote(override)
    : `(Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'CipherWay')`
}

/** The SYSTEM-side broker (installed into <home>\broker.ps1). */
export function serviceBrokerScript(p: ServiceBrokerParams): string {
  if (!isValidSid(p.sid)) throw new Error('bad sid')
  for (const h of Object.values(p.hashes)) if (!HASH_RE.test(h)) throw new Error('bad hash')
  return `
# CipherWay VPN — TUN service broker. Runs as SYSTEM from Task Scheduler.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$Sid = ${psQuote(p.sid)}
$UserRun = ${psQuote(p.userRunDir)}
$Root = ${rootExpr(p.rootOverride)}
$Dir = Join-Path $Root ('u\\' + $Sid)
$Bin = Join-Path $Root 'bin'
$Exe = Join-Path $Bin 'sing-box.exe'
$RulesOut = Join-Path $Dir 'rules'
$CfgOut = Join-Path $Dir 'config.json'
$LogOut = Join-Path $Dir 'sing-box.log'
$StateF = Join-Path $Dir 'state.json'
$CtlF = Join-Path $UserRun 'tun-ctl.json'
$CfgIn = Join-Path $UserRun 'config.json'
$RulesIn = Join-Path $UserRun 'rules'
$Hashes = @{ 'sing-box.exe' = ${psQuote(p.hashes['sing-box.exe'])}; 'wintun.dll' = ${psQuote(p.hashes['wintun.dll'])} }
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$NameRe = '^cw-[0-9a-z-]{1,40}\\.json$'
$Forbidden = '(?i)(path|file|dir|_ui|download|certificate|key|script|command|exec|acme|cache|store|platform)'
$OkOut = @('direct', 'socks', 'hysteria2', 'vmess', 'selector', 'urltest')
$OkDns = @('https', 'udp', 'tcp', 'tls', 'local')

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Is-Reparse([string]$p) {
  try { return (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) } catch { return $false }
}
function Read-UserFile([string]$p, [long]$max) {
  try {
    $fi = New-Object IO.FileInfo($p)
    if (-not $fi.Exists -or $fi.Length -gt $max) { return $null }
    if (($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
    return [IO.File]::ReadAllText($p, $Utf8)
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
  throw ('не удалось записать ' + $p)
}
$State = @{ session = ''; status = 'starting'; restart = 0; rules = 0; corePid = 0; exitCode = $null; error = ''; brokerPid = $PID; ts = 0 }
function Save-State { $State.ts = Now-Ms; Write-Atomic $StateF (ConvertTo-Json -Compress -InputObject $State) }
function Alive($id) {
  try { $null = [Diagnostics.Process]::GetProcessById([int]$id); return $true } catch { return $false }
}
function Read-Ctl {
  $t = Read-UserFile $CtlF 4096
  if (-not $t) { return $null }
  try { $c = $t | ConvertFrom-Json } catch { return $null }
  if (-not ($c.session -is [string]) -or $c.session -notmatch '^[0-9a-f]{16,64}$') { return $null }
  return $c
}
function Sha([string]$p) {
  $h = [Security.Cryptography.SHA256]::Create()
  $f = [IO.File]::OpenRead($p)
  try { return ([BitConverter]::ToString($h.ComputeHash($f)) -replace '-', '').ToLowerInvariant() } finally { $f.Dispose() }
}
function Test-Keys($node, [string]$where) {
  if ($null -eq $node) { return }
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    foreach ($q in $node.PSObject.Properties) {
      $w = $where + '.' + $q.Name
      if ($q.Name -match $Forbidden -and $w -notmatch '^\\.route\\.rule_set\\[\\d+\\]\\.path$') { throw ('запрещённое поле ' + $w) }
      Test-Keys $q.Value $w
    }
  } elseif ($node -is [array]) {
    for ($i = 0; $i -lt $node.Count; $i++) { Test-Keys $node[$i] ($where + '[' + $i + ']') }
  }
}
function Test-Config([string]$text) {
  if (-not $text) { throw 'нет конфигурации' }
  $c = $text | ConvertFrom-Json
  if (-not ($c -is [System.Management.Automation.PSCustomObject])) { throw 'конфигурация не объект' }
  foreach ($q in $c.PSObject.Properties) {
    if (@('log', 'dns', 'inbounds', 'outbounds', 'route', 'experimental') -notcontains $q.Name) { throw ('поле ' + $q.Name) }
  }
  Test-Keys $c ''
  if ($null -ne $c.log) {
    foreach ($q in $c.log.PSObject.Properties) { if (@('level', 'output', 'timestamp', 'disabled') -notcontains $q.Name) { throw ('log.' + $q.Name) } }
    if ($null -ne $c.log.output -and [string]$c.log.output -ne $LogOut) { throw 'log.output' }
  }
  if ($null -ne $c.experimental) {
    foreach ($q in $c.experimental.PSObject.Properties) { if ($q.Name -ne 'clash_api') { throw ('experimental.' + $q.Name) } }
    $ca = $c.experimental.clash_api
    if ($null -ne $ca) {
      foreach ($q in $ca.PSObject.Properties) { if (@('external_controller', 'default_mode', 'secret') -notcontains $q.Name) { throw ('clash_api.' + $q.Name) } }
      if ([string]$ca.external_controller -notmatch '^127\\.0\\.0\\.1:\\d{1,5}$') { throw 'clash_api.external_controller' }
    }
  }
  if ($null -ne $c.inbounds) { foreach ($x in @($c.inbounds)) { if ($x.type -ne 'tun') { throw ('вход ' + $x.type) } } }
  if ($null -ne $c.outbounds) { foreach ($x in @($c.outbounds)) { if ($OkOut -notcontains $x.type) { throw ('выход ' + $x.type) } } }
  if ($null -ne $c.dns -and $null -ne $c.dns.servers) { foreach ($x in @($c.dns.servers)) { if ($OkDns -notcontains $x.type) { throw ('DNS ' + $x.type) } } }
  if ($null -ne $c.route -and $null -ne $c.route.rule_set) {
    foreach ($x in @($c.route.rule_set)) {
      if ($x.type -ne 'local' -or $x.format -ne 'source') { throw 'rule_set: только local/source' }
      $leaf = [IO.Path]::GetFileName([string]$x.path)
      if ($leaf -notmatch $NameRe -or [string]$x.path -ne (Join-Path $RulesOut $leaf)) { throw ('rule_set.path ' + $x.path) }
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
  if (Is-Reparse $UserRun) { throw 'папка приложения — ссылка' }
  foreach ($k in @($Hashes.Keys)) {
    if ((Sha (Join-Path $Bin $k)) -ne $Hashes[$k]) { throw ('файл ядра изменён: ' + $k) }
  }
  $text = Read-UserFile $CfgIn 4194304
  Test-Config $text
  Write-Atomic $CfgOut $text
  Sync-Rules
}
function Start-Core {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = 'run -c "' + $CfgOut + '"'
  $psi.WorkingDirectory = $Bin
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  return [Diagnostics.Process]::Start($psi)
}
function Stop-Core($p) {
  if ($null -eq $p) { return }
  try { if (-not $p.HasExited) { $p.Kill(); $null = $p.WaitForExit(5000) } } catch {}
}

$core = $null
try {
  $ctl = Read-Ctl
  if ($null -ne $ctl) { $State.session = [string]$ctl.session }
  if ($null -eq $ctl -or $ctl.cmd -ne 'run' -or [math]::Abs((Now-Ms) - [long]$ctl.ts) -gt 120000 -or -not (Alive $ctl.pid)) {
    $State.status = 'refused'
    $State.error = 'нет свежего запроса на запуск'
    exit 0
  }
  $State.session = [string]$ctl.session
  $State.restart = [long]$ctl.restart
  $State.rules = [long]$ctl.rules
  Prepare
  $core = Start-Core
  $State.corePid = $core.Id
  $State.status = 'running'
  Save-State
  $tick = 0
  $idle = 0
  while ($true) {
    Start-Sleep -Milliseconds 250
    $tick++
    $c = Read-Ctl
    if ($null -eq $c -or $c.session -ne $State.session -or $c.cmd -ne 'run') { break }
    if ([long]$c.restart -gt $State.restart) {
      Stop-Core $core
      $core = $null
      Prepare
      $core = Start-Core
      $State.corePid = $core.Id
      $State.exitCode = $null
      $State.restart = [long]$c.restart
      $State.rules = [long]$c.rules
      $idle = 0
      Save-State
      continue
    }
    if ([long]$c.rules -gt $State.rules) {
      Sync-Rules
      $State.rules = [long]$c.rules
      Save-State
    }
    if ($core.HasExited) {
      if ($null -eq $State.exitCode) { $State.exitCode = $core.ExitCode; Save-State }
      $idle++
      if ($idle -gt 240) { break }
    }
    if (($tick % 8) -eq 0) {
      if (-not (Alive $c.pid)) { break }
      Save-State
    }
  }
  $State.status = 'stopped'
} catch {
  $State.status = 'error'
  $State.error = [string]$_.Exception.Message
} finally {
  Stop-Core $core
  if ($State.status -eq 'running' -or $State.status -eq 'starting') { $State.status = 'stopped' }
  try { Save-State } catch {}
}
`.trim()
}

export interface InstallParams {
  sid: string
  /** the app's resources\\bin (source of sing-box.exe / wintun.dll) */
  srcBinDir: string
  brokerText: string
  hashes: BrokerHashes
  /** sha256 of brokerText, stored in the manifest */
  brokerHash: string
  appVersion: string
}

/**
 * XML of the task: SYSTEM, highest, on demand only, no time limit, also on
 * battery, normal priority (the default 7 would make sing-box «below normal»).
 * $PsX / $BrokerX / $DirX are expanded (XML-escaped) by the installer's
 * PowerShell here-string.
 */
export function taskXml(): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>CipherWay VPN</Author><Description>CipherWay VPN: ядро sing-box в режиме TUN без запроса прав при каждом подключении</Description></RegistrationInfo>
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
  <Actions Context="Author"><Exec><Command>$PsX</Command><Arguments>-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$BrokerX"</Arguments><WorkingDirectory>$DirX</WorkingDirectory></Exec></Actions>
</Task>`
}

/** Elevated installer / updater (one UAC prompt). Exit 0 = ok. */
export function installScript(p: InstallParams): string {
  if (!isValidSid(p.sid)) throw new Error('bad sid')
  const b64 = Buffer.from(p.brokerText, 'utf8').toString('base64')
  const manifest = JSON.stringify({
    version: 1,
    app: p.appVersion,
    broker: p.brokerHash,
    files: p.hashes
  })
  return `
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$Sid = ${psQuote(p.sid)}
$SrcBin = ${psQuote(p.srcBinDir)}
$TaskName = ${psQuote(taskName(p.sid))}
$Want = @{ 'sing-box.exe' = ${psQuote(p.hashes['sing-box.exe'])}; 'wintun.dll' = ${psQuote(p.hashes['wintun.dll'])} }
$Manifest = ${psQuote(manifest)}
$BrokerText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$Root = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'CipherWay'
$Dir = Join-Path $Root ('u\\' + $Sid)
$Bin = Join-Path $Root 'bin'
$Trusted = @('S-1-5-32-544', 'S-1-5-18')
$Shared = 'O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'
$Mine = 'O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $Sid + ')'

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
function Put-File([string]$src, [string]$name) {
  $dest = Join-Path $Bin $name
  if ([IO.File]::Exists($dest) -and (Sha $dest) -eq $Want[$name]) { return }
  $tmp = $dest + '.new'
  [IO.File]::Copy($src, $tmp, $true)
  if ((Sha $tmp) -ne $Want[$name]) { [IO.File]::Delete($tmp); throw ('файл подменён при копировании: ' + $name) }
  if ([IO.File]::Exists($dest)) { [IO.File]::Replace($tmp, $dest, [NullString]::Value) } else { [IO.File]::Move($tmp, $dest) }
}

try {
  Secure-Dir $Root $Shared
  Secure-Dir $Bin $Shared
  Secure-Dir (Join-Path $Root 'u') $Shared
  Secure-Dir $Dir $Mine
  Secure-Dir (Join-Path $Dir 'rules') $Mine
  Put-File (Join-Path $SrcBin 'sing-box.exe') 'sing-box.exe'
  Put-File (Join-Path $SrcBin 'wintun.dll') 'wintun.dll'
  $BrokerX = Join-Path $Dir 'broker.ps1'
  [IO.File]::WriteAllText($BrokerX, $BrokerText, (New-Object Text.UTF8Encoding($true)))
  $PsX = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\\v1.0\\powershell.exe'
  $DirX = [Security.SecurityElement]::Escape($Dir)
  $BrokerX = [Security.SecurityElement]::Escape($BrokerX)
  $PsX = [Security.SecurityElement]::Escape($PsX)
  $Xml = @"
${taskXml()}
"@
  $svc = New-Object -ComObject 'Schedule.Service'
  $svc.Connect()
  $folder = $svc.GetFolder('\\')
  # the user may read and run the task (FRFX), never change it
  $TaskSddl = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;' + $Sid + ')'
  $null = $folder.RegisterTask($TaskName, $Xml, 6, $null, $null, 5, $TaskSddl)
  [IO.File]::WriteAllText((Join-Path $Dir 'manifest.json'), $Manifest, (New-Object Text.UTF8Encoding($false)))
  try { [IO.File]::Delete((Join-Path $Dir 'install-error.txt')) } catch {}
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
$Root = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'CipherWay'
$Dir = Join-Path $Root ('u\\' + $Sid)
try {
  $svc = New-Object -ComObject 'Schedule.Service'
  $svc.Connect()
  try { $svc.GetFolder('\\').DeleteTask($TaskName, 0) } catch {}
  # our own folders only ever contain files the installer / broker wrote
  if ([IO.Directory]::Exists($Dir)) { [IO.Directory]::Delete($Dir, $true) }
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
