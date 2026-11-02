import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { release } from 'node:os'

// ---------------------------------------------------------------------------
// Device identity for Remnawave "HWID Device Limit".
//
// Remnawave (docs.rw → Features → HWID Device Limit) reads these request
// headers when a client fetches the subscription (the Happ convention):
//   x-hwid          — required; must match /^[a-zA-Z0-9=-]{10,64}$/ (v3.0.0+)
//   x-device-os     — optional
//   x-ver-os        — optional
//   x-device-model  — optional
//   user-agent
//
// x-hwid is a salted SHA-256 of the Windows MachineGuid, truncated to 32 hex
// chars — stable per Windows install, and the raw MachineGuid never leaves
// the machine. The model header carries only manufacturer + model from WMI
// (no host name / user name).
// ---------------------------------------------------------------------------

/** App-wide constant salt. Changing it re-registers every device — don't. */
export const HWID_SALT = 'cipherway-desktop:hwid:v1'

export interface DeviceInfo {
  hwid: string
  osVersion: string
  model: string
}

export function hashHwid(machineId: string, salt: string = HWID_SALT): string {
  return createHash('sha256')
    .update(`${salt}:${machineId.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32)
}

/** Keep header values printable ASCII (fetch rejects non-Latin1), single-spaced, capped. */
export function sanitizeHeaderValue(v: string, max = 64): string {
  return v
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
}

// OEM placeholder strings commonly left in SMBIOS on self-built PCs
const JUNK_MODEL =
  /^(to be filled.*|system (product name|manufacturer)|default string|not applicable|o\.?e\.?m\.?|none|unknown|n\/a|x|\.)$/i

/** "ASUSTeK COMPUTER INC." + "ROG Strix G15" -> header-safe model, or "PC". */
export function normalizeModel(manufacturer: string, model: string): string {
  const parts = [manufacturer, model]
    .map((p) => sanitizeHeaderValue(p))
    .filter((p) => p && !JUNK_MODEL.test(p))
  // avoid "Lenovo Lenovo ThinkPad" style duplicates
  if (parts.length === 2 && parts[1].toLowerCase().startsWith(parts[0].toLowerCase())) parts.shift()
  return sanitizeHeaderValue(parts.join(' ')) || 'PC'
}

/** Request headers for a subscription fetch (UA must NOT start with "clash"). */
export function buildSubscriptionHeaders(
  device: DeviceInfo,
  appVersion: string
): Record<string, string> {
  return {
    'User-Agent': `CipherWay/${sanitizeHeaderValue(appVersion, 32)} (Windows)`,
    Accept: '*/*',
    'x-hwid': device.hwid,
    'x-device-os': 'Windows',
    'x-ver-os': sanitizeHeaderValue(device.osVersion, 32) || 'unknown',
    'x-device-model': sanitizeHeaderValue(device.model) || 'PC'
  }
}

function run(file: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) =>
      resolve(err ? '' : String(stdout))
    )
  })
}

/** Extracts MachineGuid from `reg query` output. */
export function parseMachineGuid(regOutput: string): string | null {
  const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{16,})/.exec(regOutput)
  return m ? m[1] : null
}

export async function readMachineGuid(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const out = await run('reg', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    '/v',
    'MachineGuid',
    '/reg:64'
  ])
  return parseMachineGuid(out)
}

export async function readDeviceModel(): Promise<string> {
  if (process.platform !== 'win32') return 'PC'
  const out = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$c = Get-CimInstance Win32_ComputerSystem; "$($c.Manufacturer)|$($c.Model)"'
    ],
    8000
  )
  const [manufacturer = '', model = ''] = out.trim().split('|')
  return normalizeModel(manufacturer, model)
}

let cached: Promise<DeviceInfo> | null = null

/**
 * Device identity, computed once per app run (concurrent callers share it).
 * @param fallbackId persistent random id used only if MachineGuid can't be read
 */
export function getDeviceInfo(fallbackId: () => string): Promise<DeviceInfo> {
  cached ??= Promise.all([readMachineGuid(), readDeviceModel()]).then(([guid, model]) => ({
    hwid: hashHwid(guid ?? fallbackId()),
    osVersion: release(),
    model
  }))
  return cached
}
