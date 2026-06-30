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

export function exeName(fullPath: string): string {
  return basename(fullPath)
}
