# CipherWay VPN

Windows desktop VPN client (Electron + React + TypeScript) for Remnawave-based
infrastructure. Supports VLESS + REALITY (via Xray-core) and Hysteria2, with per-process
and per-domain routing rules in the style of Clash / Koala Clash, one-click routing modes,
an automatic best-server group, real (through-the-node) latency and a live connections view.

## Stack

- **Electron** + **electron-vite** — app shell, system tray, custom titlebar
- **React 18** + **TypeScript** (strict) — UI
- **Zustand** — state
- **Tailwind CSS** — styling (design tokens in `tailwind.config.ts`)
- **electron-builder** + **electron-updater** — packaging & auto-update
- Cores (since 0.3.0 — two processes):
  - `cipherway-xray.exe` (XTLS/Xray-core, pinned to **26.7.28** — the same series
    as the nodes) carries the **VLESS + REALITY / TLS** connections to the servers;
  - `cipherway-core.exe` (SagerNet/sing-box 1.13.x) does **TUN / system proxy,
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
  bin/         cipherway-core.exe / cipherway-xray.exe / wintun.dll — downloaded, NOT committed
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
npm run download:cores   # fetch both cores (under our names) + wintun.dll into resources/bin
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
- [x] **Step 7** — Auto-update (electron-updater): background checks, one sidebar button, install (see 0.4.4)
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

- xray starts **before** sing-box and stops **after** it; if xray dies it is
  restarted alone, on the same ports (see 0.4.3). xray output goes to the
  «Журнал» screen with source `XRAY`.
- TUN loop guard: `process_name: cipherway-xray.exe -> direct` is the first route rule, node
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
notification says so). Tray menu: «Открыть», «Подключить/Отключить», «Режим
трафика» (По правилам / Весь трафик через VPN / Всё напрямую), «Выход» (stops
the cores and reverts the system proxy — only if CipherWay set it). Double click
opens the window; the icon differs for connected / disconnected.

## 0.4.0: modes, auto server, real latency, connections

- **Routing mode** (sidebar + tray): `rule` / `global` / `direct`, saved in
  settings. sing-box rules `clash_mode: Direct → direct`, `clash_mode: Global →
  proxy` sit before the user rules (LAN always direct); switching is a Clash
  API `PATCH /configs {mode}` + closing open connections — no core restart, no
  UAC in TUN.
- **Server groups**: `auto` = `urltest` over every node (gstatic generate_204,
  5 min, tolerance 50 ms) and `proxy` = `selector` [auto, …nodes]. PROXY rules
  and `route.final` point at `proxy`; picking a server is `PUT /proxies/proxy`
  (hot). After start the saved mode/server are applied explicitly because
  `cache.db` would restore the previous ones.
- **Latency** = `GET /proxies/<node>/delay` (real HTTPS request through the
  node, 5 s, parallel), not a TCP ping. While disconnected a throw-away xray +
  sing-box pair without inbounds (`generateProbeConfig`) is started for the
  test and removed afterwards. Auto-test on opening Главная/Серверы at most
  once a minute, «Проверить» forces it.
- **Подключения**: `/connections` polled once a second while the screen is
  open, grouped by process (exe icon via `app.getFileIcon`) or by site.
  `route.find_process: true` — on Windows sing-box finds the process in
  system-proxy mode too (checked on 1.13.14). Our own `xray.exe` sockets and
  anything aimed at a node address are dropped; the chain is reduced to the
  server *name*. Rejected connections are not tracked by sing-box at all.
- **No node addresses in the UI**: the renderer receives `SubscriptionView`
  (id, name, protocol — no host/port/keys); log lines and error messages are
  masked in main (`mask.ts`: node hosts/IPs with port, UUIDs, passwords, the
  subscription link and its token → first characters + `***`).
- **Subscription headers**: `subscription-userinfo`, `profile-title`,
  `support-url`, `profile-web-page-url`, `announce` (plain or `base64:`),
  `profile-update-interval`. «Поддержка» falls back to Настройки → Поддержка.
- **Rules text editor** (Правила → Текст): Clash lines, Koala / Clash Verge YAML
  (`prepend` / `append` / `delete`, `rules:`, `payload:`) and our JSON; unknown
  lines are listed with line numbers and reasons. Export as Clash lines. New
  rule types: `DomainRegex` (`domain_regex`), `DstPort` (`port` / `port_range`),
  IPv6 CIDR.

Opt-in end-to-end test with the real cores (local VLESS test server, system
proxy mocked): `CW_E2E=1 npx vitest run src/main/core/sidecar.e2e.test.ts`.

## 0.4.1: TUN fast path, quick first DNS, quiet logs, in-app support

- **xray bypasses the TUN**: before a TUN start the node hosts are resolved
  (system DNS, the TUN is not up yet). Their IPs go into
  `tun.route_exclude_address` (v4 `/32`, v6 `/128`) and into xray `dns.hosts`
  with `sockopt.domainStrategy: UseIP`, so xray dials exactly the excluded IPs
  and its sockets leave through the physical NIC instead of looping through
  sing-box. `process_name: xray.exe → direct` stays as a safety net. (Xray 26.7
  also accepts `sockopt.interface` on Windows, but a bound NIC breaks on a
  Wi-Fi/Ethernet switch — not used.) Resolved IPs are masked in logs.
- **First seconds after connecting**: until a urltest member has a test result,
  sing-box sends everything (DoH included) through the *first* member. The
  members are now ordered by the last measured latency (persisted,
  `latencyCache`): answered → never measured → dead. Right after start the
  group is checked (`GET /group/auto/delay`), «Лучший сервер» shows «проверяем…»,
  then the chosen node with *its* latency, or «ни один сервер не отвечает».
  xray must accept connections on every node port before sing-box starts.
- **Logs**: sing-box `warn` / xray `warning` by default; Настройки →
  «Подробный журнал (для поддержки)» → `info`. Main sends log lines in batches
  (≤ 400 per 300 ms, overflow is counted), the «Логи» screen keeps 1000 lines.
- **TUN start**: «connected» only once the wintun adapter (172.19.0.1) exists,
  up to 45 s («Создаём сетевой адаптер…»); one retry via `restart.signal`
  (no second UAC). The broker writes `core.exit` when sing-box dies on its own
  (the app reports it) and exits when the app process is gone.
- **Поддержка** page: chat with the cabinet API (`apiBase`, default
  `https://cabinet.cipherway.net.ru`): `GET/POST /api/app/v1/support`,
  `POST /api/app/v1/support/photo` (multipart, JPG/PNG/WebP ≤ 10 MB),
  `GET /api/app/v1/me`; auth `X-Subscription-Token` (last path segment of the
  subscription link) + the subscription's device headers. Requests and image
  downloads are made by main (images reach the renderer as `data:` URLs, the
  token never does; redirects only within the same origin). Polling: 10 s on
  the page, 60 s in the background with an open ticket, 10 min without one;
  a new reply → Windows notification + badge. «Написать в Telegram»
  (`support-url`) stays as a fallback.

## 0.4.3: the subscription follows the panel, cores come back by themselves

- **Subscription refresh**: «Обновить» on Главная / Подписка; before every connect
  (5 s, on failure the saved copy); on `profile-update-interval` (else the setting);
  at start. A change while connected restarts the cores through the queue, the
  selected server follows its *name* (ids are derived from it now) or falls back to
  «Лучший сервер». shortId / fingerprint alone don't restart anything (the panel may
  vary them). The request is ordinary app traffic: with the VPN on it goes through
  the tunnel.
- **`REALITY: received real certificate`**: at most once per 10 min the subscription
  is fetched and whatever changed applied; if the same server keeps failing it gets a
  hint in the list. xray always runs at log level `info` (session → node mapping
  through `taking detour [out-<id>]`), info lines are dropped unless «Подробный журнал».
- **«⚡ Автовыбор»** of the panel is hidden from the list and the urltest group: for
  us it is one plain address, we have «Лучший сервер (авто)».
- **Own file names** `cipherway-core.exe` / `cipherway-xray.exe`, so somebody else's
  `taskkill /im xray.exe` doesn't hit us. Updating from 0.4.2: the manifest lists the
  old name → «outdated» → one UAC prompt, the old file leaves `%ProgramData%\CipherWay\bin`.
- **A core that died** while connected: restarted alone, 3 tries after 1/3/5 s, toast
  «Ядро перезапущено». Xray keeps its ports (sing-box and TUN stay up). Only then an
  error, with a reason only if the process itself reported one.
- **First TUN start**: sing-box prints a start-time FATAL to **stderr only**, never to
  `log.output`, and the brokers didn't capture it. They do now: exit code, time and
  the last lines reach the app (`state.json` / `core-<session>.exit`, `broker.log` in
  the service folder). A core that ends during the start gets one automatic retry
  without UAC; a WARN is never shown as a reason. Report files carry the session in
  their name. The brokers remove an adapter left over from the previous run.
  Note: the Clash API opens only after the TUN inbound is up (`StartStateStarted`).
- **Journal**: ordinary broken connections are hidden without «Подробный журнал»;
  REALITY lines and «refused» to our own loopback ports are collapsed.
- A warning (nothing blocked) when TUN is started next to Happ, Koala Clash, FlClash, v2rayN.

## 0.4.4: updates by themselves, «LAN» tab

- **Updates** (`src/main/updater/`): checked ~30 s after start, every 3 h and 20 s
  after waking from sleep (if the last check is older than 30 min) — silently, a
  failure only goes to «Логи». A found version is downloaded in the background; the
  sidebar button turns green («Доступно обновление 0.4.x» → «Загрузка 42%» →
  «Перезапустить и обновить»), one Windows notification per version, an item in the
  tray menu. Install: on the button (VPN disconnected, `cipherway-core.exe` /
  `cipherway-xray.exe` waited for, then the installer) or quietly on «Выход»
  (`autoInstallOnAppQuit`; switched off on Windows shutdown). A manual check that
  fails shows a short toast. The state lives in main only (`AppUpdater`,
  `src/shared/updater.ts`); sidebar, «Настройки → Обновления» and tray draw from it.
  Dev / unpacked: no feed; `CIPHERWAY_DEV_FAKE_UPDATE=0.4.99` (or `0.4.99:flaky`,
  `fail`) simulates one.
- **«LAN»** in the sidebar: a placeholder for rooms to play over the network.
