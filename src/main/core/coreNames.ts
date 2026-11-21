// ---------------------------------------------------------------------------
// File names of our cores. Since 0.4.3 they are not `xray.exe` / `sing-box.exe`:
// other VPN clients stop *their* cores with `taskkill /im xray.exe` and take
// ours down with them (a 7-hour connection ended that way), and the reverse
// must not happen either. Used everywhere a name matters: resources\bin, the
// protected copy in %ProgramData%\CipherWay\bin, the TUN brokers, the hashes in
// the service manifest, the `process_name → direct` rule, «Подключения».
// ---------------------------------------------------------------------------

/** sing-box under its own name */
export const CORE_EXE = 'cipherway-core.exe'
/** xray-core under its own name */
export const XRAY_EXE = 'cipherway-xray.exe'
/** names used up to 0.4.2: removed from %ProgramData%\CipherWay\bin on update */
export const LEGACY_EXES = ['sing-box.exe', 'xray.exe'] as const

/** the wintun adapter (tun.interface_name) */
export const TUN_INTERFACE = 'CipherWay'

// --- LAN (0.5.0): the official Tailscale Windows build under our names -------

/** tailscaled.exe — the LAN daemon (runs as SYSTEM through the service) */
export const LAN_EXE = 'cipherway-lan.exe'
/** tailscale.exe — its CLI (runs as the user, talks to our pipe only) */
export const LANCTL_EXE = 'cipherway-lanctl.exe'
/** wintun adapter of the LAN daemon (`--tun`); the user's Tailscale uses «Tailscale» */
export const LAN_TUN_NAME = 'CipherWay LAN'
/** UDP port of the LAN daemon (`--port`); the user's Tailscale uses 41641 */
export const LAN_UDP_PORT = 41642
/**
 * GUID the official tailscaled requests for its wintun adapter — compiled into
 * the binary (net/tstun/tun_windows.go), the same for every copy. While an
 * adapter with it exists, another Tailscale is running: we don't start then.
 */
export const TAILSCALE_ADAPTER_GUID = '{37217669-42da-4657-a55b-0d995d328250}'
/** addresses of the virtual LAN (Tailscale / Headscale defaults) */
export const LAN_CIDR4 = '100.64.0.0/10'
export const LAN_CIDR6 = 'fd7a:115c:a1e0::/48'
/** Headscale of the bot (the bot sends `login_server`; this is the fallback) */
export const LAN_LOGIN_HOST = 'lan.cipherway.ru'
