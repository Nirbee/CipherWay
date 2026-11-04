// ---------------------------------------------------------------------------
// TUN mode: sing-box needs admin rights, so it runs under an elevated
// PowerShell "broker" (one UAC prompt per connect). We talk to the broker via
// files in the run dir — no second prompt for stop / retry:
//   stop.signal     we write it → broker kills sing-box and exits
//   restart.signal  we write it → broker kills sing-box (if alive) and starts a
//                   fresh one (the one retry after a slow / failed wintun start)
//   core.exit       broker writes sing-box's exit code when it dies on its own
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
}

/** PowerShell single-quoted literal: no `$` / backtick interpolation. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

export function brokerScript(p: BrokerParams): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$exe = ${psQuote(p.exe)}
$cfg = ${psQuote(p.config)}
$wd = ${psQuote(p.workDir)}
$stop = ${psQuote(p.stopFile)}
$restart = ${psQuote(p.restartFile)}
$exitf = ${psQuote(p.exitFile)}
$parent = ${Math.trunc(p.parentPid)}
function Start-Core {
  $c = Start-Process -FilePath $exe -ArgumentList @('run','-c',$cfg) -WorkingDirectory $wd -WindowStyle Hidden -PassThru
  $null = $c.Handle
  return $c
}
$p = Start-Core
$idle = 0
$tick = 0
while (-not (Test-Path $stop)) {
  if (Test-Path $restart) {
    if ($p -and -not $p.HasExited) {
      Stop-Process -Id $p.Id -Force
      $null = $p.WaitForExit(5000)
    }
    Remove-Item $exitf
    $p = Start-Core
    $idle = 0
    Remove-Item $restart
  } elseif ($p.HasExited) {
    if (-not (Test-Path $exitf)) { Set-Content -Path $exitf -Value $p.ExitCode -Encoding ascii }
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

/** true once our wintun adapter is up with its address (os.networkInterfaces()). */
export function hasTunAdapter(
  ifaces: Record<string, { address: string }[] | undefined>,
  address: string
): boolean {
  return Object.values(ifaces).some((list) => list?.some((a) => a.address === address))
}
