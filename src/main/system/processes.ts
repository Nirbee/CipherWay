import { execFile } from 'node:child_process'
import { basename } from 'node:path'

export interface ProcessInfo {
  name: string
  path: string
  pid: number
}

/**
 * Lists running processes on Windows with their executable paths via a single
 * PowerShell / CIM query. Falls back to an empty list on non-Windows.
 */
export function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform !== 'win32') return Promise.resolve([])

  const script =
    'Get-CimInstance Win32_Process | ' +
    'Select-Object Name,ProcessId,ExecutablePath | ' +
    'ConvertTo-Json -Compress'

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve([])
        try {
          const raw = JSON.parse(stdout) as
            | { Name: string; ProcessId: number; ExecutablePath: string | null }
            | { Name: string; ProcessId: number; ExecutablePath: string | null }[]
          const arr = Array.isArray(raw) ? raw : [raw]
          const seen = new Set<string>()
          const result: ProcessInfo[] = []
          for (const p of arr) {
            if (!p?.Name || !/\.exe$/i.test(p.Name)) continue
            const path = p.ExecutablePath ?? ''
            // de-dupe by name so the UI list stays clean
            const key = p.Name.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            result.push({ name: p.Name, path, pid: p.ProcessId })
          }
          result.sort((a, b) => a.name.localeCompare(b.name))
          resolve(result)
        } catch {
          resolve([])
        }
      }
    )
  })
}

/** Other VPN clients: their TUN and ours fight over the routes. */
const OTHER_VPN_CLIENTS: { re: RegExp; label: string }[] = [
  { re: /^happ\.exe$/i, label: 'Happ' },
  { re: /^(koala-clash|koala clash)\.exe$/i, label: 'Koala Clash' },
  { re: /^flclash.*\.exe$/i, label: 'FlClash' },
  { re: /^v2rayn\.exe$/i, label: 'v2rayN' }
]

/** Exe names → the VPN clients among them, each once. Pure. */
export function findOtherVpnClients(names: string[]): string[] {
  const found = new Set<string>()
  for (const name of names) {
    const hit = OTHER_VPN_CLIENTS.find((c) => c.re.test(name.trim()))
    if (hit) found.add(hit.label)
  }
  return [...found]
}

/** `"Happ.exe","25496","Console","1","195 320 КБ"` → the first column. */
export function parseTasklist(csv: string): string[] {
  const names: string[] = []
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim())
    if (m) names.push(m[1])
  }
  return names
}

/** Names of running processes; quick (tasklist), [] if that fails. */
export function runningProcessNames(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/fo', 'csv', '/nh'],
      { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parseTasklist(String(stdout)))
    )
  })
}

export function exeName(fullPath: string): string {
  return basename(fullPath)
}

/**
 * Waits until none of `names` runs any more (case-insensitive), at most
 * `timeoutMs`. true — gone. Before an update: the installer can't replace an
 * exe that is still running.
 */
export async function waitProcessesGone(
  names: readonly string[],
  timeoutMs: number,
  list: () => Promise<string[]> = runningProcessNames
): Promise<boolean> {
  const want = new Set(names.map((n) => n.toLowerCase()))
  const end = Date.now() + timeoutMs
  for (;;) {
    const running = await list()
    if (!running.some((n) => want.has(n.toLowerCase()))) return true
    if (Date.now() >= end) return false
    await new Promise((r) => setTimeout(r, 300))
  }
}
