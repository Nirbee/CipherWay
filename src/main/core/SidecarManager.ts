import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import {
  AUTO_OUTBOUND_ID,
  type AppNotice,
  type AppSettings,
  type AutoInfo,
  type ConnectionState,
  type LogEntry,
  type OutboundConfig,
  type RoutingMode,
  type RulesConfig,
  type ServerPing,
  type TrafficStats,
  type TunServiceInfo
} from '@shared/types'
import { generateProbeConfig, generateSingboxConfig, TUN_ADDRESS4 } from './configGen'
import { generateXrayConfig, isXrayHandled, type XrayBridge } from './xrayGen'
import { CORE_EXE, XRAY_EXE } from './coreNames'
import { ClashApi } from './clashApi'
import { CLASH_MODE, LATENCY_TIMEOUT_MS, TAG_AUTO, TAG_PROXY_GROUP } from './sbTypes'
import { hasTunAdapter, type CoreExit } from './broker'
import { LegacyLauncher, TunService, type LauncherPaths, type TunLauncher } from './tunService'
import { writeAtomic } from './atomicFile'
import { DirectFailures } from './connections'
import { LogFilter } from './logFilter'
import { REALITY_ERROR_RE, RealityWatch } from './realityWatch'
import { groupsFor, layoutRules, planRules, type RuleLayout } from '../rules/compile'
import { GeoCache } from '../rules/geo'
import { findFreePort } from '../system/ports'
import { disableSystemProxy, enableSystemProxy } from '../system/proxy'
import { allIps, resolveServers, toExcludeCidrs, type ServerIps } from '../system/resolve'

type LogFn = (entry: LogEntry) => void
type StateFn = (state: ConnectionState, message?: string) => void
type TrafficFn = (stats: TrafficStats) => void
type AutoFn = (info: AutoInfo) => void
type PingsFn = (pings: ServerPing[]) => void
type IpsFn = (ips: string[]) => void

export interface StartParams {
  outbounds: OutboundConfig[]
  activeOutboundId: string | undefined
  rules: RulesConfig
  settings: AppSettings
  /** last known latency per node id (persisted) — orders the urltest group */
  latencies?: Record<string, number | null>
  /** hosts the app reaches outside the tunnel in every mode (the subscription server) */
  directHosts?: string[]
}

/** Optional reactions of the app + what tests replace. */
export interface ManagerHooks {
  /** a toast for the user */
  onNotice?: (n: AppNotice) => void
  /** REALITY errors: the subscription should be fetched (call realityHealDone() after) */
  onRealityHeal?: () => void
  /** node id → hint for the server list */
  onServerHints?: (hints: Record<string, string>) => void
  /**
   * The routing mode the user has chosen right now (the store). StartParams are
   * a snapshot: a start / reload waiting in the queue or creating the adapter
   * must not bring back the mode of the moment it was requested.
   */
  routingMode?: () => RoutingMode
  /** tests: a broker that needs no elevation */
  launcherFactory?: (paths: LauncherPaths, cancelled: () => boolean) => Promise<TunLauncher>
}

/** a core that died is restarted up to this many times, after these pauses */
const RESTART_DELAYS_MS = [1000, 3000, 5000]
/** a run this long after the last restart: the count starts over */
const RESTART_FORGET_MS = 60_000
const XRAY_READY_TIMEOUT_MS = 8000
/** system proxy: sing-box is up in well under a second */
const CORE_READY_TIMEOUT_MS = 25_000
/**
 * TUN: sing-box opens its Clash API only after the TUN inbound is up
 * (StartStateStarted, 1.13.x), so this also covers creating the wintun adapter
 * and the time the user needs to answer a UAC prompt.
 */
const CORE_READY_TIMEOUT_TUN_MS = 90_000
/** TUN: one automatic retry when the core dies or the adapter doesn't appear (no UAC) */
const TUN_RETRIES = 1
/** how long the previous adapter may take to disappear */
const ADAPTER_GONE_TIMEOUT_MS = 8000
/** TUN: creating the wintun adapter the very first time can take half a minute */
const TUN_ADAPTER_TIMEOUT_MS = 45_000
const PROBE_READY_TIMEOUT_MS = 8000
/**
 * The urltest group's startup check: `now` appears only once EVERY member
 * answered or failed — a node that silently drops packets holds it for
 * sing-box's TCP timeout (15 s). 0.4.1 gave up after 8 s → a false «no
 * server answers».
 */
const AUTO_FIRST_CHECK_MS = 20_000
/** a failed check is repeated once after this pause before warning */
const AUTO_RETRY_MS = 5000
/** explicit group check: sing-box waits for its slowest member (up to 15 s) */
const AUTO_CHECK_WAIT_MS = 20_000
/** sing-box re-reads a changed local rule-set within ~0.3 s (1.13.14) */
const RULE_RELOAD_MS = 800
/** PATCH /configs + read-back attempts right after a start */
const MODE_SET_TRIES = 3
/** the core's mode is compared with the chosen one this often (s) */
const MODE_CHECK_TICKS = 5

const NO_AUTO: AutoInfo = { checking: false, dead: false }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Resolves true once something accepts TCP connections on 127.0.0.1:port. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(500, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** xray prints "2026/01/01 00:00:00.000000 [Warning] ..." — map to our levels. */
function xrayLevel(line: string): LogEntry['level'] {
  if (/\[Error\]|^panic/i.test(line)) return 'error'
  if (/\[Warning\]/i.test(line)) return 'warn'
  if (/\[Debug\]/i.test(line)) return 'debug'
  return 'info'
}

function singboxLevel(line: string): LogEntry['level'] {
  if (/\b(ERROR|FATAL|PANIC)\b|error|fatal/i.test(line)) return 'error'
  if (/\bWARN\b|warn/i.test(line)) return 'warn'
  return 'info'
}

/** Picks free loopback ports for every VLESS node, avoiding `taken`. */
async function allocBridges(nodes: OutboundConfig[], taken: Set<number>): Promise<XrayBridge[]> {
  const bridges: XrayBridge[] = []
  for (const o of nodes) {
    let port = await findFreePort(0)
    while (taken.has(port)) port = await findFreePort(0)
    taken.add(port)
    bridges.push({ outbound: o, port })
  }
  return bridges
}

function killProc(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 2000)
    proc.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
    proc.kill()
  })
}

/** The «Служба TUN» task could not run the core — this start falls back to a UAC prompt. */
class ServiceUnavailable extends Error {}

const sameIds = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** 12500 → «12,5 с» */
const seconds = (ms: number | null | undefined): string =>
  ms === null || ms === undefined
    ? '?'
    : `${(ms / 1000).toFixed(1).replace('.', ',').replace(',0', '')} с`

/** `ERROR [123 5ms] connection: …` is about one connection, never about the core itself. */
const CONNECTION_LINE_RE = /ERROR\s+\[\d+ [^\]]*\]|\bconnection: /

/** How an xray line tells about itself: `<date> <time> [Level] [session] …`. */
const XRAY_SESSION_RE = /^\S+ \S+ \[\w+\] \[(\d+)\] /
const XRAY_DETOUR_RE = /taking detour \[out-([^\]]+)\]/
const XRAY_TAGGED_QUIET_RE = /^\S+ \S+ \[(Info|Debug)\]/
/** what xray prints when it can't start: no timestamp («Failed to start: …», a panic) */
const XRAY_START_ERROR_RE = /^(?!\d{4}\/\d{2}\/\d{2} ).*(failed|error|panic|fatal)/i
/** sessions remembered for matching a REALITY line with its node */
const XRAY_SESSIONS_MAX = 4000

/**
 * Drives the cores: xray (VLESS connections, one loopback SOCKS inbound per
 * node) and sing-box (TUN / system proxy, routing, DNS, Hysteria2).
 * Order: xray starts before sing-box and stops after it. A core that dies while
 * connected is restarted alone, up to 3 times (xray keeps its ports, so sing-box
 * doesn't even notice) — only then everything stops with an error.
 *  - System Proxy mode: sing-box spawned as a normal child (full stdio), the
 *    WinInet registry proxy points at its mixed inbound.
 *  - TUN mode: sing-box needs admin — through the «Служба TUN» task (no UAC
 *    prompt after the one-time setup) or, if the user removed it, an
 *    elevated broker per connect (tunService.ts).
 * Every operation (connect / disconnect / reload / applying rules) runs
 * through ONE queue — never two starts at once. «Connected» is reported only
 * once the Clash API of the new core answers. Routing mode, server switches
 * and the user's rules (local rule-sets + selectors) change on the fly; the
 * core is restarted only for new servers, TUN ↔ proxy, or when the rules
 * outgrow the slots reserved at start.
 */
export class SidecarManager {
  private child: ChildProcess | null = null // system-proxy mode child
  private xray: ChildProcess | null = null // xray-core child (always non-elevated)
  private xrayTail: string[] = [] // last output lines, for error messages
  private coreTail: string[] = [] // last sing-box lines, for error messages
  private xrayPorts: number[] = [] // SOCKS ports of the running xray (a restart reuses them)
  /** a dead core is being restarted (keeps the state «connected») */
  private recovering = false
  private restartsUsed = 0
  private lastRestartAt = 0
  /** TUN: automatic retries used by this start */
  private tunRetries = 0
  /** xray session number → node id */
  private xraySessions = new Map<string, string>()
  private reality = new RealityWatch()
  private logFilter: LogFilter
  private intentionalStop = false
  private starting = false
  private running = false
  private mode: AppSettings['proxyMode'] = 'system'
  private api: ClashApi | null = null
  private auto: AutoInfo = NO_AUTO
  /** bumps on every start/stop so a stale background check can't publish */
  private autoGen = 0
  /** latencies measured during this app run (fresher than StartParams.latencies) */
  private recentPings: Record<string, number | null> = {}
  private nodeIds: string[] = []
  /** TUN: an adapter with our address was already there before this start */
  private staleAdapter = false
  private probing: Promise<ServerPing[]> | null = null
  /** we switched the Windows proxy on and must switch it off again */
  private proxySet = false
  /** TUN: who runs the elevated core */
  private launcher: TunLauncher | null = null
  private tunSvc: TunService | null = null
  private geoCache: GeoCache | null = null

  /** one queue for start / stop / reload / rules */
  private queue: Promise<unknown> = Promise.resolve()
  /** bumped by stop(): a queued or running start of an older generation gives up */
  private opGen = 0

  // rule slots of the running core
  private groups = 0
  private written = new Map<string, string>()
  private selectors: Record<string, string> = {}
  private labelMap: Record<string, string> = {}
  private programMap: Record<string, string[]> = {}
  /** «mode differs» already logged for this core mode → chosen mode */
  private modeWarned = ''
  readonly failures = new DirectFailures()

  private trafficTimer: NodeJS.Timeout | null = null
  private tailTimer: NodeJS.Timeout | null = null
  private tailPath = ''
  private tailPos = 0
  private tick = 0
  private prevTotals: { up: number; down: number } | null = null

  private ports = { http: 0, clashApi: 0 }
  private lastParams: StartParams | null = null
  private totals: TrafficStats = {
    uploadSpeed: 0,
    downloadSpeed: 0,
    totalUpload: 0,
    totalDownload: 0
  }

  constructor(
    private onLog: LogFn,
    private onState: StateFn,
    private onTraffic: TrafficFn,
    private onAuto: AutoFn = () => undefined,
    /** latencies measured by the running core (startup check of the group) */
    private onPings: PingsFn = () => undefined,
    /** resolved node IPs — so they are masked in the log like the host names */
    private onServerIps: IpsFn = () => undefined,
    private hooks: ManagerHooks = {}
  ) {
    this.logFilter = new LogFilter((e) => this.onLog(e))
  }

  private get binDir(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'bin')
      : join(process.cwd(), 'resources', 'bin')
  }
  private get runDir(): string {
    return join(app.getPath('userData'), 'run')
  }
  private get rulesDir(): string {
    return join(this.runDir, 'rules')
  }
  private exePath(): string {
    return join(this.binDir, CORE_EXE)
  }
  private xrayExePath(): string {
    return join(this.binDir, XRAY_EXE)
  }
  private get configPath(): string {
    return join(this.runDir, 'config.json')
  }
  private get xrayConfigPath(): string {
    return join(this.runDir, 'xray.json')
  }
  private get logPath(): string {
    return join(this.runDir, 'sing-box.log')
  }
  private get paths(): LauncherPaths {
    return {
      binDir: this.binDir,
      runDir: this.runDir,
      configPath: this.configPath,
      rulesDir: this.rulesDir,
      logPath: this.logPath
    }
  }

  private get tunService(): TunService {
    this.tunSvc ??= new TunService({
      binDir: this.binDir,
      runDir: this.runDir,
      appVersion: typeof app.getVersion === 'function' ? app.getVersion() : '0',
      log: (level, msg) => this.log(level, 'app', msg)
    })
    return this.tunSvc
  }

  private get geo(): GeoCache {
    this.geoCache ??= new GeoCache({
      dir: join(app.getPath('userData'), 'geo'),
      decompile: (srs, json) =>
        new Promise<void>((resolve, reject) =>
          execFile(
            this.exePath(),
            ['rule-set', 'decompile', srs, '-o', json],
            { windowsHide: true, timeout: 30_000 },
            (err) => (err ? reject(err) : resolve())
          )
        ),
      warn: (msg) => this.log('warn', 'app', msg)
    })
    return this.geoCache
  }

  /** Clash API of the running core (null while disconnected). */
  get clash(): ClashApi | null {
    return this.running ? this.api : null
  }
  get proxyMode(): AppSettings['proxyMode'] {
    return this.mode
  }
  get isRunning(): boolean {
    return this.running
  }
  /** rule-set tag → the user's rule it holds (for «Подключения») */
  get labels(): Record<string, string> {
    return this.labelMap
  }
  /** rule-set tag → PROCESS-NAME values of its run (for «Подключения») */
  get programs(): Record<string, string[]> {
    return this.programMap
  }
  /** tests: pid of the system-proxy mode sing-box */
  get corePid(): number | undefined {
    return this.child?.pid
  }
  /** tests: pid of xray */
  get xrayPid(): number | undefined {
    return this.xray?.pid
  }
  /** Restarting a legacy (non-service) TUN core would mean a UAC prompt. */
  get reloadNeedsPrompt(): boolean {
    return this.launcher?.kind === 'legacy'
  }

  private log(level: LogEntry['level'], source: LogEntry['source'], message: string): void {
    if (!message) return
    const verbose = this.lastParams?.settings.verboseLog ?? false
    this.logFilter.push({ ts: Date.now(), level, source, message }, verbose)
  }

  private publishHints(): void {
    this.hooks.onServerHints?.(this.reality.hints())
  }

  /** The subscription was fetched after a REALITY error (whatever the result). */
  realityHealDone(): void {
    this.reality.healDone()
  }

  private coreLine(raw: string): void {
    // sing-box colours its stdout (ESC[31mFATAL ESC[0m) — not for the UI / error texts
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
    if (!line) return
    this.coreTail = [...this.coreTail.slice(-6), line]
    this.failures.noteLog(line)
    this.log(singboxLevel(line), 'singbox', line)
  }

  /** Runs `fn` after every operation queued before it. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  // --- public operations (all queued) --------------------------------------

  /** Connect. A no-op if already connected; cancelled by a later stop(). */
  start(p: StartParams): Promise<void> {
    const gen = this.opGen
    return this.serial(async () => {
      if (gen !== this.opGen || this.running) return
      await this.doStart(p, gen)
    })
  }

  /** Disconnect. Cancels a start that is still waiting (UAC, adapter). */
  stop(): Promise<void> {
    this.opGen++
    this.intentionalStop = true
    return this.serial(() => this.doStop(false))
  }

  /** Restart with a new config (TUN ↔ proxy, the server list changed). */
  reload(p: StartParams): Promise<void> {
    const gen = this.opGen
    return this.serial(async () => {
      if (gen !== this.opGen || !this.running) return
      this.log('info', 'app', 'Перезапуск ядра с новой конфигурацией…')
      await this.doStop(true)
      await this.doStart(p, gen)
    })
  }

  /**
   * The user's rules changed: rewrite the slot rule-sets + switch selectors,
   * no restart. While disconnected only remembers them (next start uses the store).
   */
  applyRules(p: StartParams): Promise<void> {
    const gen = this.opGen
    return this.serial(async () => {
      if (gen !== this.opGen || !this.running || !this.api) return
      await this.doApplyRules(p, gen)
    })
  }

  // --- «Служба TUN» ----------------------------------------------------------

  tunServiceStatus(): Promise<TunServiceInfo> {
    return this.tunService.status()
  }

  installTunService(): Promise<'ok' | 'cancelled' | 'failed'> {
    return this.serial(() => this.tunService.install())
  }

  removeTunService(): Promise<'ok' | 'cancelled' | 'failed'> {
    return this.serial(async () => {
      if (this.running && this.launcher?.kind === 'service') {
        throw new Error('Сначала отключите VPN')
      }
      return this.tunService.remove()
    })
  }

  // --- start -----------------------------------------------------------------

  /** Правила / Весь трафик / Напрямую as chosen now (see ManagerHooks.routingMode). */
  private wantedMode(p: StartParams | null = this.lastParams): RoutingMode {
    return this.hooks.routingMode?.() ?? p?.settings.routingMode ?? 'rule'
  }

  private async doStart(p: StartParams, gen: number): Promise<void> {
    // a reload queued a while ago carries the mode of that moment
    p = { ...p, settings: { ...p.settings, routingMode: this.wantedMode(p) } }
    // a latency probe holds its own cores — let it finish first
    if (this.probing) await this.probing.catch(() => undefined)
    // a previous xray (e.g. auto-restart path) must be gone before ports are re-bound
    await this.stopXray()
    this.intentionalStop = false
    this.restartsUsed = 0
    this.tunRetries = 0
    this.xraySessions.clear()
    if (this.reality.resetServers()) this.publishHints()
    this.lastParams = p
    this.mode = p.settings.proxyMode
    this.running = false
    this.api = null
    this.autoGen++
    this.setAuto(NO_AUTO)
    this.nodeIds = p.outbounds.map((o) => o.id)
    this.coreTail = []
    this.failures.clear()
    this.onState('connecting')
    const cancelled = (): boolean => gen !== this.opGen || this.intentionalStop

    if (!existsSync(this.exePath())) {
      this.onState('error', `${CORE_EXE} не найден — переустановите приложение`)
      this.log('error', 'app', `${CORE_EXE} отсутствует в ${this.binDir}`)
      throw new Error(`${CORE_EXE} missing`)
    }
    if (p.outbounds.length === 0) {
      this.onState('error', 'Нет серверов. Добавьте подписку на странице «Подписка».')
      throw new Error('no outbounds')
    }
    const xrayNodes = p.outbounds.filter(isXrayHandled)
    if (xrayNodes.length > 0 && !existsSync(this.xrayExePath())) {
      this.onState('error', `${XRAY_EXE} не найден — переустановите приложение`)
      this.log('error', 'app', `${XRAY_EXE} отсутствует в ${this.binDir}`)
      throw new Error(`${XRAY_EXE} missing`)
    }

    const tun = this.mode === 'tun'
    this.starting = true
    try {
      await mkdir(this.rulesDir, { recursive: true })
      await rm(this.logPath, { force: true }).catch(() => undefined)
      // 0.4.1 kept a cache_file (mode / selector of the previous run) — no longer used
      await rm(join(this.runDir, 'cache.db'), { force: true }).catch(() => undefined)

      // TUN: who will run the elevated core (may set up the service: one UAC prompt)
      if (tun) this.launcher = await this.pickLauncher(p, cancelled)
      if (cancelled()) return

      // TUN: node IPs are resolved now (system DNS, TUN not up yet), excluded
      // from the TUN routes and pinned in xray — its connections to the nodes
      // go straight out of the physical NIC instead of through sing-box again
      let serverIps: ServerIps = {}
      if (tun) {
        serverIps = await resolveServers(p.outbounds)
        this.onServerIps(allIps(serverIps))
        const hosts = new Set(p.outbounds.map((o) => o.server)).size
        this.log(
          'info',
          'app',
          `Адреса серверов определены: ${Object.keys(serverIps).length} из ${hosts}, исключено из TUN: ${toExcludeCidrs(serverIps).length}`
        )
      }

      this.ports.http = await findFreePort(p.settings.httpPort)
      this.ports.clashApi = await findFreePort(0)

      // one loopback SOCKS inbound per VLESS node, on random free ports
      const bridges = await allocBridges(xrayNodes, new Set([this.ports.http, this.ports.clashApi]))
      const xrayPorts = Object.fromEntries(bridges.map((b) => [b.outbound.id, b.port]))

      // the user's rules → slot rule-sets (rules/compile.ts)
      const plan = planRules(p.rules, p.outbounds)
      const geo = await this.geo.load(plan.geo)
      if (cancelled()) return
      this.groups = groupsFor(plan)
      const layout = layoutRules(plan, this.groups, geo) as RuleLayout
      await this.writeRuleFiles(layout, true)
      this.selectors = { ...layout.selectors }
      this.labelMap = layout.labels
      this.programMap = layout.programs

      const logFile = this.launcher?.coreLogPath ?? this.logPath
      const clashSecret = randomBytes(16).toString('hex')
      const cfg = generateSingboxConfig({
        outbounds: p.outbounds,
        activeOutboundId: p.activeOutboundId,
        slots: {
          groups: this.groups,
          dir: this.launcher?.coreRuleDir ?? this.rulesDir,
          selectors: layout.selectors
        },
        settings: p.settings,
        socksPort: p.settings.socksPort,
        httpPort: this.ports.http,
        clashApiPort: this.ports.clashApi,
        clashSecret,
        logFile,
        xrayPorts,
        serverIps,
        latencies: { ...(p.latencies ?? {}), ...this.recentPings },
        directHosts: p.directHosts
      })
      await writeFile(this.configPath, JSON.stringify(cfg, null, 2), 'utf8')

      if (bridges.length > 0) {
        const xcfg = generateXrayConfig(bridges, { serverIps })
        await writeFile(this.xrayConfigPath, JSON.stringify(xcfg, null, 2), 'utf8')
        this.xrayPorts = bridges.map((b) => b.port)
        await this.startXray(this.xrayPorts)
      }

      this.api = new ClashApi(this.ports.clashApi, clashSecret)
      // the service's log lives in its own folder and is appended to: skip what is there
      const skip =
        this.launcher?.kind === 'service'
          ? await stat(logFile).then(
              (s) => s.size,
              () => 0
            )
          : 0
      this.startLogTail(logFile, skip)
      if (this.launcher) {
        // after a reload the old adapter may take a moment to disappear
        // (one that stays is removed by the broker, it has the rights)
        this.staleAdapter = !(await this.adapterGone())
        if (this.staleAdapter)
          this.log('warn', 'app', 'Сетевой адаптер CipherWay остался от прошлого запуска')
        this.onState('connecting', 'Создаём сетевой адаптер…')
        await this.launcher.launch()
        const why = this.launcher.failure()
        if (why)
          throw this.launcher.kind === 'service' ? new ServiceUnavailable(why) : new Error(why)
      } else {
        this.startChild()
      }
      await this.waitCoreReady(cancelled)
      if (tun) await this.waitTunReady(cancelled)

      await this.applyRuntimeChoices(p)

      if (!tun) {
        await enableSystemProxy(this.ports.http)
        this.proxySet = true
        this.log('info', 'app', `Системный прокси включён на 127.0.0.1:${this.ports.http}`)
      }
      this.running = true
      this.modeWarned = ''
      // the mode may have been switched while the adapter was being created
      await this.ensureMode()
      this.startTrafficPolling()
      this.onState('connected')
      void this.autoCheck()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // (read before doStop — it sets intentionalStop itself)
      const byUser = cancelled()
      await this.doStop(true)
      // a stop() took over — it reports «disconnected» itself
      if (byUser) return
      if (err instanceof ServiceUnavailable) {
        // «Если службы нет — как раньше»: one UAC prompt for this connection
        this.log('warn', 'app', `${msg} — подключаемся с запросом прав администратора`)
        this.starting = false
        return this.doStart({ ...p, settings: { ...p.settings, tunService: false } }, gen)
      }
      this.onState('error', msg)
      throw err
    } finally {
      this.starting = false
    }
  }

  /** TUN: the «Служба TUN» task if allowed (set up / updated with one UAC prompt), else per-connect UAC. */
  private async pickLauncher(p: StartParams, cancelled: () => boolean): Promise<TunLauncher> {
    if (this.hooks.launcherFactory) return this.hooks.launcherFactory(this.paths, cancelled)
    const legacy = (): TunLauncher =>
      new LegacyLauncher(this.paths, (l, m) => this.log(l, 'app', m), cancelled)
    if (!p.settings.tunService) return legacy()
    const svc = this.tunService
    let st = await svc.status()
    if (st.detail) this.log('warn', 'app', `Служба TUN: ${st.detail}`)
    if (st.state !== 'ok') {
      this.onState(
        'connecting',
        st.state === 'outdated'
          ? 'Обновляем службу TUN — подтвердите запрос Windows…'
          : 'Устанавливаем службу TUN — подтвердите запрос Windows (только один раз)…'
      )
      const res = await svc.install().catch((err: unknown) => {
        this.log('warn', 'app', `Служба TUN: ${err instanceof Error ? err.message : err}`)
        return 'failed' as const
      })
      if (res === 'cancelled') {
        throw new Error('Не удалось получить права администратора для режима TUN')
      }
      st = res === 'ok' ? await svc.status() : st
      if (st.state !== 'ok') {
        this.log(
          'warn',
          'app',
          'Служба TUN недоступна — запускаем TUN с запросом прав администратора'
        )
        return legacy()
      }
      this.onState('connecting')
    }
    return svc.launcher(this.paths, cancelled).catch(() => legacy())
  }

  private async applyRuntimeChoices(p: StartParams): Promise<void> {
    const api = this.api
    if (!api) return
    const mode = this.wantedMode(p)
    p.settings = { ...p.settings, routingMode: mode }
    // read back: a 204 alone proves nothing (see RULE_MODE_TAIL in configGen.ts)
    let ok = false
    for (let i = 0; i < MODE_SET_TRIES && !ok; i++) {
      if (i > 0) await sleep(300)
      ok = await api.setMode(CLASH_MODE[mode]).catch(() => false)
    }
    const now = await api.getMode().catch(() => null)
    this.log(
      ok ? 'info' : 'warn',
      'app',
      ok
        ? `Режим ядра: ${now ?? CLASH_MODE[mode]}`
        : `Ядро не переключилось в режим ${CLASH_MODE[mode]} (сейчас ${now ?? '?'})`
    )
    const ids = new Set(p.outbounds.map((o) => o.id))
    const target =
      p.activeOutboundId && (p.activeOutboundId === AUTO_OUTBOUND_ID || ids.has(p.activeOutboundId))
        ? p.activeOutboundId
        : TAG_AUTO
    await api.select(TAG_PROXY_GROUP, target).catch(() => false)
  }

  /**
   * Waits until the new sing-box answers on its Clash API, or explains why not.
   * TUN: the answer means the adapter exists too; a core that dies on the way gets
   * one automatic retry — the same thing a second click would do.
   */
  private async waitCoreReady(cancelled: () => boolean, timeoutMs?: number): Promise<void> {
    const api = this.api
    if (!api) throw new Error('Ядро не запущено')
    const l = this.launcher
    let deadline =
      Date.now() + (timeoutMs ?? (l ? CORE_READY_TIMEOUT_TUN_MS : CORE_READY_TIMEOUT_MS))
    let exit: CoreExit | null = null
    while (Date.now() < deadline) {
      if (cancelled()) throw new Error('Подключение отменено')
      if (await api.ping()) return
      const why = l?.failure()
      if (why) throw new Error(why)
      if (!l && !this.child) break // sing-box exited during startup
      if (!l && this.coreTail.some((x) => /\bFATAL\b/.test(x))) break
      if (l && (await l.exited())) {
        exit = await this.noteCoreExit(l)
        if (this.tunRetries >= TUN_RETRIES) break
        this.tunRetries++
        this.log(
          'warn',
          'app',
          `Ядро завершилось при создании адаптера (${this.exitWords(exit)}), повторяем`
        )
        this.onState('connecting', 'Повторная попытка: создаём сетевой адаптер…')
        this.coreTail = []
        exit = null
        await l.restartCore()
        const failed = l.failure()
        if (failed) throw new Error(failed)
        deadline = Date.now() + CORE_READY_TIMEOUT_TUN_MS
        continue
      }
      await sleep(250)
    }
    const reason = await this.coreReason()
    const details = !reason && exit ? ` (${this.exitWords(exit)})` : ''
    throw new Error(`Ядро sing-box не запустилось${reason || details}`)
  }

  /** «код 1, через 12,5 с» */
  private exitWords(exit: CoreExit | null): string {
    return `код ${exit?.code ?? '?'}, через ${seconds(exit?.uptimeMs)}`
  }

  /**
   * What the broker knows about a core that ended: the journal gets the exit
   * code, the time and what the core printed (its FATAL goes to stderr, never to
   * log.output). The lines also feed coreTail, so coreReason() finds them.
   */
  private async noteCoreExit(l: TunLauncher): Promise<CoreExit | null> {
    await this.tailOnce()
    const exit = await l.exitInfo()
    this.log(
      'warn',
      'singbox',
      `Ядро завершилось: ${this.exitWords(exit)}${exit?.note ? ` (служба: ${exit.note})` : ''}`
    )
    for (const line of exit?.stderr.split('\n') ?? []) {
      if (line.trim()) this.coreLine(line.trim())
    }
    return exit
  }

  /**
   * «: <reason>» — only what sing-box itself called FATAL / ERROR (not a line about
   * one connection), or '' with no details. A WARN like «open interface take too
   * much time» says nothing about why the core ended.
   */
  private async coreReason(): Promise<string> {
    await this.tailOnce()
    const fatal = this.coreTail.filter((l) => /\b(FATAL|PANIC)\b|^panic:/.test(l)).at(-1)
    const error = this.coreTail
      .filter((l) => /\bERROR\b/.test(l) && !CONNECTION_LINE_RE.test(l))
      .at(-1)
    const reason = fatal ?? error
    return reason ? `: ${reason.replace(/^.*?(FATAL|ERROR)(\[\d+\])?\s*/, '')}` : ''
  }

  /** Waits for the adapter of the previous run to disappear; false = it stayed. */
  private async adapterGone(): Promise<boolean> {
    const end = Date.now() + ADAPTER_GONE_TIMEOUT_MS
    while (hasTunAdapter(networkInterfaces(), TUN_ADDRESS4)) {
      if (Date.now() >= end) return false
      await sleep(200)
    }
    return true
  }

  /**
   * TUN: makes sure the wintun adapter really is there («connected» is only
   * reported with it). The first one on a machine can take 20–40 s («open
   * interface take too much time» — just a warning). A core that ended here or an
   * adapter that never appeared uses up the one automatic retry (no UAC prompt).
   */
  private async waitTunReady(cancelled: () => boolean): Promise<void> {
    let why = ''
    for (;;) {
      this.onState(
        'connecting',
        this.tunRetries === 0
          ? 'Создаём сетевой адаптер…'
          : 'Повторная попытка: создаём сетевой адаптер…'
      )
      const res = await this.pollAdapter(TUN_ADAPTER_TIMEOUT_MS, cancelled)
      if (res === 'ok') {
        this.log('info', 'app', 'Сетевой адаптер TUN готов')
        return
      }
      if (res === 'cancel') throw new Error('Подключение отменено')
      const exit = res === 'exited' && this.launcher ? await this.noteCoreExit(this.launcher) : null
      why = res === 'exited' ? await this.coreReason() : ''
      const what =
        res === 'exited'
          ? `Ядро завершилось при создании адаптера (${this.exitWords(exit)})`
          : `Адаптер TUN не создан за ${TUN_ADAPTER_TIMEOUT_MS / 1000} с`
      if (this.tunRetries >= TUN_RETRIES) {
        this.log('warn', 'app', what)
        break
      }
      this.tunRetries++
      this.log('warn', 'app', `${what}, повторяем`)
      this.coreTail = []
      await this.launcher?.restartCore()
      await this.waitCoreReady(cancelled, CORE_READY_TIMEOUT_TUN_MS)
    }
    throw new Error(
      `Не удалось создать сетевой адаптер TUN${why}. Перезагрузите компьютер и попробуйте снова или выберите «Системный прокси» в Настройках.`
    )
  }

  private async pollAdapter(
    timeoutMs: number,
    cancelled: () => boolean
  ): Promise<'ok' | 'exited' | 'timeout' | 'cancel'> {
    const api = this.api
    const since = Date.now()
    const deadline = since + timeoutMs
    while (Date.now() < deadline) {
      if (cancelled()) return 'cancel'
      if (await this.launcher?.exited()) return 'exited'
      // a leftover adapter proves nothing: then give the core a few seconds to fail
      const up =
        hasTunAdapter(networkInterfaces(), TUN_ADDRESS4) &&
        (!this.staleAdapter || Date.now() - since > 3000)
      if (up && (await api?.ping())) return 'ok'
      await sleep(300)
    }
    return 'timeout'
  }

  /**
   * Starts xray-core and waits until every SOCKS inbound accepts
   * connections. Throws (with a readable reason) if xray exits or times out.
   */
  private async startXray(ports: number[]): Promise<void> {
    this.xrayTail = []
    const proc = spawn(this.xrayExePath(), ['run', '-c', this.xrayConfigPath], {
      cwd: this.binDir,
      windowsHide: true
    })
    this.xray = proc
    let exited = false
    let rest = ''
    const onData = (d: Buffer): void => {
      const lines = (rest + d.toString()).split(/\r?\n/)
      rest = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (line) this.xrayLine(line)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (err) =>
      this.log('error', 'xray', `Не удалось запустить xray: ${err.message}`)
    )
    proc.on('exit', (code) => {
      exited = true
      if (rest.trim()) this.xrayLine(rest.trim())
      rest = ''
      if (this.xray !== proc) return // stopped on purpose / replaced
      this.xray = null
      this.log('warn', 'xray', `xray завершился (code=${code})`)
      if (this.intentionalStop || this.starting) return
      this.recover('Xray', code)
    })
    this.log('info', 'app', `Запуск xray: узлов VLESS — ${ports.length}, вход 127.0.0.1`)

    // every node's inbound must accept connections before sing-box starts:
    // the first DNS query / urltest probe goes through them immediately
    const deadline = Date.now() + XRAY_READY_TIMEOUT_MS
    const pending = new Set(ports)
    while (Date.now() < deadline && !exited) {
      const res = await Promise.all(
        [...pending].map(async (pt) => [pt, await probePort(pt)] as const)
      )
      for (const [pt, ok] of res) if (ok) pending.delete(pt)
      if (pending.size === 0) return
      await sleep(150)
    }
    // only what xray itself reported as a start failure — not its banner, not traffic
    const reported = this.xrayTail.filter((l) => XRAY_START_ERROR_RE.test(l)).at(-1)
    const reason = exited
      ? (reported ?? `xray завершился`)
      : `входы xray не отвечают (${pending.size} из ${ports.length})`
    await this.stopXray()
    throw new Error(`Не удалось запустить ядро Xray: ${reason}`)
  }

  /**
   * One line of xray output. The log level is always `info` (see xrayGen.ts):
   * it pairs session numbers with nodes, so a REALITY error can name its server;
   * the info lines reach «Журнал» only with «Подробный журнал».
   */
  private xrayLine(line: string): void {
    const session = XRAY_SESSION_RE.exec(line)?.[1]
    const detour = XRAY_DETOUR_RE.exec(line)?.[1]
    if (session && detour) {
      if (this.xraySessions.size >= XRAY_SESSIONS_MAX) {
        const oldest = this.xraySessions.keys().next().value
        if (oldest !== undefined) this.xraySessions.delete(oldest)
      }
      this.xraySessions.set(session, detour)
    }
    const quiet = XRAY_TAGGED_QUIET_RE.test(line)
    if (REALITY_ERROR_RE.test(line)) {
      this.noteReality(session ? this.xraySessions.get(session) : undefined)
    } else if (!quiet) {
      this.xrayTail = [...this.xrayTail.slice(-4), line]
    }
    const level = xrayLevel(line)
    const verbose = this.lastParams?.settings.verboseLog ?? false
    if ((level === 'info' || level === 'debug') && !verbose) return
    this.log(level, 'xray', line)
  }

  private noteReality(nodeId: string | undefined): void {
    const res = this.reality.note(nodeId)
    if (res.hintsChanged) this.publishHints()
    if (res.heal) {
      if (this.hooks.onRealityHeal) this.hooks.onRealityHeal()
      else this.reality.healDone()
    }
  }

  private async stopXray(): Promise<void> {
    const proc = this.xray
    if (!proc) return
    this.xray = null // the exit handler ignores a process we stop ourselves
    await killProc(proc)
  }

  /** System-proxy mode: normal child process with captured stdio. */
  private startChild(): void {
    const proc = spawn(this.exePath(), ['run', '-c', this.configPath], {
      cwd: this.binDir, // so wintun.dll / assets resolve next to the exe
      windowsHide: true
    })
    this.child = proc
    proc.on('error', (err) =>
      this.log('error', 'singbox', `Не удалось запустить ядро: ${err.message}`)
    )
    const onData = (d: Buffer): void => {
      for (const raw of d.toString().split(/\r?\n/)) {
        const line = raw.trim()
        if (line) this.coreLine(line)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', (code) => {
      if (this.child !== proc) return
      this.log('warn', 'singbox', `sing-box завершился (code=${code})`)
      this.child = null
      if (this.starting || this.intentionalStop) return
      this.recover('sing-box', code)
    })
  }

  // --- a core died while connected -------------------------------------------

  /**
   * Queues the restart of whatever died. Xray keeps its ports and config, so
   * sing-box and the TUN adapter stay up; sing-box keeps its config and Clash API
   * port, so the system proxy stays valid and TUN needs no UAC prompt.
   * `taskkill /f` of another program gives code 1 — that is no reason to drop the
   * connection, and the old log tail is no reason to blame the server.
   */
  private recover(what: 'Xray' | 'sing-box', code: number | null): void {
    if (this.recovering) return
    this.recovering = true
    const gen = this.opGen
    void this.serial(() => this.recoverCores(what, code, gen))
      .catch(() => undefined)
      .finally(() => {
        this.recovering = false
      })
  }

  private async recoverCores(
    what: 'Xray' | 'sing-box',
    code: number | null,
    gen: number
  ): Promise<void> {
    const cancelled = (): boolean => gen !== this.opGen || this.intentionalStop || !this.running
    if (cancelled()) return
    if (Date.now() - this.lastRestartAt > RESTART_FORGET_MS) this.restartsUsed = 0
    let startError = ''
    while (this.restartsUsed < RESTART_DELAYS_MS.length) {
      const delay = RESTART_DELAYS_MS[this.restartsUsed]
      this.restartsUsed++
      this.lastRestartAt = Date.now()
      this.log(
        'warn',
        'app',
        `Ядро ${what} остановилось (код ${code ?? '?'}) — перезапуск через ${delay / 1000} с, попытка ${this.restartsUsed} из ${RESTART_DELAYS_MS.length}`
      )
      for (const end = Date.now() + delay; Date.now() < end; await sleep(100)) {
        if (cancelled()) return
      }
      if (cancelled()) return
      try {
        await this.restartDeadCores(cancelled)
        if (cancelled()) return
        this.lastRestartAt = Date.now()
        this.log('info', 'app', 'Ядро перезапущено')
        this.hooks.onNotice?.({ text: 'Ядро перезапущено', tone: 'info' })
        return
      } catch (err) {
        if (cancelled()) return
        startError = err instanceof Error ? err.message : String(err)
        this.log('warn', 'app', `Перезапуск не удался: ${startError}`)
      }
    }
    // the reason only if the process itself said why it couldn't start
    const told =
      /: /.test(startError) && !/входы xray не отвечают|xray завершился$/.test(startError)
    await this.doStop(true)
    this.onState(
      'error',
      `Ядро ${what} остановилось (код ${code ?? '?'}) и не перезапустилось, соединение разорвано.${told ? ` ${startError}` : ''} Нажмите «Подключить», чтобы попробовать снова.`
    )
  }

  /** Starts what is not running (xray first, as at a normal start). */
  private async restartDeadCores(cancelled: () => boolean): Promise<void> {
    if (this.xrayPorts.length > 0 && !this.xray) await this.startXray(this.xrayPorts)
    const l = this.launcher
    const coreDead = l ? await l.exited() : !this.child
    if (coreDead) {
      this.coreTail = []
      this.tunRetries = 0
      if (l) {
        await this.noteCoreExit(l)
        this.onState('connecting', 'Перезапуск ядра…')
        await l.restartCore()
      } else {
        this.startChild()
      }
      await this.waitCoreReady(cancelled, l ? CORE_READY_TIMEOUT_TUN_MS : CORE_READY_TIMEOUT_MS)
      if (l) await this.waitTunReady(cancelled)
      if (this.lastParams) await this.applyRuntimeChoices(this.lastParams)
      if (l) this.onState('connected')
    }
    // it may have gone down too in the meantime
    if (this.xrayPorts.length > 0 && !this.xray) await this.startXray(this.xrayPorts)
  }

  // --- rules on the fly ------------------------------------------------------

  /** Writes the slot files that changed; `clean` = fresh start (old files removed). */
  private async writeRuleFiles(layout: RuleLayout, clean: boolean): Promise<number> {
    if (clean) {
      this.written.clear()
      for (const f of await readdir(this.rulesDir).catch(() => [] as string[])) {
        if (/^cw-.*\.json/.test(f)) await rm(join(this.rulesDir, f), { force: true })
      }
    }
    let changed = 0
    for (const [name, text] of Object.entries(layout.files)) {
      if (this.written.get(name) === text) continue
      await writeAtomic(join(this.rulesDir, name), text)
      this.written.set(name, text)
      changed++
    }
    return changed
  }

  private async doApplyRules(p: StartParams, gen: number): Promise<void> {
    const api = this.api
    if (!api) return
    const restart = async (why: string): Promise<void> => {
      this.log('info', 'app', why)
      await this.doStop(true)
      await this.doStart(p, gen)
    }
    if (p.settings.proxyMode !== this.mode) {
      return restart('Режим подключения изменился — перезапуск ядра')
    }
    if (
      !sameIds(
        p.outbounds.map((o) => o.id),
        this.nodeIds
      )
    ) {
      return restart('Список серверов изменился — перезапуск ядра')
    }
    const plan = planRules(p.rules, p.outbounds)
    const geo = await this.geo.load(plan.geo)
    if (gen !== this.opGen || !this.running) return
    const layout = layoutRules(plan, this.groups, geo)
    if (!layout) return restart('Правил стало намного больше — перезапуск ядра')

    const changedFiles = await this.writeRuleFiles(layout, false)
    if (changedFiles > 0) await this.launcher?.syncRules()
    let changedSel = 0
    for (const [sel, target] of Object.entries(layout.selectors)) {
      if (this.selectors[sel] === target) continue
      if (await api.select(sel, target).catch(() => false)) changedSel++
      else this.log('warn', 'app', `Не удалось переключить ${sel}`)
    }
    this.selectors = { ...layout.selectors }
    this.labelMap = layout.labels
    this.programMap = layout.programs
    if (this.lastParams) this.lastParams = { ...this.lastParams, rules: p.rules }
    if (changedFiles === 0 && changedSel === 0) return
    // let sing-box re-read the files, then move open connections to the new routes
    await sleep(RULE_RELOAD_MS)
    if (gen !== this.opGen || !this.running) return
    await api.closeAll()
    this.log('info', 'app', 'Правила применены без переподключения')
  }

  /** Правила / Весь трафик / Напрямую — on the fly; open connections are reset. */
  async setRoutingMode(mode: RoutingMode): Promise<boolean> {
    if (this.lastParams)
      this.lastParams.settings = { ...this.lastParams.settings, routingMode: mode }
    const api = this.clash
    if (!api) return false
    // true only once GET /configs shows the new mode
    const ok = await api.setMode(CLASH_MODE[mode]).catch(() => false)
    // existing connections keep their old route otherwise
    if (ok) await api.closeAll()
    if (ok) this.modeWarned = ''
    this.log(
      ok ? 'info' : 'warn',
      'app',
      ok ? `Режим ядра: ${CLASH_MODE[mode]}` : `Ядро не переключилось в режим ${CLASH_MODE[mode]}`
    )
    return ok
  }

  /** Switches the `proxy` selector (a node id or «auto»); false = needs a restart. */
  async selectServer(id: string): Promise<boolean> {
    if (this.lastParams) this.lastParams.activeOutboundId = id
    const api = this.clash
    if (!api) return false
    const ok = await api.select(TAG_PROXY_GROUP, id).catch(() => false)
    if (ok) void this.refreshAuto()
    return ok
  }

  /**
   * Real latency of every node: an HTTP request to generate_204 through the
   * node itself (Clash API `/delay`), in parallel, 5 s timeout. While
   * disconnected a throw-away xray + sing-box pair (no inbounds) is started
   * just for the test and stopped right after.
   */
  async testLatency(outbounds: OutboundConfig[]): Promise<ServerPing[]> {
    const api = this.clash
    if (api) return this.measure(api, outbounds)
    if (this.starting) return outbounds.map((o) => ({ outboundId: o.id, latencyMs: null }))
    this.probing ??= this.probe(outbounds).finally(() => {
      this.probing = null
    })
    return this.probing
  }

  private async measure(api: ClashApi, outbounds: OutboundConfig[]): Promise<ServerPing[]> {
    const res = await Promise.all(
      outbounds.map(async (o) => ({ outboundId: o.id, latencyMs: await api.delay(o.id) }))
    )
    this.remember(res)
    return res
  }

  private remember(pings: ServerPing[]): void {
    for (const p of pings) this.recentPings[p.outboundId] = p.latencyMs
  }

  private async probe(outbounds: OutboundConfig[]): Promise<ServerPing[]> {
    const none = outbounds.map((o) => ({ outboundId: o.id, latencyMs: null }))
    if (outbounds.length === 0 || !existsSync(this.exePath())) return none
    const dir = join(this.runDir, 'probe')
    await mkdir(dir, { recursive: true })
    let xray: ChildProcess | null = null
    let core: ChildProcess | null = null
    try {
      const clashPort = await findFreePort(0)
      const vless = outbounds.filter(isXrayHandled)
      const bridges = existsSync(this.xrayExePath())
        ? await allocBridges(vless, new Set([clashPort]))
        : []
      const usable = outbounds.filter(
        (o) => !isXrayHandled(o) || bridges.some((b) => b.outbound.id === o.id)
      )
      const xrayPorts = Object.fromEntries(bridges.map((b) => [b.outbound.id, b.port]))

      if (bridges.length) {
        const xcfg = join(dir, 'xray.json')
        await writeFile(xcfg, JSON.stringify(generateXrayConfig(bridges)), 'utf8')
        xray = spawn(this.xrayExePath(), ['run', '-c', xcfg], {
          cwd: this.binDir,
          windowsHide: true
        })
        xray.stdout?.resume()
        xray.stderr?.resume()
      }
      const cfgPath = join(dir, 'sing-box.json')
      const cfg = generateProbeConfig({
        outbounds: usable,
        clashApiPort: clashPort,
        logFile: join(dir, 'sing-box.log'),
        xrayPorts
      })
      await writeFile(cfgPath, JSON.stringify(cfg), 'utf8')
      core = spawn(this.exePath(), ['run', '-c', cfgPath], { cwd: this.binDir, windowsHide: true })
      core.stdout?.resume()
      core.stderr?.resume()

      const api = new ClashApi(clashPort)
      const deadline = Date.now() + PROBE_READY_TIMEOUT_MS
      let up = false
      while (Date.now() < deadline && core.exitCode === null) {
        if (await api.ping()) {
          up = true
          break
        }
        await sleep(150)
      }
      if (!up) {
        this.log('warn', 'app', 'Проверка задержки: временное ядро не запустилось')
        return none
      }
      // xray needs a moment to bind its inbounds too
      if (bridges.length) {
        const xd = Date.now() + XRAY_READY_TIMEOUT_MS
        while (Date.now() < xd && xray?.exitCode === null && !(await probePort(bridges[0].port))) {
          await sleep(100)
        }
      }
      const measured = await this.measure(api, usable)
      const byId = new Map(measured.map((m) => [m.outboundId, m.latencyMs]))
      return outbounds.map((o) => ({ outboundId: o.id, latencyMs: byId.get(o.id) ?? null }))
    } catch (err) {
      this.log(
        'warn',
        'app',
        `Проверка задержки не удалась: ${err instanceof Error ? err.message : err}`
      )
      return none
    } finally {
      await killProc(core)
      await killProc(xray)
      // configs hold node credentials — don't leave them around
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // --- stop ------------------------------------------------------------------

  private async doStop(keepIntent: boolean): Promise<void> {
    this.intentionalStop = true
    this.running = false
    this.stopTrafficPolling()

    this.autoGen++

    const launcher = this.launcher
    this.launcher = null
    if (launcher) {
      await launcher.stop()
      // the next start must not meet the old adapter (the broker checks again)
      if (!(await this.adapterGone()))
        this.log('warn', 'app', 'Сетевой адаптер CipherWay ещё не удалён системой')
    } else {
      const child = this.child
      this.child = null
      await killProc(child)
    }
    // only undo what we did — never reset a proxy someone else configured
    if (this.proxySet) {
      this.proxySet = false
      await disableSystemProxy().catch(() => undefined)
    }
    // xray goes down after sing-box, so traffic never falls through to direct
    await this.stopXray()
    this.xrayPorts = []
    await this.tailOnce()
    this.stopLogTail()
    this.logFilter.flush()
    this.api = null
    this.setAuto(NO_AUTO)

    if (!keepIntent) {
      this.totals = { uploadSpeed: 0, downloadSpeed: 0, totalUpload: 0, totalDownload: 0 }
      this.prevTotals = null
      this.onState('disconnected')
      this.log('info', 'app', 'Отключено')
    }
  }

  // --- log file tailing (TUN mode has no stdio) ---------------------------

  private startLogTail(path: string, from = 0): void {
    this.stopLogTail()
    this.tailPath = path
    this.tailPos = from
    this.tailTimer = setInterval(() => void this.tailOnce(), 600)
  }
  private stopLogTail(): void {
    if (this.tailTimer) clearInterval(this.tailTimer)
    this.tailTimer = null
  }
  private async tailOnce(): Promise<void> {
    if (!this.tailPath) return
    try {
      const st = await stat(this.tailPath)
      if (st.size < this.tailPos) this.tailPos = 0 // a restarted core recreated the file
      if (st.size <= this.tailPos) return
      const fh = await open(this.tailPath, 'r')
      const len = Math.min(st.size - this.tailPos, 4 * 1024 * 1024)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, this.tailPos)
      await fh.close()
      this.tailPos += len
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const t = line.trim()
        if (t) this.coreLine(t)
      }
    } catch {
      /* log file not created yet */
    }
  }

  // --- traffic via the clash API (/connections totals -> speed) -----------

  private startTrafficPolling(): void {
    this.stopTrafficPolling()
    this.tick = 0
    this.trafficTimer = setInterval(() => void this.pollTraffic(), 1000)
  }
  private stopTrafficPolling(): void {
    if (this.trafficTimer) clearInterval(this.trafficTimer)
    this.trafficTimer = null
  }

  private setAuto(next: AutoInfo): void {
    const a = this.auto
    if (
      a.nodeId === next.nodeId &&
      a.delayMs === next.delayMs &&
      a.checking === next.checking &&
      a.dead === next.dead
    ) {
      return
    }
    this.auto = next
    this.onAuto(next)
  }

  /**
   * Right after connecting: «Лучший сервер (авто)» shows «проверяем…» until
   * the urltest group has checked its members (sing-box does that on start;
   * `now` only appears once the slowest member answered or timed out). Then:
   * the chosen node and its latency, every node's latency for the list.
   * «No server answers» only after TWO failed checks 5 s apart — one miss
   * right after a (TUN) start is not a verdict.
   */
  private async autoCheck(): Promise<void> {
    const api = this.api
    if (!api) return
    const gen = this.autoGen
    const alive = (): boolean => this.running && this.autoGen === gen && this.api === api
    this.setAuto({ checking: true, dead: false })

    const deadline = Date.now() + AUTO_FIRST_CHECK_MS
    let st = await api.proxyState(TAG_AUTO)
    while (alive() && !st?.now && Date.now() < deadline) {
      await sleep(400)
      st = await api.proxyState(TAG_AUTO)
    }
    let failures = 0
    while (alive()) {
      const all = await api.proxies()
      if (!alive()) return
      let anyAlive = false
      if (all) {
        const pings = this.nodeIds.map((id) => ({
          outboundId: id,
          latencyMs: all[id]?.delay ?? null
        }))
        anyAlive = pings.some((x) => x.latencyMs !== null)
        this.remember(pings)
        this.onPings(pings)
      }
      const dead = (!st?.now || st.delay === undefined) && !anyAlive
      if (!dead) {
        this.setAuto({
          nodeId: st?.now || undefined,
          delayMs: st?.delay ?? null,
          checking: false,
          dead: false
        })
        return
      }
      failures++
      if (failures >= 2) {
        this.setAuto({ nodeId: st?.now || undefined, delayMs: null, checking: false, dead: true })
        this.log(
          'warn',
          'app',
          'Ни один сервер не ответил на проверку — проверьте интернет или выберите сервер вручную'
        )
        return
      }
      this.log('info', 'app', 'Проверка серверов не дала ответа — повтор через 5 с')
      await sleep(AUTO_RETRY_MS)
      if (!alive()) return
      // a real check now (the startup one is over); it ends with its slowest member
      await api.groupDelay(TAG_AUTO, LATENCY_TIMEOUT_MS, AUTO_CHECK_WAIT_MS)
      if (!alive()) return
      st = await api.proxyState(TAG_AUTO)
    }
  }

  /** Periodic: follow the urltest group's choice (re-checked every 5 min by sing-box). */
  private async refreshAuto(): Promise<void> {
    if (this.auto.checking) return
    const api = this.clash
    if (!api) return
    const st = await api.proxyState(TAG_AUTO)
    if (!st || !this.running || this.auto.checking) return
    // a «dead» verdict is only lifted by a real answer, never set here
    if (!st.now || st.delay === undefined) return
    this.setAuto({ nodeId: st.now, delayMs: st.delay, checking: false, dead: false })
  }

  /**
   * The core's mode must be the chosen one (the app shows that one). A
   * difference is repaired and logged once — whatever caused it.
   */
  private async ensureMode(): Promise<void> {
    const api = this.clash
    if (!api) return
    const want = CLASH_MODE[this.wantedMode()]
    const now = await api.getMode().catch(() => null)
    if (now === null || now.toLowerCase() === want.toLowerCase()) return
    const ok = await api.setMode(want).catch(() => false)
    if (ok) await api.closeAll()
    const key = `${now}>${want}`
    if (ok) this.modeWarned = ''
    else if (this.modeWarned === key) return
    else this.modeWarned = key
    this.log(
      'warn',
      'app',
      ok
        ? `Режим ядра был ${now} вместо ${want} — исправлено`
        : `Ядро осталось в режиме ${now}, выбран ${want} — переподключитесь`
    )
  }

  private async pollTraffic(): Promise<void> {
    const api = this.clash
    if (!api) return
    ++this.tick
    this.logFilter.tick()
    if (this.tick % 60 === 0 && this.reality.prune()) this.publishHints()
    if (this.tick % 5 === 0) void this.refreshAuto()
    if (this.tick % MODE_CHECK_TICKS === 0 && !this.recovering) void this.ensureMode()
    // nothing may stay dead unnoticed (an exit that fell between two restarts)
    if (!this.recovering && !this.intentionalStop) {
      if (this.xrayPorts.length > 0 && !this.xray) return this.recover('Xray', null)
      if (!this.launcher && !this.child) return this.recover('sing-box', null)
    }
    // TUN: the broker reports a sing-box that died on its own
    if (
      this.launcher &&
      !this.recovering &&
      this.tick % 2 === 0 &&
      (await this.launcher.exited())
    ) {
      const exit = await this.launcher.exitInfo()
      if (this.running && !this.intentionalStop) this.recover('sing-box', exit?.code ?? null)
      return
    }
    const json = await api.connections()
    if (!json) return
    const down = json.downloadTotal ?? 0
    const up = json.uploadTotal ?? 0
    if (this.prevTotals) {
      this.totals = {
        uploadSpeed: Math.max(0, up - this.prevTotals.up),
        downloadSpeed: Math.max(0, down - this.prevTotals.down),
        totalUpload: up,
        totalDownload: down
      }
      this.onTraffic(this.totals)
    }
    this.prevTotals = { up, down }
  }
}
