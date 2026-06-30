# CipherWay VPN

Windows desktop VPN client (Electron + React + TypeScript) for Remnawave-based
infrastructure. Supports XRAY (VLESS + REALITY) and Hysteria2, with per-process
and per-domain routing rules in the style of Clash / Koala Clash.

## Stack

- **Electron** + **electron-vite** — app shell, system tray, custom titlebar
- **React 18** + **TypeScript** (strict) — UI
- **Zustand** — state
- **Tailwind CSS** — styling (design tokens in `tailwind.config.ts`)
- **electron-builder** + **electron-updater** — packaging & auto-update
- Core: `sing-box.exe` (SagerNet/sing-box) — single engine handling VLESS+REALITY,
  Hysteria2 and per-process routing natively; `wintun.dll` for the TUN inbound

## Project layout

```
src/
  main/        Electron main process
    core/      xray-core / hysteria2 sidecar orchestration
    rules/     routing rules -> core config compiler
    ipc/       IPC handlers (zod-validated)
    updater/   electron-updater logic
  preload/     contextBridge bridge (window.api)
  renderer/    React app (pages, components, store, styles)
  shared/      types + IPC contract shared by main and renderer
resources/
  bin/         sing-box.exe / wintun.dll — downloaded, NOT committed
scripts/
  download-cores.ts   fetches+verifies sing-box + wintun
```

## Develop

```bash
npm install
npm run download:cores   # fetch xray.exe / hysteria.exe into resources/bin
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
