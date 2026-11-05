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
