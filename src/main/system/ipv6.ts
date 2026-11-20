import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'

// ---------------------------------------------------------------------------
// Is IPv6 usable on this Windows? (0.4.6)
//
// The TUN inbound gets an IPv6 address next to the IPv4 one. On a system with
// IPv6 switched off sing-box then dies at the start:
//   start inbound/tun[tun-in]: configure tun interface: set ipv6 address: Element not found.
// Two cheap checks, no admin rights:
//  * HKLM\…\Tcpip6\Parameters\DisabledComponents with bit 0x10 («IPv6 off on
//    all non-tunnel interfaces»; 0xFF includes it). A wintun adapter is a
//    non-tunnel interface for Windows. Bit 0x01 alone switches off only
//    Teredo / 6to4 / ISATAP and does not hit wintun, 0x20 is just «prefer IPv4».
//  * os.networkInterfaces(): no IPv6 address (not even fe80::) on any
//    interface except loopback — the IPv6 binding is removed from the adapters
//    or the stack is off. This is the live state (the registry value only
//    takes effect after a reboot).
// With IPv6 off there is no IPv6 path that could bypass the tunnel, so an
// IPv4-only TUN leaks nothing. What both checks miss is caught when the core
// fails anyway (isIpv6TunError → one restart with an IPv4-only config).
// ---------------------------------------------------------------------------

const TCPIP6_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters'
/** DisabledComponents bit: IPv6 off on all non-tunnel interfaces (LAN, Wi-Fi, wintun) */
export const IPV6_OFF_NONTUNNEL = 0x10

export interface Ipv6Status {
  available: boolean
  /** why it is not (for the log), e.g. «DisabledComponents=0xFF» */
  reason?: string
}

type Ifaces = Record<string, { family: string | number; internal: boolean }[] | undefined>

/** `reg query … /v DisabledComponents` output → the value (null = not set / unreadable). */
export function parseDisabledComponents(out: string): number | null {
  const m = /DisabledComponents\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out)
  return m ? parseInt(m[1], 16) : null
}

/** true when some non-loopback interface has an IPv6 address (link-local counts). */
export function hasInterfaceIpv6(ifaces: Ifaces): boolean {
  return Object.values(ifaces).some((list) =>
    // Node 18.0–18.3 reported family as a number
    list?.some((a) => !a.internal && (a.family === 'IPv6' || a.family === 6))
  )
}

/** The decision itself (pure, see the header). */
export function ipv6Status(disabledComponents: number | null, ifaces: Ifaces): Ipv6Status {
  if (disabledComponents !== null && (disabledComponents & IPV6_OFF_NONTUNNEL) !== 0) {
    return {
      available: false,
      reason: `DisabledComponents=0x${disabledComponents.toString(16).toUpperCase()}`
    }
  }
  // no network at all (every adapter down) says nothing about IPv6
  const online = Object.values(ifaces).some((list) => list?.some((a) => !a.internal))
  if (online && !hasInterfaceIpv6(ifaces)) {
    return { available: false, reason: 'ни у одного адаптера нет IPv6' }
  }
  return { available: true }
}

function readDisabledComponents(timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', TCPIP6_KEY, '/v', 'DisabledComponents'],
      { windowsHide: true, timeout: timeoutMs },
      // a missing value is exit code 1 — the normal case
      (_err, stdout) => resolve(parseDisabledComponents(String(stdout ?? '')))
    )
  })
}

/** Registry + interfaces; never throws (a failed read counts as «IPv6 on»). */
export async function detectIpv6(timeoutMs = 3000): Promise<Ipv6Status> {
  const dc = process.platform === 'win32' ? await readDisabledComponents(timeoutMs) : null
  return ipv6Status(dc, networkInterfaces())
}

/**
 * A core line / stderr saying the TUN could not get its IPv6 part, e.g.
 * `start inbound/tun[tun-in]: configure tun interface: set ipv6 address: Element not found.`
 * (sing-tun on Windows: set ipv6 address / options / dns).
 */
export function isIpv6TunError(text: string): boolean {
  return (
    /\btun\b/i.test(text) &&
    /\b(set|block|protect) ipv6\b|\bipv6 (address|options|dns|route)\b/i.test(text)
  )
}

/**
 * What the core printed before it died → restart it once with an IPv4-only
 * TUN? Only for a TUN start that still had IPv6.
 */
export function shouldRetryIpv4Only(
  coreOutput: string[],
  state: { tun: boolean; ipv4Only: boolean }
): boolean {
  return state.tun && !state.ipv4Only && coreOutput.some(isIpv6TunError)
}
