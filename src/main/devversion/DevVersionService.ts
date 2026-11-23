import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname, networkInterfaces, userInfo } from 'node:os'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'
import {
  DEV_CONSENT_VERSION,
  DEV_STATUS_OFF,
  type DevAppRow,
  type DevGameCandidate,
  type DevGameTestView,
  type DevLastUpload,
  type DevNodeRow,
  type DevProbeRow,
  type DevStatsView,
  type DevStatus,
  type DevVersionConsent
} from '@shared/devversion'
import type { ConnectionState, FailedDirect, OutboundConfig } from '@shared/types'
import type { RawConnections } from '../core/connections'
import type { SocksTarget } from '../core/latency'
import { keepalivePing } from '../core/latency'
import type { ClashApi } from '../core/clashApi'
import { LATENCY_URL, TAG_DIRECT, TAG_PROXY_GROUP } from '../core/sbTypes'
import { TUN_ADDRESS4 } from '../core/configGen'
import { ConnAggregator, classifyLine, isKnownGame, toSample } from './aggregate'
import { DEFAULT_CONFIG, TelemetryError, type TelemetryApi, type TelemetryConfig } from './api'
import {
  compareDns,
  dohA,
  physicalSource,
  probeTarget,
  systemA,
  tcpCheck,
  type ProbePath
} from './probes'
import { DiskQueue } from './queue'
import {
  buildReport,
  fitReport,
  Period,
  sanitizeReport,
  sortedApps,
  tunnelSummary,
  type DnsProbe,
  type GameTestRecord,
  type TargetProbe
} from './report'
import { HeavyGate, runLimited, tuningFrom, type Tuning } from './scheduler'
import { summarize } from './stats'
import { findNetTools, liveSystem, runningNames, staticSystem, type StaticSystem } from './system'
import { BASE_TARGETS, gameTargets, type Target } from './targets'
import { gzipAsync, PAUSE_TEXT, Uploader } from './uploader'

// ---------------------------------------------------------------------------
// DevVersion (0.6.0): the collector + the uploader. Works only while the mode
// is on; everything here is isolated from the VPN — every entry point catches
// its own errors, nothing blocks the core manager, and a core that restarts or
// switches servers is simply waited for.
//
// Load (the owner keeps it on all the time, games included):
//  * connections — the snapshots SidecarManager polls anyway (1/s for the
//    traffic counters), every 3rd one (6th/10th with hundreds / thousands of
//    connections), folded in incrementally (aggregate.ts);
//  * the tunnel — one keepalive (two small GETs over one connection) through
//    the server in use every 60 s (flags.tunnel_probe_s), also during games;
//  * heavy probes (5 delays per server, TCP/TLS/HTTP of ~20 targets directly
//    and through the VPN, the DNS comparison) every 30 min ± 20 %, never while
//    a game / call is on, ≤ 2 at a time with pauses, cut short when one starts;
//  * disk: a checkpoint every 10 min and one report per upload interval, async;
//  * child processes (tasklist, route, reg) with BELOW_NORMAL priority, the
//    process list at most every 10 min. Every timer is unref'ed.
// ---------------------------------------------------------------------------

const TICK_MS = 30_000
const CHECKPOINT_MS = 10 * 60_000
const CONFIG_EVERY_MS = 24 * 3600_000
const CONFIG_RETRY_MS = 3600_000
const PROC_SCAN_MS = 12 * 60_000
const GAME_TEST_MS = 5 * 60_000
const KEEPALIVE_TIMEOUT_MS = 5000
const MANUAL_SEND_GAP_MS = 60_000
const HIDDEN_TTL_MS = 60_000

export interface ManagerView {
  readonly isRunning: boolean
  readonly proxyMode: 'system' | 'tun'
  readonly clash: ClashApi | null
  readonly directHosts: string[]
  socksFor(nodeId: string): SocksTarget | undefined
  activeNodeId(): Promise<string | null>
  readonly failures: { list(hidden: Set<string>, now?: number): FailedDirect[] }
}

export interface DevDeps {
  dir: string
  appVersion: string
  getConsent: () => DevVersionConsent | null
  setConsent: (c: DevVersionConsent | null) => void
  getLastUpload: () => DevLastUpload | null
  setLastUpload: (u: DevLastUpload | null) => void
  api: TelemetryApi
  /** host of the bot API (null = unparsable) */
  apiHost: () => string | null
  manager: ManagerView
  outbounds: () => OutboundConfig[]
  /** node hosts + their resolved IPs (lower case) — never reported */
  hidden: () => Set<string>
  mask: () => (text: string) => string
  /** «Системный прокси» / TUN as chosen in Settings */
  proxyMode: () => 'system' | 'tun'
  coreExe: string
  xrayExe: string
  log: (level: 'info' | 'warn', msg: string) => void
  /** the bot's host joins / leaves the core's direct rules */
  onDirectHostsChange: () => Promise<void>
}

interface GameTest {
  process: string
  startedAt: number
  endsAt: number
  phase: DevGameTestView['phase']
  text: string
  flows: Map<string, GameTestRecord['flows'][number]>
  live: Map<string, { up: number; down: number }>
}

const isoNow = (n: number): string => new Date(n).toISOString()

export class DevVersionService {
  private period = new Period()
  private queue: DiskQueue
  private uploader: Uploader
  private config: TelemetryConfig = DEFAULT_CONFIG
  private configAt = 0
  private configTriedAt = 0
  private timer: NodeJS.Timeout | null = null
  private active = false
  private snapCount = 0
  private gate = new HeavyGate(Date.now())
  private heavyRunning = false
  private heavyLastAt: number | null = null
  private nextUploadAt = 0
  private lastCheckpoint = 0
  private lastManualSend = 0
  private procScanAt = 0
  private knownGame: string | null = null
  private netTools: string[] = []
  private staticInfo: StaticSystem | null = null
  private hiddenCache: { at: number; set: Set<string> } | null = null
  private probeBytes = 0
  private clashDelays = 0
  private lastVpnState: ConnectionState | null = null
  private drops = 0
  private probeRows = new Map<string, DevProbeRow>()
  private nodeRows: DevNodeRow[] = []
  private game: GameTest | null = null
  private ticking = false
  private queueTotals = { reports: 0, bytes: 0 }
  private tuning: Tuning = tuningFrom({})
  private lastKeepaliveAt = 0

  constructor(private d: DevDeps) {
    this.queue = new DiskQueue(join(d.dir, 'queue'))
    this.uploader = new Uploader({
      api: d.api,
      queue: this.queue,
      maxBytes: () => this.config.maxReportBytes,
      log: (m) => d.log('info', m)
    })
    this.uploader.last = d.getLastUpload()
  }

  get enabled(): boolean {
    return this.d.getConsent()?.enabled === true
  }

  private get pendingPath(): string {
    return join(this.d.dir, 'pending.json.gz')
  }

  // --- lifecycle -------------------------------------------------------------

  /** At app start: resumes collecting if the mode is on. */
  init(): void {
    if (this.enabled) void this.start().catch((e) => this.warn('запуск', e))
  }

  private async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.period.clear()
    this.gate = new HeavyGate(Date.now(), this.tuning.heavyIntervalMs)
    this.nextUploadAt = Date.now() + this.config.uploadIntervalS * 1000
    this.lastCheckpoint = Date.now()
    await mkdir(this.queue.dir, { recursive: true })
    // a period the previous run had not sent yet becomes a queued report
    const pendName = `${String(Date.now() - 1).padStart(15, '0')}-pend.json.gz`
    await rename(this.pendingPath, join(this.queue.dir, pendName)).catch(() => undefined)
    await this.queue.enforce().catch(() => 0)
    this.queueTotals = await this.queue.totals()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
    void this.refreshConfig()
    void staticSystem(this.d.coreExe, this.d.xrayExe)
      .then((s) => (this.staticInfo = s))
      .catch(() => undefined)
    void this.tick()
  }

  private stop(): void {
    this.active = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.game = null
  }

  /** The consent dialog said yes: a new install id, collecting starts. */
  async enable(consentVersion: string): Promise<DevStatus> {
    if (consentVersion !== DEV_CONSENT_VERSION)
      throw new Error('Текст согласия устарел — откройте его заново')
    this.d.setConsent({
      enabled: true,
      consent_version: consentVersion,
      accepted_at: new Date().toISOString(),
      install_id: randomUUID()
    })
    this.uploader.reset()
    this.d.setLastUpload(null)
    await this.start()
    await this.d.onDirectHostsChange().catch(() => undefined)
    return this.status()
  }

  /** Off: collecting stops, local data is deleted; optionally the server's too. */
  async disable(deleteRemote: boolean): Promise<{ deleted?: number; deleteError?: string }> {
    const out: { deleted?: number; deleteError?: string } = {}
    if (deleteRemote) {
      try {
        out.deleted = await this.d.api.deleteAll()
      } catch (e) {
        out.deleteError = deleteErrorText(e)
      }
    }
    this.stop()
    this.period.clear()
    this.probeRows.clear()
    this.nodeRows = []
    this.uploader.reset()
    await this.queue.clear().catch(() => undefined)
    await rm(this.pendingPath, { force: true }).catch(() => undefined)
    this.queueTotals = { reports: 0, bytes: 0 }
    this.d.setConsent(null)
    this.d.setLastUpload(null)
    await this.d.onDirectHostsChange().catch(() => undefined)
    return out
  }

  async deleteRemote(): Promise<number> {
    try {
      return await this.d.api.deleteAll()
    } catch (e) {
      throw new Error(deleteErrorText(e))
    }
  }

  // --- hooks from the core manager (hot paths: cheap, never throw) ----------

  onConnections(raw: RawConnections): void {
    if (!this.active) return
    const n = raw.connections?.length ?? 0
    if (++this.snapCount % ConnAggregator.strideFor(n) !== 0) return
    try {
      const now = Date.now()
      const outbounds = this.d.outbounds()
      const hidden = this.hidden(now)
      this.period.conns.ingest(raw, outbounds, hidden, now)
      if (this.game?.phase === 'recording') this.recordGame(raw, outbounds, hidden)
    } catch (e) {
      this.warn('соединения', e)
    }
  }

  onCoreLine(source: 'singbox' | 'xray', line: string, nodeId?: string): void {
    if (!this.active) return
    try {
      const c = classifyLine(line)
      if (!c) return
      const names = this.names()
      const tag = source === 'xray' ? (nodeId ?? '') : c.outboundTag
      const outbound = !tag
        ? ''
        : tag === TAG_DIRECT
          ? 'direct'
          : (names.get(tag) ?? (tag.startsWith('cw-') ? 'rule' : tag))
      const kind =
        outbound === 'direct' && ['timeout', 'reset', 'refused', 'eof'].includes(c.kind)
          ? `direct_${c.kind}`
          : c.kind
      this.period.events.note(kind, outbound, c.target, Date.now())
    } catch {
      /* ignore */
    }
  }

  onVpnStatus(state: ConnectionState): void {
    if (!this.active || state === this.lastVpnState) return
    try {
      if (this.lastVpnState === 'connected' && (state === 'error' || state === 'connecting'))
        this.drops++
      this.lastVpnState = state
      this.period.addVpnState(state, Date.now())
    } catch {
      /* ignore */
    }
  }

  private names(): Map<string, string> {
    return new Map(this.d.outbounds().map((o) => [o.id, o.name]))
  }

  private hidden(now: number): Set<string> {
    if (!this.hiddenCache || now - this.hiddenCache.at > HIDDEN_TTL_MS) {
      this.hiddenCache = { at: now, set: this.d.hidden() }
    }
    return this.hiddenCache.set
  }

  // --- the 30 s tick ----------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.active || this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      if (now - this.lastKeepaliveAt >= this.tuning.tunnelProbeMs - 1000) {
        this.lastKeepaliveAt = now
        await this.keepalive().catch((e) => this.warn('замер туннеля', e))
      }
      if (now - this.procScanAt > PROC_SCAN_MS) await this.scanProcesses()
      if (this.configDue(now)) await this.refreshConfig()
      await this.gameTestTick(now).catch((e) => this.warn('тест игры', e))
      const verdict = this.gate.check(now, this.busy(now))
      if (verdict === 'run' && this.heavyEnabled()) void this.heavy()
      if (now >= this.nextUploadAt) await this.finishPeriod()
      else if (now - this.lastCheckpoint >= CHECKPOINT_MS) await this.checkpoint()
      if (this.queueTotals.reports > 0 && this.directReady()) {
        await this.uploader.run().catch((e) => this.warn('отправка', e))
        this.queueTotals = await this.queue.totals()
        this.d.setLastUpload(this.uploader.last)
      }
    } catch (e) {
      this.warn('сборщик', e)
    } finally {
      this.ticking = false
    }
  }

  /** a game / call now: the program (connections, or a known game running) */
  private busy(now: number): string | null {
    return this.period.conns.realtime(now) ?? this.knownGame
  }

  private heavyEnabled(): boolean {
    return this.tuning.heavyProbes
  }

  private configDue(now: number): boolean {
    if (this.configAt && now - this.configAt < CONFIG_EVERY_MS) return false
    return now - this.configTriedAt >= CONFIG_RETRY_MS
  }

  private async refreshConfig(): Promise<void> {
    this.configTriedAt = Date.now()
    try {
      const c = await this.d.api.config()
      this.config = c
      this.configAt = Date.now()
      this.tuning = tuningFrom(c.flags)
      this.gate.setInterval(this.tuning.heavyIntervalMs)
      const consent = this.d.getConsent()
      if (!c.enabled)
        this.uploader.paused =
          c.reason === 'trial_not_allowed'
            ? 'trial'
            : c.reason === 'not_allowed'
              ? 'not_allowed'
              : 'server_off'
      else if (c.consentVersion && consent && c.consentVersion !== consent.consent_version)
        this.uploader.paused = 'consent'
      // collection is on for us again: the next run tries (a pause lasts ≤ a day)
      else if (this.uploader.paused) this.uploader.paused = null
    } catch (e) {
      if (e instanceof TelemetryError) {
        if (e.kind === 'disabled') this.uploader.paused = 'server_off'
        else if (
          e.kind === 'not_found' ||
          e.kind === 'inactive' ||
          e.kind === 'trial' ||
          e.kind === 'not_allowed' ||
          e.kind === 'nosub' ||
          e.kind === 'auth'
        )
          this.uploader.paused = e.kind
      }
    }
  }

  private async scanProcesses(): Promise<void> {
    this.procScanAt = Date.now()
    const names = await runningNames().catch(() => [] as string[])
    this.netTools = findNetTools(names)
    this.knownGame = names.find((n) => isKnownGame(n))?.toLowerCase() ?? null
  }

  /**
   * Uploads leave directly: «Системный прокси» / VPN off — always (Node's fetch
   * ignores the WinInet proxy); TUN — once the running core has the bot's host
   * in its direct rules (after the reconnect that follows enabling).
   */
  private directReady(): boolean {
    const m = this.d.manager
    if (!m.isRunning || m.proxyMode !== 'tun') return true
    const host = this.d.apiHost()
    return !!host && m.directHosts.map((h) => h.toLowerCase()).includes(host)
  }

  // --- tunnel keepalive (light, also during games) ---------------------------

  private async keepalive(): Promise<void> {
    const m = this.d.manager
    const api = m.clash
    if (!m.isRunning || !api) return
    const nodeId = await m.activeNodeId()
    const o = nodeId ? this.d.outbounds().find((x) => x.id === nodeId) : undefined
    const node = o?.name ?? null
    const socks = nodeId ? m.socksFor(nodeId) : undefined
    let ms: number | null = null
    let method = 'keepalive'
    if (socks) {
      try {
        ms = (await keepalivePing(socks, LATENCY_URL, KEEPALIVE_TIMEOUT_MS)).secondMs
      } catch {
        ms = null
      }
    } else {
      method = 'clash_delay'
      ms = await api.delay(TAG_PROXY_GROUP, KEEPALIVE_TIMEOUT_MS)
    }
    if (!this.active || !m.isRunning) return
    this.period.addTunnel({ t: Date.now(), ms, node, protocol: o?.protocol ?? null, method })
  }

  // --- heavy probes -----------------------------------------------------------

  private async directPath(): Promise<ProbePath | { skipped: string }> {
    const m = this.d.manager
    if (!m.isRunning || m.proxyMode !== 'tun') return { path: 'direct', method: 'plain' }
    const src = await physicalSource([TUN_ADDRESS4])
    if (!src) return { skipped: 'no_physical_route' }
    const v = await this.verifyBypass(src)
    if (v === 'failed') return { skipped: 'tun_bypass_failed' }
    return {
      path: 'direct',
      method: v === 'verified' ? 'src_bind' : 'src_bind_unverified',
      localAddress: src
    }
  }

  /**
   * TUN: a canary connection bound to the physical address must NOT show up in
   * the core's connection list — otherwise the binding didn't take it past the
   * TUN and the «direct» numbers would be lies. The canary not connecting at
   * all says nothing either way («unverified»).
   */
  private async verifyBypass(localAddress: string): Promise<'verified' | 'unverified' | 'failed'> {
    const api = this.d.manager.clash
    if (!api) return 'unverified'
    const sock = netConnect({ host: '1.1.1.1', port: 443, localAddress })
    try {
      const up = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 4000)
        sock.once('connect', () => {
          clearTimeout(t)
          resolve(true)
        })
        sock.once('error', () => {
          clearTimeout(t)
          resolve(false)
        })
      })
      if (!up) return 'unverified'
      // the core lists a connection within its 1 s poll
      await new Promise((r) => setTimeout(r, 1500).unref())
      const port = String(sock.localPort ?? '')
      const raw = await api.connections()
      if (!raw) return 'unverified'
      const seen = (raw.connections ?? []).some(
        (c) =>
          c.metadata?.destinationIP === '1.1.1.1' &&
          c.metadata?.destinationPort === '443' &&
          c.metadata?.sourcePort === port
      )
      return seen ? 'failed' : 'verified'
    } finally {
      sock.destroy()
    }
  }

  private async vpnPath(): Promise<ProbePath | { skipped: string }> {
    const m = this.d.manager
    if (!m.isRunning) return { skipped: 'vpn_off' }
    const nodeId = await m.activeNodeId()
    if (!nodeId) return { skipped: 'server_unknown' }
    const socks = m.socksFor(nodeId)
    const o = this.d.outbounds().find((x) => x.id === nodeId)
    if (!socks) return { skipped: 'no_socks_entry' }
    return {
      path: 'vpn',
      method: 'socks:xray',
      socks,
      node: o?.name ?? 'сервер',
      protocol: o?.protocol
    }
  }

  private async heavy(): Promise<void> {
    if (this.heavyRunning || !this.active) return
    this.heavyRunning = true
    const started = Date.now()
    let stopped = false
    try {
      if (Date.now() - this.procScanAt > PROC_SCAN_MS / 2) await this.scanProcesses()
      if (this.busy(Date.now())) {
        this.gate.interrupted(Date.now())
        return
      }
      const direct = await this.directPath()
      const vpn = await this.vpnPath()
      const tunRunning = this.d.manager.isRunning && this.d.manager.proxyMode === 'tun'
      const have = new Set(BASE_TARGETS.map((t) => t.host))
      const targets: Target[] = [
        ...BASE_TARGETS,
        ...gameTargets(this.period.conns.procs.values(), have)
      ]
      const tasks: (() => Promise<void>)[] = []
      const t = (): string => isoNow(Date.now())

      // what can't be checked honestly is recorded once, not as failed probes
      if ('skipped' in direct) this.period.addSkip('direct', direct.skipped)
      if ('skipped' in vpn) this.period.addSkip('vpn', vpn.skipped)
      for (const tg of targets) {
        for (const p of [direct, vpn]) {
          if ('skipped' in p) continue
          tasks.push(async () => {
            const r = await probeTarget(p, tg.host, tg.port, { tls: tg.tls, http: tg.tls })
            this.probeBytes += r.bytes
            const ok = r.tcp_ms !== null && (!tg.tls || typeof r.tls_ms === 'number')
            const rec: TargetProbe = {
              type: 'target',
              t: t(),
              target: tg.host,
              group: tg.target,
              port: tg.port,
              route: p.path,
              ok,
              latency_ms: r.tcp_ms,
              loss_pct: ok ? 0 : 100,
              failures: ok ? 0 : 1,
              method: p.method,
              ...(p.node ? { node: p.node } : {}),
              ...(p.protocol ? { protocol: p.protocol } : {}),
              ...(tg.app ? { app: tg.app } : {}),
              ...(r.dns_ms !== undefined ? { dns_ms: r.dns_ms } : {}),
              ...(r.tls_ms !== undefined ? { tls_ms: r.tls_ms } : {}),
              ...(r.tls_error ? { tls_error: r.tls_error } : {}),
              ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
              ...(r.error ? { error: r.error } : {})
            }
            this.period.addProbe(rec)
          })
        }
      }
      // DNS: in TUN the system resolver is answered by our core — no honest comparison
      if (tunRunning) {
        this.period.addSkip('dns', 'tun_dns_hijacked')
      } else {
        for (const tg of targets.filter((x) => x.dns)) {
          tasks.push(async () => {
            const rec: DnsProbe = {
              type: 'dns',
              t: t(),
              target: tg.host,
              route: 'direct',
              ok: true,
              failures: 0,
              method: 'os_vs_doh_1.1.1.1',
              system: [],
              doh: []
            }
            try {
              const [sys, doh] = await Promise.allSettled([systemA(tg.host), dohA(tg.host)])
              rec.system = sys.status === 'fulfilled' ? sys.value : []
              rec.doh = doh.status === 'fulfilled' ? doh.value : []
              if (doh.status === 'rejected') rec.error = 'doh_failed'
              Object.assign(rec, compareDns(rec.system, rec.doh))
            } catch {
              rec.error = 'failed'
            }
            rec.ok = !rec.mismatch && !rec.bogon
            rec.failures = rec.ok ? 0 : 1
            this.probeBytes += 1500
            this.period.addProbe(rec)
          })
        }
      }
      // every server: N delays through the running core (no switching), + TCP straight to it
      const api = this.d.manager.clash
      const samples = this.tuning.nodeSamples
      for (const o of this.d.outbounds()) {
        if (api) {
          for (let i = 0; i < samples; i++) {
            tasks.push(async () => {
              const live = this.d.manager.clash
              if (!live) return
              this.clashDelays++
              this.period.addNodeDelay(o.name, o.protocol, await live.delay(o.id, 5000))
            })
          }
        }
        if (o.protocol === 'hysteria2') {
          this.period.addNodeTcp(o.name, o.protocol, null, 'udp_protocol')
        } else if ('skipped' in direct) {
          this.period.addNodeTcp(o.name, o.protocol, null, direct.skipped)
        } else {
          const p = direct
          tasks.push(async () => {
            const r = await tcpCheck(p, o.server, o.port, 5000)
            this.probeBytes += 200
            this.period.addNodeTcp(o.name, o.protocol, r.ms)
          })
        }
      }
      const res = await runLimited(tasks, {
        concurrency: 2,
        gapMs: 300,
        shouldStop: () => !this.active || this.busy(Date.now()) !== null
      })
      stopped = res.stopped
      this.refreshRows()
    } catch (e) {
      this.warn('пробы', e)
    } finally {
      this.heavyRunning = false
      this.heavyLastAt = started
      if (stopped && this.active) this.gate.interrupted(Date.now())
      else this.gate.done(Date.now())
    }
  }

  private refreshRows(): void {
    for (const p of this.period.probes) {
      if (p.type !== 'target') continue
      const row = this.probeRows.get(p.target) ?? {
        target: p.target,
        direct: '—',
        vpn: '—',
        dns: null
      }
      const text = [
        p.latency_ms !== null ? `TCP ${p.latency_ms} мс` : `TCP: ${p.error ?? 'нет'}`,
        p.tls_ms ? `TLS ${p.tls_ms} мс` : p.tls_error ? `TLS: ${p.tls_error}` : '',
        p.http_status ? `HTTP ${p.http_status}` : ''
      ]
        .filter(Boolean)
        .join(' · ')
      if (p.route === 'direct') row.direct = text
      else row.vpn = p.node ? `${text} (${p.node})` : text
      this.probeRows.set(p.target, row)
    }
    for (const [what, why] of this.period.skips) {
      if (what === 'dns') continue
      for (const row of this.probeRows.values()) {
        if (what === 'direct') row.direct = `пропущено (${why})`
        if (what === 'vpn') row.vpn = `пропущено (${why})`
      }
    }
    for (const p of this.period.probes) {
      if (p.type !== 'dns') continue
      const row = this.probeRows.get(p.target)
      if (!row) continue
      row.dns = p.bogon
        ? 'подмена: локальный адрес'
        : p.mismatch
          ? 'адреса расходятся'
          : p.error
            ? 'DoH недоступен'
            : 'совпадает'
    }
    this.nodeRows = [...this.period.nodes.entries()].map(([node, n]) => {
      const s = summarize(n.delays)
      const tcp = summarize(n.tcp)
      return {
        node,
        samples: s.samples,
        p50: s.p50_ms,
        p95: s.p95_ms,
        jitter: s.jitter_ms,
        lossPct: s.loss_pct,
        tcpDirectMs: tcp.p50_ms
      }
    })
  }

  // --- «Тест игры» --------------------------------------------------------------

  async gameCandidates(): Promise<DevGameCandidate[]> {
    const seen = new Set(this.period.conns.procs.keys())
    const running = await runningNames().catch(() => [] as string[])
    const out = new Map<string, DevGameCandidate>()
    for (const n of seen) out.set(n, { name: n, seen: true })
    for (const n of running) {
      const k = n.toLowerCase()
      if (!out.has(k) && /\.exe$/.test(k)) out.set(k, { name: k, seen: false })
    }
    return [...out.values()].sort(
      (a, b) => Number(b.seen) - Number(a.seen) || a.name.localeCompare(b.name)
    )
  }

  gameStart(process: string): DevStatsView {
    if (!this.active) throw new Error('DevVersion выключен')
    if (this.game && (this.game.phase === 'recording' || this.game.phase === 'probing')) {
      throw new Error('Тест игры уже идёт')
    }
    const now = Date.now()
    this.game = {
      process: process.toLowerCase(),
      startedAt: now,
      endsAt: now + GAME_TEST_MS,
      phase: 'recording',
      text: 'Записываем, куда подключается игра — играйте как обычно',
      flows: new Map(),
      live: new Map()
    }
    return this.stats()
  }

  gameStop(): DevStatsView {
    if (this.game?.phase === 'recording') this.game.endsAt = Date.now()
    void this.gameTestTick(Date.now())
    return this.stats()
  }

  private recordGame(raw: RawConnections, outbounds: OutboundConfig[], hidden: Set<string>): void {
    const g = this.game
    if (!g) return
    const names = new Map(outbounds.map((o) => [o.id, o.name]))
    for (const c of raw.connections ?? []) {
      const s = toSample(c, names, hidden)
      if (!s || s.proc !== g.process) continue
      const key = `${s.domain || s.ip}|${s.port}|${s.net}`
      let f = g.flows.get(key)
      if (!f) {
        if (g.flows.size >= 300) continue
        f = {
          host: s.domain,
          ip: s.ip,
          port: s.port,
          net: s.net,
          via: s.via,
          up: 0,
          down: 0,
          conns: 0
        }
        g.flows.set(key, f)
      }
      const prev = g.live.get(s.id)
      if (!prev) f.conns++
      f.up += Math.max(0, s.up - (prev?.up ?? 0))
      f.down += Math.max(0, s.down - (prev?.down ?? 0))
      f.via = s.via
      g.live.set(s.id, { up: s.up, down: s.down })
    }
  }

  private async gameTestTick(now: number): Promise<void> {
    const g = this.game
    if (!g || g.phase !== 'recording' || now < g.endsAt) return
    g.phase = 'probing'
    g.text = 'Проверяем адреса игры напрямую и через VPN — по одному'
    const flows = [...g.flows.values()].sort((a, b) => b.up + b.down - (a.up + a.down))
    const direct = await this.directPath()
    const vpn = await this.vpnPath()
    const seenEp = new Set<string>()
    const checks: GameTestRecord['checks'] = []
    const tasks: (() => Promise<void>)[] = []
    for (const f of flows) {
      const host = f.ip || f.host
      const ep = `${host}|${f.port}|${f.net}`
      if (seenEp.has(ep) || checks.length >= 20) continue
      seenEp.add(ep)
      if (f.net === 'udp') {
        checks.push({
          host,
          port: f.port,
          net: 'udp',
          direct: null,
          vpn: null,
          skipped: 'udp_no_generic_probe'
        })
        continue
      }
      const check: GameTestRecord['checks'][number] = {
        host,
        port: f.port,
        net: 'tcp',
        direct: null,
        vpn: null
      }
      checks.push(check)
      tasks.push(async () => {
        if (!('skipped' in direct)) check.direct = await tcpCheck(direct, host, f.port, 4000)
        if (!('skipped' in vpn)) check.vpn = await tcpCheck(vpn, host, f.port, 4000)
        this.probeBytes += 400
      })
    }
    await runLimited(tasks, { concurrency: 1, gapMs: 500, shouldStop: () => !this.active })
    const mode = this.d.manager.isRunning
      ? this.d.manager.proxyMode === 'tun'
        ? 'tun'
        : 'proxy'
      : 'off'
    const rec: GameTestRecord = {
      started_at: isoNow(g.startedAt),
      duration_s: Math.round((g.endsAt - g.startedAt) / 1000),
      process: g.process,
      mode,
      ...(!('skipped' in vpn) && vpn.node ? { node: vpn.node, protocol: vpn.protocol } : {}),
      flows,
      checks,
      ...('skipped' in direct ? { note: `direct: ${direct.skipped}` } : {}),
      ...(flows.length === 0
        ? {
            note:
              mode === 'proxy'
                ? 'no_flows: в режиме «Системный прокси» игры обычно идут мимо ядра — включите TUN'
                : 'no_flows'
          }
        : {})
    }
    if (!this.active || this.game !== g) return
    this.period.addGameTest(rec)
    g.phase = 'done'
    const ok = checks.filter((c) => c.direct?.ok || c.vpn?.ok).length
    g.text =
      flows.length === 0
        ? (rec.note ?? 'Соединений игры не видно')
        : `Готово: направлений ${flows.length}, проверено ${checks.length} (ответили ${ok}). Результат войдёт в ближайший отчёт.`
  }

  // --- reports -------------------------------------------------------------------

  private async systemSection(): Promise<Record<string, unknown>> {
    const live = await liveSystem().catch(() => ({ ipv6: true, teredo: 'unknown' }))
    const m = this.d.manager
    return {
      windows_display: this.staticInfo?.windows_display ?? '',
      core_version: this.staticInfo?.core_version ?? '',
      xray_version: this.staticInfo?.xray_version ?? '',
      ...live,
      vpn_running: m.isRunning,
      proxy_mode_setting: this.d.proxyMode(),
      other_net_tools: this.netTools,
      known_game_running: this.knownGame,
      probe_traffic: { bytes_measured: this.probeBytes, clash_delays: this.clashDelays },
      direct_failures: m.failures.list(this.hidden(Date.now())).map((f) => ({
        host: f.host,
        port: f.port,
        count: f.count,
        last: isoNow(f.last),
        ...(f.process ? { process: f.process } : {}),
        ...(f.telegram ? { telegram: true } : {})
      }))
    }
  }

  /** The current period as a report: sanitized and within the size limit. */
  async currentReport(now = Date.now()): Promise<Record<string, unknown> | null> {
    const consent = this.d.getConsent()
    if (!consent) return null
    const user = (() => {
      try {
        return userInfo().username
      } catch {
        return ''
      }
    })()
    const raw = buildReport(this.period, {
      consentVersion: consent.consent_version,
      installId: consent.install_id,
      appVersion: this.d.appVersion,
      os: this.staticInfo?.os ?? { build: '', edition: '' },
      mode:
        (this.d.manager.isRunning ? this.d.manager.proxyMode : this.d.proxyMode()) === 'tun'
          ? 'tun'
          : 'proxy',
      system: await this.systemSection(),
      directFailures: this.d.manager.failures.list(this.hidden(Date.now())),
      drops: this.drops,
      now
    })
    const clean = sanitizeReport(raw, {
      mask: this.d.mask(),
      personal: [user, hostname()],
      ownIps: ownAddresses()
    })
    return fitReport(clean, this.config.maxReportBytes)
  }

  private hasData(): boolean {
    return (
      this.period.conns.procs.size > 0 ||
      this.period.probeCount > 0 ||
      this.period.events.entries.size > 0
    )
  }

  /** The period becomes a queued report; a new period starts. */
  private async finishPeriod(): Promise<void> {
    const now = Date.now()
    this.nextUploadAt = now + this.config.uploadIntervalS * 1000
    if (!this.hasData()) return
    const report = await this.currentReport(now)
    this.period.reset(now)
    this.probeBytes = 0
    this.clashDelays = 0
    this.drops = 0
    if (!report) return
    await this.queue.push(await gzipAsync(Buffer.from(JSON.stringify(report), 'utf8')), now)
    await rm(this.pendingPath, { force: true }).catch(() => undefined)
    this.queueTotals = await this.queue.totals()
  }

  /** Every 10 min: the period so far on disk (survives a restart / crash). */
  private async checkpoint(): Promise<void> {
    this.lastCheckpoint = Date.now()
    if (!this.hasData()) return
    const report = await this.currentReport()
    if (!report) return
    await mkdir(this.d.dir, { recursive: true })
    await writeFile(this.pendingPath, await gzipAsync(Buffer.from(JSON.stringify(report), 'utf8')))
  }

  /** «Отправить сейчас»: the period so far goes out now. */
  async sendNow(): Promise<DevStatus> {
    if (!this.active) throw new Error('DevVersion выключен')
    const now = Date.now()
    if (now - this.lastManualSend < MANUAL_SEND_GAP_MS) throw new Error('Не чаще раза в минуту')
    this.lastManualSend = now
    await this.refreshConfig()
    await this.finishPeriod()
    if (!this.directReady()) {
      throw new Error(
        'Отчёт сохранён. Отправка ждёт переподключения VPN — чтобы она шла напрямую, мимо VPN.'
      )
    }
    if (this.uploader.paused === 'server_off' || this.uploader.paused === 'consent') {
      throw new Error(PAUSE_TEXT[this.uploader.paused])
    }
    await this.uploader.run(true)
    this.queueTotals = await this.queue.totals()
    this.d.setLastUpload(this.uploader.last)
    return this.status()
  }

  /** «Сохранить отчёт в файл»: what would be sent (sanitized), pretty JSON. */
  async reportText(): Promise<string> {
    const r = await this.currentReport()
    if (!r) throw new Error('DevVersion выключен')
    return JSON.stringify(r, null, 2)
  }

  // --- views -------------------------------------------------------------------

  status(): DevStatus {
    const consent = this.d.getConsent()
    if (!consent?.enabled) return { ...DEV_STATUS_OFF }
    const now = Date.now()
    const busy = this.active ? this.busy(now) : null
    const paused = this.uploader.paused
    let bytes = 0
    for (const p of this.period.conns.procs.values()) bytes += p.up + p.down
    return {
      enabled: true,
      acceptedAt: consent.accepted_at,
      collecting: this.active,
      vpnRunning: this.d.manager.isRunning,
      paused: paused ? PAUSE_TEXT[paused] : null,
      waitingDirect: this.queueTotals.reports > 0 && !this.directReady(),
      lastUpload: this.uploader.last,
      nextUploadAt: this.active ? this.nextUploadAt : null,
      queue: { ...this.queueTotals },
      since: this.active ? this.period.from : null,
      accumulated: {
        processes: this.period.conns.procs.size,
        connections: this.period.conns.totalConns,
        bytes,
        events: this.period.events.total,
        probes: this.period.probeCount
      },
      game: { active: !!busy, process: busy },
      heavy: {
        running: this.heavyRunning,
        deferred: this.gate.deferred,
        lastAt: this.heavyLastAt,
        nextAt: this.active ? this.gate.nextAt : null
      }
    }
  }

  stats(): DevStatsView {
    const apps: DevAppRow[] = sortedApps(this.period.conns)
      .slice(0, 25)
      .map((p) => {
        let vpnBytes = 0
        for (const [via, v] of Object.entries(p.via))
          if (via.startsWith('vpn')) vpnBytes += v.up + v.down
        const direct = p.via.direct
        return {
          process: p.name,
          bytes: p.up + p.down,
          directBytes: direct ? direct.up + direct.down : 0,
          vpnBytes,
          conns: p.conns,
          noReply: p.noReply,
          topDomains: [...p.domains.entries()]
            .sort((a, b) => b[1].up + b[1].down - (a[1].up + a[1].down))
            .slice(0, 3)
            .map(([d]) => d)
        }
      })
    const t = tunnelSummary(this.period.tunnel)
    const mask = this.d.mask()
    const g = this.game
    return {
      status: this.status(),
      apps,
      nodes: this.nodeRows,
      tunnel: t
        ? {
            node: t.node,
            samples: t.samples,
            p50: t.latency_ms,
            p95: t.p95_ms,
            jitter: t.jitter_ms,
            lossPct: t.loss_pct,
            stalls: t.stalls,
            drops: this.drops
          }
        : null,
      events: [...this.period.events.recent]
        .reverse()
        .slice(0, 30)
        .map((e) => ({
          at: e.at,
          kind: e.kind,
          outbound: e.outbound,
          target: mask(e.target),
          count: 1
        })),
      probes: [...this.probeRows.values()],
      gameTest: g
        ? {
            process: g.process,
            phase: g.phase,
            startedAt: g.startedAt,
            endsAt: g.endsAt,
            flows: g.flows.size,
            text: g.text
          }
        : null
    }
  }

  private warn(where: string, e: unknown): void {
    this.d.log('warn', `DevVersion (${where}): ${e instanceof Error ? e.message : String(e)}`)
  }

  /** tests / shutdown */
  async shutdown(): Promise<void> {
    if (!this.active) return
    await this.checkpoint().catch(() => undefined)
    this.stop()
  }

  /** for tests */
  get _period(): Period {
    return this.period
  }

  /** for tests: run the heavy probes now (the gate decides as usual) */
  async _tick(): Promise<void> {
    await this.tick()
  }

  /** read a file of the queue (tests) */
  async _readPending(): Promise<Buffer | null> {
    return readFile(this.pendingPath).catch(() => null)
  }
}

/** this PC's own addresses (a public one too, with PPPoE / a white IP on the NIC) */
function ownAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal) out.push(a.address.split('%')[0])
  }
  return out
}

function deleteErrorText(e: unknown): string {
  if (e instanceof TelemetryError) {
    if (e.kind === 'network')
      return 'Нет связи с сервером CipherWay — удалить отправленные данные не удалось.'
    if (e.kind === 'nosub') return 'Нет подписки — удалите данные через поддержку.'
    if (e.kind === 'inactive') return 'Подписка не активна — удалите данные через поддержку.'
    if (e.kind === 'not_found')
      return 'Сервер CipherWay пока не умеет удалять отчёты — напишите в поддержку.'
    return `Сервер CipherWay ответил ошибкой${e.status ? ` (${e.status})` : ''} — данные не удалены.`
  }
  return 'Не удалось удалить отправленные данные.'
}
