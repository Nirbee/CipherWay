# CipherWay VPN

Windows desktop VPN client (Electron + React + TypeScript) for Remnawave-based
infrastructure. Supports VLESS + REALITY (via Xray-core) and Hysteria2, with per-process
and per-domain routing rules in the style of Clash / Koala Clash.

## Stack

- **Electron** + **electron-vite** — app shell, system tray, custom titlebar
- **React 18** + **TypeScript** (strict) — UI
- **Zustand** — state
- **Tailwind CSS** — styling (design tokens in `tailwind.config.ts`)
- **electron-builder** + **electron-updater** — packaging & auto-update
- Cores (since 0.3.0 — two processes):
  - `xray.exe` (XTLS/Xray-core, pinned to **26.7.28** — the same series as the
    nodes) carries the **VLESS + REALITY / TLS** connections to the servers;
  - `sing-box.exe` (SagerNet/sing-box 1.13.x) does **TUN / system proxy,
    per-process & per-domain rules, DNS and Hysteria2**;
  - `wintun.dll` for the TUN inbound

## Project layout

```
src/
  main/        Electron main process
    core/      sidecar orchestration (xray + sing-box), config generators
    remnawave/ subscription client, link parsers, HWID headers, stub detection
    rules/     routing rules -> core config compiler
    ipc/       IPC handlers (zod-validated)
    updater/   electron-updater logic
  preload/     contextBridge bridge (window.api)
  renderer/    React app (pages, components, store, styles)
  shared/      types + IPC contract shared by main and renderer
resources/
  bin/         sing-box.exe / xray.exe / wintun.dll — downloaded, NOT committed
  tray/        tray icons (connected / disconnected)
build/
  installer.nsh       NSIS hook: registers the cipherway:// URL scheme
scripts/
  download-cores.ts   fetches+verifies sing-box + xray + wintun
  make-tray-icons.cjs regenerates resources/tray/*.ico
```

## Develop

```bash
npm install
npm run download:cores   # fetch sing-box.exe, xray.exe, wintun.dll into resources/bin
npm run download:cores -- xray   # only one core (names: singbox, xray, wintun)
npm run dev              # launch the app in dev mode
```

## Build

```bash
npm run build            # typecheck + bundle
npm run pack:win         # build NSIS installer (.exe) for Windows x64
```

### NSIS installer requirement (symlink privilege)

`electron-builder` downloads its `winCodeSign` package, which contains macOS
symlinks. Extracting it on Windows needs the *Create symbolic links* privilege.
If `pack:win` fails with `Cannot create symbolic link … winCodeSign … .dylib`,
either:

- enable **Windows Developer Mode** (Settings → Privacy & security → For
  developers → Developer Mode = On), or
- run the build from an **elevated** (Administrator) terminal.

Without that, `electron-builder` still produces a fully working unpacked app at
`dist/win-unpacked/CipherWay VPN.exe` (used during development); only the final
`.exe` installer wrapping needs the privilege above.

## Notes

- Context isolation on, `nodeIntegration` off — renderer talks to main only
  through the typed `window.api` bridge.
- Subscription URL / tokens are encrypted on disk via Electron `safeStorage`.
- Code signing is not yet configured; see the TODO in `electron-builder.yml`.

## Implementation progress

- [x] **Step 1** — Electron + Vite + React + TS scaffold, custom titlebar, navigation
- [x] **Step 2** — Design system + UI kit (Card, Pill, Button, Input, Toggle, Modal)
- [x] **Step 3** — Rules screen (local CRUD, drag-and-drop, import/export)
- [x] **Step 4** — RemnawaveClient (fetch + parse VLESS/Hysteria2)
- [x] **Step 5** — Core engine: sing-box orchestration, config gen, rule compiler,
      System Proxy + TUN (elevated broker), traffic stats, hot-reload
- [x] **Step 6** — Home / Servers / Logs / Subscription / Settings screens
- [x] **Step 7** — Auto-update (electron-updater): silent check, banner, progress, install
- [x] **Step 8** — Packaging (electron-builder): app assembled (`dist/win-unpacked`), config
      validated against the real sing-box binary

## Core engine notes

The config generated for sing-box targets the **1.12+ schema** (typed DNS servers,
`route.default_domain_resolver`, action-based route rules, remote rule-sets for
geosite/geoip) and is validated against **sing-box 1.13.x** with
`sing-box check -c config.json`. `download-cores.ts` pins to the 1.13 series.

Per-process routing (`ProcessName` / `ProcessPath`) only takes effect in **TUN
mode** — sing-box identifies the owning process of each connection via the OS.
In **System Proxy** mode those rules are inert (apps just see a SOCKS/HTTP proxy).
TUN requires admin: connecting in TUN mode launches the core through an elevated
broker (one UAC prompt); disconnecting signals the broker via a stop-file (no
second prompt).
```

## Connection chain (0.3.0+)

```
apps -> sing-box (TUN "CipherWay" or mixed 127.0.0.1) -- rules / DNS --
     -> VLESS node:     socks 127.0.0.1:<random port> -> xray (one SOCKS inbound
                        per node, loopback only, UDP on) -> VLESS+REALITY -> node
     -> Hysteria2 node: native sing-box outbound
     -> direct / reject
```

- xray starts **before** sing-box and stops **after** it; if xray dies the whole
  connection is stopped with an error (no silent fallback to direct). xray output
  goes to the «Журнал» screen with source `XRAY`.
- TUN loop guard: `process_name: xray.exe -> direct` is the first route rule, node
  host names are resolved by the direct DNS server, `auto_detect_interface` binds
  `direct` to the physical NIC.
- Configs are validated in tests against the real binaries (`sing-box check`,
  `xray run -test -c`) when `resources/bin` is populated.

## Subscription fetch / HWID

The client sends the Remnawave HWID headers (docs.rw → HWID Device Limit):
`x-hwid` (salted SHA-256 of the Windows MachineGuid, 32 hex — the GUID itself is
never sent), `x-device-os: Windows`, `x-ver-os` (Windows build), `x-device-model`
(WMI manufacturer + model or `PC`), `User-Agent: CipherWay/<version> (Windows)`.
That UA does not match the panel's clash/mihomo rules, so the panel returns the
plain link list (XRAY_BASE64). Response headers `x-hwid-max-devices-reached` /
`x-hwid-limit` / `x-hwid-not-supported` and placeholder servers (`0.0.0.0:1`,
«App not supported», «лимит устройств») are turned into a readable Russian error.

## cipherway:// links

```
cipherway://import?url=<urlencoded https subscription URL>
cipherway://install-config?url=<...>      (Clash / Koala Clash style alias)
```

Only `https` subscriptions are accepted. The app asks «Добавить подписку с
<домен>?» and never connects by itself. The scheme is registered by the NSIS
installer (`build/installer.nsh`) and again at runtime
(`app.setAsDefaultProtocolClient`; in dev only with `CIPHERWAY_DEV_PROTOCOL=1`).
A second launch (including via a link) hands its arguments to the running copy
(single-instance lock) and exits.

## Tray

Closing the window hides it to the tray — the VPN keeps running (a one-time
notification says so). Tray menu: «Открыть», «Подключить/Отключить», «Выход»
(stops the cores and reverts the system proxy). Double click opens the window;
the icon differs for connected / disconnected.
