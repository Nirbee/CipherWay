import { psGuid, psQuote, WINTUN_DEVICE_PS } from '../core/broker'
import { LAN_EXE, LAN_TUN_NAME, LAN_UDP_PORT, TAILSCALE_ADAPTER_GUID } from '../core/coreNames'
import {
  BROKER_HELPERS_PS,
  HASH_RE,
  isValidSid,
  lanTaskName,
  rootExpr
} from '../core/serviceScripts'

export { lanTaskName }

// ---------------------------------------------------------------------------
// «LAN» (0.5.0): the LAN daemon (tailscaled.exe of the official Tailscale
// Windows build, shipped as cipherway-lan.exe) needs SYSTEM rights for its
// wintun adapter. It runs through the same «Служба CipherWay» as the TUN core:
// a second Task Scheduler task «CipherWay LAN <SID>», registered by the same
// installer (one UAC prompt for both), running this broker as SYSTEM.
//
// What the broker allows — the whole allow-list, nothing comes from the user:
//  * the program: only <Root>\bin\cipherway-lan.exe, the copy the installer
//    made into the protected folder; its SHA-256 (and that of wintun.dll it
//    loads) is baked into this script and checked before every start;
//  * the arguments: fixed, built here from the SID alone —
//      --statedir=<Root>\lan\<SID>   (SYSTEM / Administrators only: node key)
//      --socket=\\.\pipe\ProtectedPrefix\Administrators\CipherWay\lan-<SID>
//      --tun=CipherWay LAN  --port=41642  --no-logs-no-support  --syspolicy-file=
//    + TS_LOGS_DIR=<statedir>, and ProgramData / ALLUSERSPROFILE / TEMP / TMP
//    pointed into <statedir> (pd, tmp — admin-only). tailscaled reads
//    %ProgramData%\Tailscale\tailscaled-env.txt (envknob.ApplyDiskConfig) and
//    writes audit-log.json there; the real %ProgramData%\Tailscale may not exist
//    and any user can create it — a planted env file (TS_LOGS_DIR + a junction)
//    would be a SYSTEM write primitive. With the redirect it is never looked at.
//    --syspolicy-file=<statedir>\syspolicy.json, written here with fixed content:
//    no updates, no DNS / subnets from the server, never an exit node.
//    Not --socket / --statedir / --tun / --port of
//    the user's Tailscale (\\.\pipe\…\Tailscale\tailscaled, ProgramData\Tailscale,
//    «Tailscale», 41641), not its syspolicy.json, no log upload to Tailscale Inc.
//  * the request: <userRun>\lan-ctl.json {session, pid, cmd, ts} — read only,
//    size-limited, never through a link; only `cmd` and the app pid matter.
//    A run needs a fresh request (< 2 min) from a live app process.
//  * never at the same time as the user's own Tailscale: the official binary
//    shares machine-wide names with it (the wintun adapter GUID compiled into
//    it, the «Tailscale-In» / «Tailscale-Process» firewall rules, the NRPT rule
//    list in HKLM\SOFTWARE\Tailscale IPN). While the «Tailscale» service runs,
//    a tailscaled.exe is alive or an adapter with that GUID exists, the broker
//    refuses to start — and stops ours as soon as one of them appears.
//  * its wintun adapter (0.5.1): the device a killed daemon left behind is
//    removed before the start (a re-used one often fails after 15 s), and the
//    daemon is never killed while it is creating its adapter — that left Windows
//    unable to start any wintun adapter, the TUN one included, for minutes.
//    Both only for the GUID compiled into the daemon (WINTUN_DEVICE_PS).
// Talking to the app (files, the broker polls every 500 ms):
//   <userRun>\lan-ctl.json   app → broker
//   <home>\lan-state.json    broker → app {session,status,error,detail,pid,exitCode,uptimeMs,stopReason,ts}
//   <home>\lan.log           the daemon's stderr (its log), read by the app
//   <home>\lan-broker.log    what the broker did and why
// <home> = <Root>\u\<SID> (user: read only). Pure — unit tested in
// lanBroker.test.ts, the broker itself runs (non-elevated, a fake daemon) in
// lanBroker.it.test.ts.
// ---------------------------------------------------------------------------

export interface LanBrokerHashes {
  [LAN_EXE]: string
  'wintun.dll': string
}

/** «another Tailscale is running»: what the broker looks for (tests: fake names) */
export interface OtherTailscale {
  service: string
  process: string
  adapterGuid: string
}

export const OFFICIAL_TAILSCALE: OtherTailscale = {
  service: 'Tailscale',
  process: 'tailscaled',
  adapterGuid: TAILSCALE_ADAPTER_GUID
}

export interface LanBrokerParams {
  sid: string
  /** the app's run folder (lan-ctl.json) — read only */
  userRunDir: string
  hashes: LanBrokerHashes
  /** tests only: a temp folder instead of %ProgramData%\CipherWay */
  rootOverride?: string
  /** tests only */
  other?: OtherTailscale
  /** tests only: the adapter name / port the daemon gets */
  tunName?: string
  port?: number
}

/** Broker error codes in lan-state.json (the app turns them into Russian text). */
export type LanBrokerError =
  '' | 'no_request' | 'tailscale_running' | 'lan_busy' | 'exited' | 'failed'

/**
 * The daemon's LocalAPI pipe. tailscaled (default --windows-mode) accepts only
 * names under \\.\pipe\ProtectedPrefix\Administrators\ — only administrators
 * can create pipes there, so the CLI knows it talks to a privileged daemon.
 */
export function lanPipeName(sid: string): string {
  if (!isValidSid(sid)) throw new Error('bad sid')
  return `\\\\.\\pipe\\ProtectedPrefix\\Administrators\\CipherWay\\lan-${sid}`
}

/**
 * Fixed device policy of our daemon (its own --syspolicy-file, so also above any
 * HKLM policy of a Tailscale on the PC): never updates itself (Windows would get the
 * official MSI installed), never takes DNS or subnet routes from the server, never
 * offers itself as an exit node. Values checked against util/syspolicy 1.104.7.
 */
export const LAN_SYSPOLICY = {
  InstallUpdates: 'never',
  CheckUpdates: 'never',
  UseTailscaleDNSSettings: 'never',
  UseTailscaleSubnets: 'never',
  AdvertiseExitNode: 'never'
} as const

/** The SYSTEM-side LAN broker (installed into <home>\lan-broker.ps1). */
export function lanBrokerScript(p: LanBrokerParams): string {
  if (!isValidSid(p.sid)) throw new Error('bad sid')
  for (const h of Object.values(p.hashes)) if (!HASH_RE.test(h)) throw new Error('bad hash')
  const other = p.other ?? OFFICIAL_TAILSCALE
  const port = Math.trunc(p.port ?? LAN_UDP_PORT)
  if (!(port > 0 && port < 65536)) throw new Error('bad port')
  const POLICY_JSON = JSON.stringify(LAN_SYSPOLICY)
  return `
# CipherWay VPN — LAN service broker. Runs as SYSTEM from Task Scheduler.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$Sid = ${psQuote(p.sid)}
$UserRun = ${psQuote(p.userRunDir)}
$Root = ${rootExpr(p.rootOverride)}
$Dir = Join-Path $Root ('u\\' + $Sid)
$Bin = Join-Path $Root 'bin'
$Exe = Join-Path $Bin ${psQuote(LAN_EXE)}
$LanDir = Join-Path $Root ('lan\\' + $Sid)
$Pipe = ${psQuote(lanPipeName(p.sid))}
$TunName = ${psQuote(p.tunName ?? LAN_TUN_NAME)}
$Port = ${port}
$StateF = Join-Path $Dir 'lan-state.json'
$BrokerLog = Join-Path $Dir 'lan-broker.log'
$LogF = Join-Path $Dir 'lan.log'
$OutF = Join-Path $Dir 'lan-out.log'
$CtlF = Join-Path $UserRun 'lan-ctl.json'
$Pd = Join-Path $LanDir 'pd'
$TmpD = Join-Path $LanDir 'tmp'
$PolicyF = Join-Path $LanDir 'syspolicy.json'
$Policy = ${psQuote(POLICY_JSON)}
$Hashes = @{ ${psQuote(LAN_EXE)} = ${psQuote(p.hashes[LAN_EXE])}; 'wintun.dll' = ${psQuote(p.hashes['wintun.dll'])} }
$OtherService = ${psQuote(other.service)}
$OtherProcess = ${psQuote(other.process)}
$OtherGuid = ${psQuote(other.adapterGuid)}
# the same binary: our daemon's wintun adapter has this GUID too
$OwnGuid = ${psGuid(other.adapterGuid)}
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$State = @{ session = ''; status = 'starting'; error = ''; detail = ''; pid = 0; exitCode = $null; uptimeMs = $null; stopReason = ''; brokerPid = $PID; ts = 0 }
${BROKER_HELPERS_PS}
${WINTUN_DEVICE_PS}
# the only command line the daemon ever gets (quoted tokens, no trailing backslash)
function Daemon-Args {
  return ('"--statedir=' + $LanDir + '" "--socket=' + $Pipe + '" "--tun=' + $TunName + '" --port=' + $Port + ' --no-logs-no-support "--syspolicy-file=' + $PolicyF + '"')
}
# the user's own Tailscale (or a tailscaled.exe by hand): the official binary shares
# machine-wide names with it, so the two never run together
function Other-Tailscale([bool]$adapters) {
  try {
    $s = Get-Service -Name $OtherService -ErrorAction Stop
    if ([string]$s.Status -ne 'Stopped') { return ('служба ' + $OtherService) }
  } catch {}
  if (@(Get-Process -Name $OtherProcess -ErrorAction SilentlyContinue).Count -gt 0) { return ('процесс ' + $OtherProcess + '.exe') }
  if ($adapters) {
    try {
      foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($n.Id -ieq $OtherGuid -and $n.Name -ne $TunName) { return ('адаптер ' + $n.Name) }
      }
    } catch {}
  }
  return $null
}
function Own-Adapter {
  try {
    foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) { if ($n.Name -eq $TunName) { return $true } }
  } catch {}
  return $false
}
# our daemon = our file AND our state dir in its command line (a pid may be reused,
# the same file may run for another Windows user)
function Is-OurDaemon($o) {
  try {
    if ($o.MainModule.FileName -ine $Exe) { return $false }
    $cl = [string](Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$o.Id)).CommandLine
    return $cl.IndexOf('"--statedir=' + $LanDir + '"', [StringComparison]::OrdinalIgnoreCase) -ge 0
  } catch { return $false }
}
# never in the middle of creating its wintun adapter (see the header): an attempt
# takes up to ~16 s (wintun waits 15 s for the device), the next one starts at once
# $report: the app sees «stopping» meanwhile (and waits before the next start)
function Kill-Daemon($p, [bool]$report) {
  if ($p.HasExited) { return }
  if (Wintun-Creating $OwnGuid $TunName) {
    Note 'LAN ещё создаёт сетевой адаптер — ждём, прежде чем остановить'
    $was = $State.status
    if ($report) { $State.status = 'stopping' }
    $end = (Now-Ms) + 20000
    while ((Now-Ms) -lt $end -and -not $p.HasExited -and (Wintun-Creating $OwnGuid $TunName)) {
      if ($report) { try { Save-State } catch {} }
      Start-Sleep -Milliseconds 300
    }
    $State.status = $was
  }
  if (-not $p.HasExited) { $p.Kill(); $null = $p.WaitForExit(5000) }
}
# a daemon of an earlier session that outlived its broker (only that pid)
# the daemon pid an earlier broker left in the state file — read BEFORE this
# broker writes its own state (Save-State would overwrite it with 0)
function Prev-Pid {
  try {
    if (-not [IO.File]::Exists($StateF)) { return [long]0 }
    return (Num ([IO.File]::ReadAllText($StateF, $Utf8) | ConvertFrom-Json).pid)
  } catch { return [long]0 }
}
function Stop-Orphan([long]$id) {
  try {
    if ($id -le 0) { return }
    $o = [Diagnostics.Process]::GetProcessById([int]$id)
    if (Is-OurDaemon $o) {
      Kill-Daemon $o $false
      Note ('остановлен LAN прошлого запуска, pid ' + $id)
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
function Start-Daemon {
  foreach ($k in @($Hashes.Keys)) {
    if ((Sha (Join-Path $Bin $k)) -ne $Hashes[$k]) { throw ('cw- файл LAN изменён: ' + $k) }
  }
  if (-not [IO.Directory]::Exists($LanDir) -or (Is-Reparse $LanDir)) { throw 'cw- нет защищённой папки LAN — обновите службу' }
  # pd / tmp: created inside the admin-only $LanDir (they inherit its ACL), never a link
  foreach ($d in @($Pd, $TmpD)) {
    if ([IO.Directory]::Exists($d) -or [IO.File]::Exists($d)) {
      if ((Is-Reparse $d) -or -not [IO.Directory]::Exists($d)) { throw 'cw- папка LAN подменена' }
    } else { $null = [IO.Directory]::CreateDirectory($d) }
  }
  if ((Is-Reparse $PolicyF)) { throw 'cw- файл политики LAN подменён' }
  Write-Atomic $PolicyF $Policy
  # the adapter of the previous run normally goes with its process; the device it
  # leaves behind is removed (nobody else uses the GUID: Other-Tailscale said so)
  for ($i = 0; $i -lt 20 -and (Own-Adapter); $i++) { Start-Sleep -Milliseconds 250 }
  Remove-WintunGhost $OwnGuid
  Rotate $LogF
  Rotate $OutF
  # its log state (tailscaled.log.conf) next to its node state, not in ProgramData\\Tailscale;
  # nothing of the real ProgramData (tailscaled-env.txt, audit log, syspolicy) — see above
  $env:TS_LOGS_DIR = $LanDir
  $env:ProgramData = $Pd
  $env:ALLUSERSPROFILE = $Pd
  $env:TEMP = $TmpD
  $env:TMP = $TmpD
  $d = Start-Process -FilePath $Exe -ArgumentList (Daemon-Args) -WorkingDirectory $LanDir -NoNewWindow -PassThru -RedirectStandardError $LogF -RedirectStandardOutput $OutF
  $null = $d.Handle
  $script:Started = Now-Ms
  $State.pid = $d.Id
  $State.exitCode = $null
  $State.uptimeMs = $null
  Note ('LAN запущен, pid ' + $d.Id)
  return $d
}
function Stop-Daemon($d) {
  if ($null -eq $d) { return }
  try { Kill-Daemon $d $true } catch {}
}

$daemon = $null
try {
  $ctl = Read-Ctl
  if ($null -ne $ctl) { $State.session = [string]$ctl.session }
  if ($null -eq $ctl -or $ctl.cmd -cne 'run' -or [math]::Abs((Now-Ms) - (Num $ctl.ts)) -gt 120000 -or -not (Alive (Num $ctl.pid))) {
    $State.status = 'refused'
    $State.error = 'no_request'
    exit 0
  }
  # the orphan's pid first: the next Save-State overwrites the file it is in
  $orphan = Prev-Pid
  # the app waits for this session id: it knows the task really started
  # (before Stop-Orphan: that one may wait for an adapter being created)
  Save-State
  Stop-Orphan $orphan
  $busy = Other-Tailscale $true
  if ($busy) {
    $State.status = 'refused'
    $State.error = 'tailscale_running'
    $State.detail = $busy
    Note ('не запускаем: работает Tailscale (' + $busy + ')')
    exit 0
  }
  if (@(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($Exe)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $Exe }).Count -gt 0) {
    $State.status = 'refused'
    $State.error = 'lan_busy'
    Note 'не запускаем: LAN уже работает у другого пользователя Windows'
    exit 0
  }
  $daemon = Start-Daemon
  $State.status = 'running'
  Save-State
  $tick = 0
  $miss = 0
  while ($true) {
    Start-Sleep -Milliseconds 500
    $tick++
    if ($daemon.HasExited) {
      $State.exitCode = $daemon.ExitCode
      $State.uptimeMs = (Now-Ms) - $script:Started
      $State.error = 'exited'
      $State.stopReason = 'LAN завершился сам'
      Note ('LAN завершился сам: код ' + $State.exitCode + ', через ' + [math]::Round($State.uptimeMs / 1000, 1) + ' с')
      break
    }
    $c = Read-Ctl
    if ($null -eq $c) {
      $miss++
      if ($miss -gt 6) { $State.stopReason = 'нет файла запроса'; break }
      continue
    }
    $miss = 0
    if ($c.session -ne $State.session) { $State.stopReason = 'новая сессия'; break }
    if ($c.cmd -ne 'run') { $State.stopReason = 'команда остановки'; break }
    if (($tick % 4) -eq 0) {
      if (-not (Alive (Num $c.pid))) { $State.stopReason = 'приложение закрыто'; break }
      $busy = Other-Tailscale $false
      if ($busy) {
        $State.error = 'tailscale_running'
        $State.detail = $busy
        $State.stopReason = 'запущен Tailscale (' + $busy + ')'
        break
      }
      Save-State
    }
  }
  $State.status = 'stopped'
} catch {
  # a fixed text only: our own message, never an exception text
  $m = [string]$_.Exception.Message
  $State.status = 'error'
  $State.error = 'failed'
  $State.detail = $(if ($m.StartsWith('cw- ')) { $m.Substring(4) } else { 'LAN не запустился' })
  Note ('ошибка: ' + $State.detail + $(if ($m.StartsWith('cw- ')) { '' } else { ' (' + $_.Exception.GetType().Name + ')' }))
} finally {
  Stop-Daemon $daemon
  if ($State.stopReason) { Note ('LAN остановлен: ' + $State.stopReason) }
  if ($State.status -eq 'running' -or $State.status -eq 'starting') { $State.status = 'stopped' }
  try { Save-State } catch {}
}
`.trim()
}

/** What lan-state.json holds (written by the broker above). */
export interface LanBrokerState {
  session?: string
  /** stopping: waits for the daemon to finish creating its adapter (≤ 20 s) */
  status?: 'starting' | 'running' | 'stopping' | 'stopped' | 'refused' | 'error'
  error?: LanBrokerError
  detail?: string
  pid?: number
  exitCode?: number | null
  uptimeMs?: number | null
  stopReason?: string
  ts?: number
}

/** A state file → LanBrokerState; a half-written or foreign file gives null. */
export function parseLanState(text: string): LanBrokerState | null {
  try {
    const o = JSON.parse(text.replace(/^\ufeff/, '')) as Record<string, unknown>
    if (!o || typeof o !== 'object') return null
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
    const status = str(o.status)
    return {
      session: str(o.session),
      status: (['starting', 'running', 'stopping', 'stopped', 'refused', 'error'] as const).find(
        (s) => s === status
      ),
      error: (
        ['', 'no_request', 'tailscale_running', 'lan_busy', 'exited', 'failed'] as const
      ).find((s) => s === o.error),
      detail: str(o.detail),
      pid: num(o.pid),
      exitCode: typeof o.exitCode === 'number' ? o.exitCode : null,
      uptimeMs: typeof o.uptimeMs === 'number' ? o.uptimeMs : null,
      stopReason: str(o.stopReason),
      ts: num(o.ts)
    }
  } catch {
    return null
  }
}
