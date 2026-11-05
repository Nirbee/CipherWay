import { TUN_INTERFACE } from './coreNames'

// ---------------------------------------------------------------------------
// TUN mode: sing-box needs admin rights, so it runs under an elevated
// PowerShell "broker" (one UAC prompt per connect). We talk to the broker via
// files in the run dir — no second prompt for stop / retry. All three carry the
// session id in their names, so a file of an earlier session can never be taken
// for an answer of this one:
//   stop-<session>.signal     we write it → broker kills sing-box and exits
//   restart-<session>.signal  we write it → broker kills sing-box (if alive) and
//                             starts a fresh one (no second UAC prompt)
//   core-<session>.exit       broker writes {code,uptimeMs,stderr} when sing-box
//                             dies on its own (its FATAL goes to stderr only: a
//                             start-time failure never reaches log.output)
// The broker also exits (killing sing-box) if the app process disappears, so a
// crashed app never leaves an orphaned TUN that eats the internet.
// Pure — unit tested in broker.test.ts.
// ---------------------------------------------------------------------------

export interface BrokerParams {
  exe: string
  config: string
  workDir: string
  stopFile: string
  restartFile: string
  exitFile: string
  /** pid of the Electron main process */
  parentPid: number
  /** tests: the adapter this broker may wait for / remove */
  tunName?: string
}

/** What a broker reports about a core that exited by itself. */
export interface CoreExit {
  code: number | null
  uptimeMs: number | null
  /** last lines of the core's stderr / stdout */
  stderr: string
  /** the broker's own reason, when it stopped the core or could not start it */
  note?: string
}

/** PowerShell single-quoted literal: no `$` / backtick interpolation. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * PowerShell: runs a core with both pipes drained into Tasks (no deadlock on a
 * full pipe, no PowerShell callback on a foreign thread) and reads what it left.
 * `.ReadToEndAsync()` holds the text in memory: sing-box writes its log to
 * log.output, the pipes only ever get a FATAL / panic.
 * Expects $CoreExe, $CoreArgs, $CoreDir and Now-Ms; sets $script:CoreStarted.
 */
export const CORE_PROCESS_PS = `
function Start-CoreProcess {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $CoreExe
  $psi.Arguments = $CoreArgs
  $psi.WorkingDirectory = $CoreDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardOutput = $true
  $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $c = [Diagnostics.Process]::Start($psi)
  $script:ErrTask = $c.StandardError.ReadToEndAsync()
  $script:OutTask = $c.StandardOutput.ReadToEndAsync()
  $script:CoreStarted = Now-Ms
  return $c
}
function Core-Output {
  $t = ''
  try { if ($script:ErrTask.Wait(1500)) { $t += $script:ErrTask.Result } } catch {}
  try { if ($script:OutTask.Wait(300)) { $t += $script:OutTask.Result } } catch {}
  $t = [regex]::Replace($t, '\\x1b\\[[0-9;]*m', '')
  $lines = @($t -split '\\r?\\n' | Where-Object { $_ -ne '' })
  if ($lines.Count -gt 12) { $lines = $lines[($lines.Count - 12)..($lines.Count - 1)] }
  $t = $lines -join [string][char]10
  if ($t.Length -gt 3000) { $t = $t.Substring($t.Length - 3000) }
  return $t
}
`.trim()

/**
 * PowerShell: the wintun adapter of the previous run must be gone before a new
 * one is created. It normally disappears within seconds of the core's exit; one
 * that stays is removed (the elevated broker may do that). Only our adapter name.
 * Expects $TunName and a Note function.
 */
export const STALE_ADAPTER_PS = `
function Tun-Present {
  try {
    foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($n.Name -eq $TunName) { return $true }
    }
  } catch {}
  return $false
}
function Clear-StaleAdapter {
  if (-not (Tun-Present)) { return }
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Tun-Present)) { return }
  }
  Note 'адаптер прошлого запуска не исчез за 5 с, удаляем его'
  try {
    $id = (Get-NetAdapter -Name $TunName -ErrorAction Stop).PnPDeviceID
    if ($id) { $null = & (Join-Path ([Environment]::GetFolderPath('System')) 'pnputil.exe') '/remove-device' $id }
  } catch { Note ('не удалось удалить адаптер: ' + [string]$_.Exception.Message) }
  for ($i = 0; $i -lt 12; $i++) {
    if (-not (Tun-Present)) { return }
    Start-Sleep -Milliseconds 250
  }
  Note 'адаптер прошлого запуска остался'
}
`.trim()

export function brokerScript(p: BrokerParams): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$CoreExe = ${psQuote(p.exe)}
$cfg = ${psQuote(p.config)}
$CoreArgs = 'run -c "' + $cfg + '"'
$CoreDir = ${psQuote(p.workDir)}
$stop = ${psQuote(p.stopFile)}
$restart = ${psQuote(p.restartFile)}
$exitf = ${psQuote(p.exitFile)}
$parent = ${Math.trunc(p.parentPid)}
$TunName = ${psQuote(p.tunName ?? TUN_INTERFACE)}
function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Note([string]$m) {}
${CORE_PROCESS_PS}
${STALE_ADAPTER_PS}
function Write-Exit($c) {
  $o = @{ code = $c.ExitCode; uptimeMs = ((Now-Ms) - $script:CoreStarted); stderr = (Core-Output) } | ConvertTo-Json -Compress
  $tmp = $exitf + '.tmp'
  [IO.File]::WriteAllText($tmp, $o, (New-Object System.Text.UTF8Encoding($false)))
  [IO.File]::Move($tmp, $exitf)
}
Clear-StaleAdapter
$p = Start-CoreProcess
$idle = 0
$tick = 0
while (-not (Test-Path $stop)) {
  if (Test-Path $restart) {
    if ($p -and -not $p.HasExited) {
      Stop-Process -Id $p.Id -Force
      $null = $p.WaitForExit(5000)
    }
    Remove-Item $exitf
    Clear-StaleAdapter
    $p = Start-CoreProcess
    $idle = 0
    Remove-Item $restart
  } elseif ($p.HasExited) {
    if (-not (Test-Path $exitf)) { Write-Exit $p }
    $idle++
    if ($idle -gt 150) { break }
  }
  $tick++
  if (($tick % 5) -eq 0 -and -not (Get-Process -Id $parent)) { break }
  Start-Sleep -Milliseconds 400
}
if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force }
Remove-Item $restart
Remove-Item $stop
`.trim()
}

/** A report file of the broker → CoreExit; a half-written or foreign file gives nulls. */
export function parseCoreExit(text: string): CoreExit {
  try {
    const o = JSON.parse(text.replace(/^\ufeff/, '')) as {
      code?: unknown
      uptimeMs?: unknown
      stderr?: unknown
    }
    return {
      code: typeof o.code === 'number' ? o.code : null,
      uptimeMs: typeof o.uptimeMs === 'number' ? o.uptimeMs : null,
      stderr: typeof o.stderr === 'string' ? o.stderr : ''
    }
  } catch {
    return { code: null, uptimeMs: null, stderr: '' }
  }
}

/** true once our wintun adapter is up with its address (os.networkInterfaces()). */
export function hasTunAdapter(
  ifaces: Record<string, { address: string }[] | undefined>,
  address: string
): boolean {
  return Object.values(ifaces).some((list) => list?.some((a) => a.address === address))
}
