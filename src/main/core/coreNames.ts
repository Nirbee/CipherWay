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

// --- «Ускорение без VPN (zapret)» (0.7.0): the official zapret Windows build ---

/**
 * winws.exe of zapret (bol-van/zapret v72.13, unmodified) — runs as SYSTEM
 * through the service (src/main/zapret/dpiBroker.ts). Our own name: tools and
 * guides stop *their* zapret with `taskkill /im winws.exe`, that must not hit
 * ours (and our checks must not take theirs for ours).
 */
export const DPI_EXE = 'cipherway-dpi.exe'
/** the files cipherway-dpi.exe loads / reads from its own folder (with DPI_EXE: DPI_ALL) */
export const DPI_FILES = [
  'WinDivert.dll',
  'WinDivert64.sys',
  'cygwin1.dll',
  'tls_clienthello_www_google_com.bin',
  'quic_initial_www_google_com.bin'
] as const
export const DPI_FAKE_TLS = 'tls_clienthello_www_google_com.bin'
export const DPI_FAKE_QUIC = 'quic_initial_www_google_com.bin'
/** every DPI file the installer copies into the protected bin folder */
export const DPI_ALL = [DPI_EXE, ...DPI_FILES] as const
/** other DPI-bypass programs: while one runs, ours does not start (process names) */
export const FOREIGN_DPI_PROCESSES = ['winws', 'goodbyedpi', 'zapret'] as const
/** … and Windows services of the usual zapret / GoodbyeDPI installs */
export const FOREIGN_DPI_SERVICES = ['zapret', 'GoodbyeDPI', 'winws1', 'winws2'] as const
/**
 * zapret release whose files we ship and their SHA-256 — the ONE source:
 * scripts/download-cores.ts downloads against them, TunService refuses to set
 * up the service with any other files (src/main/core/tunService.ts).
 */
export const ZAPRET_TAG = 'v72.13'
export const DPI_HASHES: Record<(typeof DPI_ALL)[number], string> = {
  [DPI_EXE]: 'a14bff1df6234ea555d2e0c61b589f0707c0b12d6c9b7eeccda76012154996e8',
  'WinDivert.dll': 'c1e060ee19444a259b2162f8af0f3fe8c4428a1c6f694dce20de194ac8d7d9a2',
  'WinDivert64.sys': '8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2',
  'cygwin1.dll': '103104a52e5293ce418944725df19e2bf81ad9269b9a120d71d39028e821499b',
  [DPI_FAKE_TLS]: '936c2bee4cfb80aa3c426b2dcbcc834b3fbcd1adb17172959dc569c73a14275c',
  [DPI_FAKE_QUIC]: 'f4589c57749f956bb30538197a521d7005f8b0a8723b4707e72405e51ddac50a'
}
