import { networkInterfaces, release } from 'node:os'
import { parseTasklist } from '../system/processes'
import { detectIpv6 } from '../system/ipv6'
import { execLow } from './probes'

// ---------------------------------------------------------------------------
// DevVersion «system» section: Windows build / edition, IPv6, Teredo, other
// VPN / proxy / DPI-bypass programs running, versions of our cores. Child
// processes run with BELOW_NORMAL priority; the process list is read at most
// once per 10 min (the caller decides), the rest once per enable.
// ---------------------------------------------------------------------------

/** exe (lower case) → what it is */
export const OTHER_NET_TOOLS: Record<string, string> = {
  'happ.exe': 'Happ',
  'koala-clash.exe': 'Koala Clash',
  'koala clash.exe': 'Koala Clash',
  'flclash.exe': 'FlClash',
  'flclashcore.exe': 'FlClash',
  'v2rayn.exe': 'v2rayN',
  'v2ray.exe': 'v2ray',
  'xray.exe': 'Xray',
  'sing-box.exe': 'sing-box',
  'mihomo.exe': 'mihomo',
  'clash-verge.exe': 'Clash Verge',
  'clash for windows.exe': 'Clash for Windows',
  'nekoray.exe': 'NekoRay',
  'nekobox.exe': 'NekoBox',
  'hiddify.exe': 'Hiddify',
  'openvpn.exe': 'OpenVPN',
  'openvpn-gui.exe': 'OpenVPN',
  'wireguard.exe': 'WireGuard',
  'amneziavpn.exe': 'AmneziaVPN',
  'amneziawg.exe': 'AmneziaWG',
  'outline.exe': 'Outline',
  'protonvpn.exe': 'Proton VPN',
  'nordvpn.exe': 'NordVPN',
  'expressvpn.exe': 'ExpressVPN',
  'windscribe.exe': 'Windscribe',
  'psiphon3.exe': 'Psiphon',
  'warp-svc.exe': 'Cloudflare WARP',
  'winws.exe': 'zapret',
  'goodbyedpi.exe': 'GoodbyeDPI',
  'ciadpi.exe': 'ByeDPI',
  'tor.exe': 'Tor',
  'lantern.exe': 'Lantern',
  'rvrvpngui.exe': 'Radmin VPN',
  'hamachi-2.exe': 'Hamachi',
  'zerotier-one_x64.exe': 'ZeroTier',
  'tailscale-ipn.exe': 'Tailscale',
  'tailscaled.exe': 'Tailscale'
}

export function findNetTools(names: string[]): string[] {
  const found = new Set<string>()
  for (const n of names) {
    const hit = OTHER_NET_TOOLS[n.trim().toLowerCase()]
    if (hit) found.add(hit)
  }
  return [...found].sort()
}

/** `reg query …\CurrentVersion` → EditionID / DisplayVersion / CurrentBuild / UBR. */
export function parseWinVersion(out: string): { edition: string; display: string; build: string } {
  const val = (name: string): string =>
    new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'mi').exec(out)?.[1] ?? ''
  const ubrRaw = val('UBR')
  const ubr = /^0x[0-9a-f]+$/i.test(ubrRaw) ? String(parseInt(ubrRaw, 16)) : ubrRaw
  const build = val('CurrentBuild')
  return {
    edition: val('EditionID'),
    display: val('DisplayVersion'),
    build: build ? (ubr ? `${build}.${ubr}` : build) : ''
  }
}

/** Teredo: an adapter with a 2001:0::/32 address = qualified, a Teredo adapter = present. */
export function teredoState(
  ifaces: Record<string, { address: string; family: string | number }[] | undefined>
): 'active' | 'present' | 'none' {
  let present = false
  for (const [name, list] of Object.entries(ifaces)) {
    if (/teredo/i.test(name)) present = true
    if (
      list?.some((a) => (a.family === 'IPv6' || a.family === 6) && /^2001:0?:/i.test(a.address))
    ) {
      return 'active'
    }
  }
  return present ? 'present' : 'none'
}

export interface StaticSystem {
  os: { build: string; edition: string }
  windows_display: string
  core_version: string
  xray_version: string
}

export async function staticSystem(coreExe: string, xrayExe: string): Promise<StaticSystem> {
  const win = process.platform === 'win32'
  const reg = win
    ? parseWinVersion(
        await execLow('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'])
      )
    : { edition: '', display: '', build: '' }
  const first = (s: string): string => s.split(/\r?\n/)[0]?.trim().slice(0, 120) ?? ''
  return {
    os: { build: reg.build || release(), edition: reg.edition || process.platform },
    windows_display: reg.display,
    core_version: first(await execLow(coreExe, ['version'], 5000)),
    xray_version: first(await execLow(xrayExe, ['version'], 5000))
  }
}

export async function runningNames(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  return parseTasklist(await execLow('tasklist', ['/fo', 'csv', '/nh'], 15_000))
}

export async function liveSystem(): Promise<{
  ipv6: boolean
  ipv6_reason?: string
  teredo: string
}> {
  const v6 = await detectIpv6().catch(
    () => ({ available: true }) as { available: boolean; reason?: string }
  )
  return {
    ipv6: v6.available,
    ...(v6.reason ? { ipv6_reason: v6.reason } : {}),
    teredo: teredoState(networkInterfaces())
  }
}
