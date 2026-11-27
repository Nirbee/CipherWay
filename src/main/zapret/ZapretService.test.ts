import { describe, expect, it, vi } from 'vitest'
import type { RoutingRule } from '@shared/types'
import { DEFAULT_ZAPRET, type ZapretSettings, type ZapretView } from '@shared/zapret'
import { NO_ZAPRET, type ZapretRouting } from '../rules/compile'
import type { CheckTarget } from './lists'
import type { DirectPath, DohServer, NetworkInfo, TargetResult } from './checks'
import { DpiStartError, type DpiDaemonLike, type DpiRequest } from './DpiDaemon'
import type { DpiBrokerState } from './dpiBroker'
import { STRATEGIES } from './strategies'
import {
  DNS_FAILS,
  dpiErrorText,
  LIVE_QUIET_MS,
  LIVE_RECHECK_MS,
  LIVE_REPEAT_MS,
  LIVE_STALL_MS,
  LIVE_STALLS,
  ZapretService,
  type StrategyMemo,
  type ZapretDeps
} from './ZapretService'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const [S0, S1, S2, S3] = STRATEGIES.map((s) => s.id)

/** which hosts open directly with which strategy (null = winws off); 'noaddr' = no address */
type World = (strategy: string | null, host: string, quic?: boolean) => boolean | 'noaddr'

function harness(o: {
  world: World
  settings?: Partial<ZapretSettings>
  memory?: Record<string, StrategyMemo>
  foreign?: string | null
  service?: 'ok' | 'missing'
  install?: 'ok' | 'cancelled' | 'failed'
  net?: NetworkInfo | null
  doh?: DohServer | null
  checkEveryMs?: number
  netPollMs?: number
  applyError?: DpiStartError
  /** YouTube's video nodes the check finds (undefined = no video check) */
  videoNodes?: string[]
  /** the clock (live fallback tests) */
  now?: () => number
  /** the user's rules (their «Напрямую + zapret» ones) */
  rules?: RoutingRule[]
  /** our servers' addresses (default: one) */
  excludeIps?: () => Promise<string[]>
  /** a failure is checked once more after this long (default 0) */
  confirmMs?: number
  /** checkTarget: answer after this long, honouring the abort signal */
  targetDelayMs?: number
  /** the programs' addresses (0.7.4) */
  learnGapMs?: number
  learnBatchMs?: number
}) {
  let rulesChanged = 0
  let settings: ZapretSettings = { ...DEFAULT_ZAPRET, enabled: true, warned: true, ...o.settings }
  let memory: Record<string, StrategyMemo> = { ...(o.memory ?? {}) }
  let strategy: string | null = null
  let running = false
  let net = o.net === undefined ? { id: 'net-home', source: '192.168.1.5' } : o.net
  const applied: string[] = []
  const routes: ZapretRouting[] = []
  const views: ZapretView[] = []
  const logs: string[] = []
  const checked: { host: string; path: DirectPath }[] = []
  let inFlight = 0
  let maxInFlight = 0
  const daemon: DpiDaemonLike & { stops: number; requests: DpiRequest[] } = {
    stops: 0,
    requests: [],
    async start(req) {
      return this.apply(req)
    },
    async apply(req) {
      if (o.applyError) throw o.applyError
      this.requests.push(req)
      strategy = req.strategy
      applied.push(req.strategy)
      return {
        status: 'running',
        gen: applied.length,
        strategy: req.strategy,
        dpiPid: 100 + applied.length,
        wfExcl: req.exclude.length
      } as DpiBrokerState
    },
    async stop() {
      strategy = null
      this.stops++
    },
    async running() {
      return null
    },
    async cleanup() {}
  }
  const install = vi.fn(async () => o.install ?? 'ok')
  const deps: ZapretDeps = {
    available: true,
    getSettings: () => settings,
    setSettings: (s) => (settings = s),
    getMemory: () => memory,
    setMemory: (m) => (memory = m),
    vpn: () => ({ running, tun: true }),
    service: {
      status: async () => ({ state: o.service ?? 'ok', dpi: (o.service ?? 'ok') === 'ok' }),
      install
    },
    daemon: async () => daemon,
    network: async () => net,
    pickDoh: async () => (o.doh === undefined ? 'primary' : o.doh),
    checkTarget: async (t: CheckTarget, _doh, path, _ms, signal): Promise<TargetResult> => {
      checked.push({ host: t.host, path })
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        if (o.targetDelayMs) {
          const aborted = await new Promise<boolean>((res) => {
            const tm = setTimeout(() => res(false), o.targetDelayMs)
            signal?.addEventListener('abort', () => {
              clearTimeout(tm)
              res(true)
            })
          })
          if (aborted) return { host: t.host, ok: false, error: 'aborted' }
        }
      } finally {
        inFlight--
      }
      const w = o.world(strategy, t.host, t.quic)
      if (w === 'noaddr') return { host: t.host, ok: false, error: 'noaddr' }
      return w ? { host: t.host, ok: true, ms: 10 } : { host: t.host, ok: false, error: 'timeout' }
    },
    excludeIps: o.excludeIps ?? (async () => ['203.0.113.7/32']),
    hasServers: () => true,
    reserved: () => ['sub.example.net'],
    applyRouting: async (r) => {
      routes.push(r)
    },
    foreignDpi: async () => o.foreign ?? null,
    publish: (v) => views.push(v),
    log: (_l, m) => logs.push(m),
    settleMs: 0,
    confirmMs: o.confirmMs ?? 0,
    connections: () => checked.length,
    checkEveryMs: o.checkEveryMs ?? 3_600_000,
    netPollMs: o.netPollMs ?? 3_600_000,
    ...(o.videoNodes ? { videoNodes: async () => o.videoNodes ?? [] } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.learnGapMs !== undefined ? { learnGapMs: o.learnGapMs } : {}),
    ...(o.learnBatchMs !== undefined ? { learnBatchMs: o.learnBatchMs } : {}),
    ...(o.rules ? { rules: () => o.rules ?? [], rulesChanged: () => rulesChanged++ } : {})
  }
  const svc = new ZapretService(deps)
  return {
    svc,
    daemon,
    install,
    applied,
    routes,
    views,
    logs,
    checked,
    get settings() {
      return settings
    },
    get memory() {
      return memory
    },
    setRunning: (v: boolean) => (running = v),
    get rulesChanged() {
      return rulesChanged
    },
    setNet: (n: NetworkInfo | null) => (net = n),
    /** the most checkTarget calls running at the same time; reset with `true` */
    maxParallel: (reset = false): number => {
      const m = maxInFlight
      if (reset) maxInFlight = 0
      return m
    },
    get inFlight() {
      return inFlight
    },
    lastRoute: () => routes[routes.length - 1],
    /** until the work queued so far is done */
    async idle(): Promise<ZapretView> {
      for (let i = 0; i < 200; i++) {
        await sleep(5)
        const v = svc.view()
        if ((v.phase === 'running' || v.phase === 'error') && !v.checking) return v
      }
      return svc.view()
    }
  }
}

const directHosts = (r: ZapretRouting): string[] =>
  r.direct.flatMap((x) => (x.domain_suffix as string[]) ?? [])
const proxyHosts = (r: ZapretRouting): string[] =>
  r.proxy.flatMap((x) => (x.domain_suffix as string[]) ?? [])

describe('ZapretService — the pick', () => {
  it('the first strategy that opens every service wins; nothing direct before it is confirmed', async () => {
    // S0: nothing; S1: YouTube only; S2: everything
    const h = harness({
      world: (s, host) => s === S2 || (s === S1 && !/discord/.test(host))
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    // first thing on connect: everything of the feature through the VPN
    expect(h.routes[0].direct).toEqual([])
    expect(proxyHosts(h.routes[0])).toContain('youtube.com')
    const v = await h.idle()
    expect(h.applied.slice(0, 3)).toEqual([S0, S1, S2])
    expect(h.applied).not.toContain(S3)
    expect(v.strategy?.id).toBe(S2)
    expect(v.items.map((i) => [i.key, i.state])).toEqual([
      ['youtube', 'direct'],
      ['discord', 'direct']
    ])
    expect(directHosts(h.lastRoute())).toEqual(
      expect.arrayContaining(['youtube.com', 'discord.com'])
    )
    expect(h.lastRoute().proxy).toEqual([])
    expect(h.memory['net-home'].id).toBe(S2)
    // our servers are passed to the broker to be excluded
    expect(h.daemon.requests[0].exclude).toEqual(['203.0.113.7/32'])
    // TUN: probes bound to the physical adapter
    expect(h.checked.every((c) => c.path.localAddress === '192.168.1.5')).toBe(true)
  })

  it('none opens everything → the one that opens the most; the rest through the VPN', async () => {
    const h = harness({
      world: (s, host) =>
        (s === S1 && /youtube|ytimg|googlevideo/.test(host)) ||
        (s === S3 && host === 'www.youtube.com')
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    // every strategy once, the best ones once more, then the chosen one
    expect(h.applied.length).toBeGreaterThan(STRATEGIES.length + 1)
    expect(h.applied.length).toBeLessThanOrEqual(STRATEGIES.length + 4)
    expect(v.strategy?.id).toBe(S1)
    expect(v.items.find((i) => i.key === 'youtube')?.state).toBe('direct')
    const discord = v.items.find((i) => i.key === 'discord')
    expect(discord?.state).toBe('vpn')
    expect(discord?.detail).toMatch(/нет ответа/)
    expect(directHosts(h.lastRoute())).toContain('googlevideo.com')
    expect(proxyHosts(h.lastRoute())).toContain('discord.com')
    expect(h.lastRoute().proxy.some((r) => Array.isArray(r.ip_cidr))).toBe(true)
  })

  it('nothing works → winws off, everything through the VPN, remembered for this network', async () => {
    const h = harness({ world: () => false })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(v.strategy).toBeNull()
    expect(h.daemon.stops).toBeGreaterThan(0)
    expect(v.items.every((i) => i.state === 'vpn')).toBe(true)
    expect(h.lastRoute().direct).toEqual([])
    expect(h.memory['net-home']).toMatchObject({ id: null })
  })

  it('a remembered strategy of this network: no pick, just a check', async () => {
    const h = harness({
      world: (s) => s === S3,
      memory: { 'net-home': { id: S3, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(h.applied).toEqual([S3])
    expect(v.strategy?.id).toBe(S3)
    expect(v.items.every((i) => i.state === 'direct')).toBe(true)
  })

  it('«Подобрать заново» runs a pick by hand', async () => {
    const h = harness({
      world: (s) => s === S0,
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    expect(h.applied).toEqual([S0])
    await h.svc.repick()
    expect(h.applied.slice(1, 2)).toEqual([S0])
    expect(h.svc.view().strategy?.id).toBe(S0)
  })
})

describe('ZapretService — checks and the fallback', () => {
  it('a service that stops opening goes back through the VPN at once and the strategy is re-picked', async () => {
    let broken = false
    const h = harness({
      // S0 works until the provider changes something; then only S2 does
      world: (s) => (broken ? s === S2 : s === S0),
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } },
      checkEveryMs: 60
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    expect(h.svc.view().items.every((i) => i.state === 'direct')).toBe(true)
    broken = true
    // the next periodic check: everything fails with S0 → VPN at once, then a pick
    for (let i = 0; i < 200 && h.svc.view().strategy?.id !== S2; i++) await sleep(10)
    const failedRoute = h.routes.find(
      (r) => r.direct.length === 0 && r.proxy.length > 0 && h.routes.indexOf(r) > 1
    )
    expect(failedRoute).toBeTruthy()
    expect(h.logs.join('\n')).toMatch(/перестало открываться/)
    expect(h.logs.join('\n')).toMatch(/подбираем заново/)
    const v = await h.idle()
    expect(v.strategy?.id).toBe(S2)
    expect(v.items.every((i) => i.state === 'direct')).toBe(true)
    expect(h.memory['net-home'].id).toBe(S2)
    await h.svc.onVpn(false)
  })

  it('no DoH answers directly → nothing direct', async () => {
    const h = harness({
      world: () => true,
      doh: null,
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(v.items.every((i) => i.state === 'vpn')).toBe(true)
    expect(v.items[0].detail).toMatch(/8\.8\.8\.8/)
    expect(h.lastRoute().direct).toEqual([])
  })

  it('DNS: the fallback DoH is used when 8.8.8.8 does not answer', async () => {
    const h = harness({
      world: () => true,
      doh: 'fallback',
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    expect(h.lastRoute().dns).toBe('fallback')
  })

  it('another DPI bypass running: ours is not started, a warning, checks still decide', async () => {
    const h = harness({
      world: (_s, host) =>
        host.includes('youtube') || host.includes('ytimg') || host.includes('googlevideo'),
      foreign: 'winws.exe',
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(h.applied).toEqual([])
    expect(v.warning).toMatch(/winws\.exe/)
    expect(v.items.find((i) => i.key === 'youtube')?.state).toBe('direct')
    expect(v.items.find((i) => i.key === 'discord')?.state).toBe('vpn')
  })

  it('the broker refuses (another user runs it) → a warning, not a crash', async () => {
    const h = harness({
      world: () => false,
      applyError: new DpiStartError('dpi_busy', 'busy'),
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(v.warning).toMatch(/другого пользователя/)
    expect(v.phase).toBe('running')
  })

  it('a service of an older version (no zapret task): a reason, no UAC prompt, «nothing works» not remembered', async () => {
    const h = harness({ world: () => true, service: 'missing' })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(h.install).not.toHaveBeenCalled()
    expect(h.applied).toEqual([])
    expect(v.error).toMatch(/устарела/)
    expect(h.memory['net-home']).toBeUndefined()
    // the checks still decide (direct without our winws)
    expect(v.items.every((i) => i.state === 'direct')).toBe(true)
  })

  it('new servers in the subscription: winws restarted with their addresses excluded', async () => {
    const h = harness({
      world: () => true,
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    expect(h.applied).toEqual([S0])
    h.svc.serversChanged()
    for (let i = 0; i < 100 && h.applied.length < 2; i++) await sleep(5)
    expect(h.applied).toEqual([S0, S0])
  })

  it('another network: its own strategy (a pick there), the home one kept', async () => {
    const h = harness({
      world: (s, host) => (s === S1 ? true : s === S0 && !host.includes('discord')),
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } },
      netPollMs: 30
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    expect(h.svc.view().strategy?.id).toBe(S0)
    h.setNet({ id: 'net-cafe', source: '10.1.1.9' })
    for (let i = 0; i < 300 && h.memory['net-cafe']?.id !== S1; i++) await sleep(10)
    expect(h.memory['net-cafe']?.id).toBe(S1)
    expect(h.memory['net-home'].id).toBe(S0)
    await h.idle()
    expect(h.checked.at(-1)?.path.localAddress).toBe('10.1.1.9')
    await h.svc.onVpn(false)
  })

  it('VPN off → winws stops and the sets are emptied; nothing runs without the VPN', async () => {
    const h = harness({
      world: () => true,
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    h.setRunning(false)
    await h.svc.onVpn(false)
    expect(h.daemon.stops).toBe(1)
    expect(h.lastRoute()).toEqual(NO_ZAPRET)
    expect(h.svc.view().phase).toBe('idle')
    expect(h.svc.view().items.every((i) => i.state === 'idle')).toBe(true)
    expect(h.svc.currentRouting().direct).toEqual([])
  })
})

describe('ZapretService — switching on and the lists', () => {
  it('on needs the one-time warning and the service (one UAC prompt only here)', async () => {
    const h = harness({
      world: () => true,
      settings: { enabled: false, warned: false },
      service: 'missing'
    })
    await expect(h.svc.setEnabled(true)).rejects.toThrow(/предупреждение/)
    const v = await h.svc.setEnabled(true, true)
    expect(h.install).toHaveBeenCalledTimes(1)
    expect(v.settings).toMatchObject({ enabled: true, warned: true })
    // the VPN is off: nothing starts
    expect(v.phase).toBe('idle')
    expect(h.applied).toEqual([])
  })

  it('UAC refused → stays off with a reason', async () => {
    const h = harness({
      world: () => true,
      settings: { enabled: false, warned: false },
      service: 'missing',
      install: 'cancelled'
    })
    const v = await h.svc.setEnabled(true, true)
    expect(v.settings.enabled).toBe(false)
    expect(v.error).toMatch(/Без разрешения Windows/)
  })

  it('own domains: validated, the reserved ones refused; a new one is checked and routed', async () => {
    const h = harness({
      world: (s, host) => s === S0 && host !== 'blocked.example.com',
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    await expect(h.svc.addDomain('1.2.3.4')).rejects.toThrow(/IP/)
    await expect(h.svc.addDomain('a.sub.example.net')).rejects.toThrow(/нужен самому VPN/)
    await h.svc.addDomain('https://Example.org/x')
    await h.svc.addDomain('blocked.example.com')
    const v = await h.idle()
    expect(h.settings.custom).toEqual(['example.org', 'blocked.example.com'])
    expect(v.items.find((i) => i.key === 'd:example.org')?.state).toBe('direct')
    expect(v.items.find((i) => i.key === 'd:blocked.example.com')?.state).toBe('vpn')
    expect(directHosts(h.lastRoute())).toContain('example.org')
    expect(proxyHosts(h.lastRoute())).toContain('blocked.example.com')
    // the broker got the new list
    expect(h.daemon.requests.at(-1)?.hosts).toEqual(['example.org', 'blocked.example.com'])
    await h.svc.removeDomain('blocked.example.com')
    await h.idle()
    expect(JSON.stringify(h.lastRoute())).not.toContain('blocked.example.com')
  })

  it('a service switched off leaves the sets', async () => {
    const h = harness({
      world: () => true,
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    await h.svc.setServices(['discord'])
    await h.idle()
    expect(JSON.stringify(h.lastRoute())).not.toContain('youtube.com')
    expect(h.daemon.requests.at(-1)?.services).toEqual(['discord'])
  })
})

describe('dpiErrorText', () => {
  it('a WinDivert driver of another program gets its own clear text', () => {
    const t = dpiErrorText(
      new DpiStartError('foreign_dpi', 'x', 'драйвер WinDivert другой программы')
    )
    expect(t).toMatch(/драйвер WinDivert другой программы/)
    expect(t).toMatch(/перезагрузите компьютер/)
    expect(dpiErrorText(new DpiStartError('foreign_dpi', 'x', 'процесс winws.exe'))).toMatch(
      /winws\.exe/
    )
  })
})

describe('ZapretService — the YouTube video node (0.7.1)', () => {
  const NODE = 'rr2---sn-8ph2xajvh-n8vs.googlevideo.com'
  // the pages open with any strategy (and without), the video node only with S2
  const world: World = (s, host) => (host === NODE ? s === S2 : true)

  it('a strategy that opens the pages but not the video is not counted; the pick goes on to one that does', async () => {
    const h = harness({ world, videoNodes: [NODE], settings: { services: ['youtube'] } })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(h.applied.slice(0, 3)).toEqual([S0, S1, S2])
    expect(v.strategy?.id).toBe(S2)
    expect(v.items[0]).toMatchObject({ key: 'youtube', state: 'direct' })
    expect(v.items[0].note).toBeUndefined()
    expect(h.checked.some((c) => c.host === NODE)).toBe(true)
    expect(h.memory['net-home']).toMatchObject({ id: S2, v: 2 })
    expect(h.memory['net-home'].ok).toEqual(
      expect.arrayContaining(['youtube', 'youtube:video', 'youtube:quic'])
    )
    // it opened the video here: tried first by the next pick
    expect(h.memory['net-home'].good?.[0].id).toBe(S2)
  })

  it('no strategy opens the video → YouTube through the VPN, the reason says «видео»', async () => {
    const h = harness({
      world: (_s, host) => host !== NODE,
      videoNodes: [NODE],
      settings: { services: ['youtube'] }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(v.strategy).toBeNull()
    // the pages open by themselves: only they go direct, the video through the VPN
    expect(v.items[0]).toMatchObject({ state: 'partial', note: 'сайт напрямую, видео через VPN' })
    expect(v.items[0].detail).toMatch(/видео не открывается напрямую/)
    expect(directHosts(h.lastRoute())).toContain('youtube.com')
    expect(directHosts(h.lastRoute())).not.toContain('googlevideo.com')
    expect(proxyHosts(h.lastRoute())).toContain('googlevideo.com')
    // a pick's failure is «не открылся», never «перестало открываться»
    expect(h.logs.join('\n')).not.toMatch(/перестало открываться/)
    expect(h.logs.join('\n')).toMatch(/напрямую не открылся — youtube:video/)
  })

  it('no video node found → YouTube is not «verified»: through the VPN', async () => {
    const h = harness({
      world: () => true,
      videoNodes: [],
      settings: { services: ['youtube'] },
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(v.items[0].state).toBe('partial')
    expect(v.items[0].detail).toMatch(/не найден видеосервер/)
    expect(directHosts(h.lastRoute())).not.toContain('googlevideo.com')
  })

  it('a strategy remembered by 0.7.0 (no video check then) is picked again', async () => {
    const h = harness({
      world,
      videoNodes: [NODE],
      settings: { services: ['youtube'] },
      memory: { 'net-home': { id: S0, at: Date.now() } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(v.strategy?.id).toBe(S2)
    expect(h.memory['net-home'].v).toBe(2)
  })
})

describe('ZapretService — back to the VPN by live traffic (0.7.1)', () => {
  let clock = Date.now()
  const conn = (id: string, host: string, ageMs: number, download = 0, network = 'tcp') => ({
    id,
    rule: 'rule_set=cw-z-d => route(direct)',
    start: new Date(clock - ageMs).toISOString(),
    download,
    metadata: { host, network }
  })

  it('3 direct connections without an answer within a minute → that protocol through the VPN; others do nothing', async () => {
    clock = Date.now()
    const h = harness({
      world: () => true,
      now: () => clock,
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    const yt = (): ZapretView['items'][number] | undefined =>
      h.svc.view().items.find((i) => i.key === 'youtube')
    expect(yt()?.state).toBe('direct')
    // the sets were just applied (our reconnection): nothing counts for LIVE_QUIET_MS
    h.svc.onConnections({
      connections: ['q1', 'q2', 'q3'].map((id) => conn(id, 'i.ytimg.com', LIVE_STALL_MS + 1000))
    })
    expect(yt()?.state).toBe('direct')
    clock += LIVE_QUIET_MS + 30_000
    const routesBefore = h.routes.length
    // answered, too young, another rule, opened during the reconnection: none counts; two real ones
    h.svc.onConnections({
      connections: [
        conn('a', 'rr1---sn-x.googlevideo.com', 20_000, 5000),
        conn('b', 'rr1---sn-x.googlevideo.com', 1000),
        { ...conn('c', 'rr1---sn-x.googlevideo.com', 20_000), rule: 'final' },
        conn('old', 'rr1---sn-x.googlevideo.com', LIVE_QUIET_MS + 29_000),
        conn('e', 'rr1---sn-x.googlevideo.com', LIVE_STALL_MS + 1000),
        conn('f', 'rr2---sn-x.googlevideo.com', LIVE_STALL_MS + 1000),
        // QUIC is counted apart: one stalled QUIC connection is not a TCP failure
        conn('u', 'rr2---sn-x.googlevideo.com', LIVE_STALL_MS + 1000, 0, 'udp')
      ]
    })
    expect(yt()?.state).toBe('direct')
    expect(h.routes.length).toBe(routesBefore)
    // the third TCP one: the video over TCP goes through the VPN, QUIC and the pages stay
    h.svc.onConnections({
      connections: [conn('g', 'rr3---sn-x.googlevideo.com', LIVE_STALL_MS + 2000)]
    })
    await sleep(20)
    expect(yt()).toMatchObject({ state: 'direct', note: 'видео по QUIC' })
    const r = h.lastRoute()
    expect(r.proxy).toContainEqual({ domain_suffix: ['googlevideo.com'], network: ['tcp'] })
    expect(r.direct).toContainEqual(
      expect.objectContaining({ domain_suffix: ['googlevideo.com'], network: ['udp'] })
    )
    expect(h.svc.view().items.find((i) => i.key === 'discord')?.state).toBe('direct')
    // right after that change: quiet again
    clock += 1000
    h.svc.onConnections({
      connections: ['p1', 'p2', 'p3'].map((id) => conn(id, 'i.ytimg.com', LIVE_STALL_MS + 500))
    })
    expect(yt()?.state).toBe('direct')
    // later: the pages too
    clock += LIVE_QUIET_MS + 10_000
    h.svc.onConnections({
      connections: ['p4', 'p5', 'p6'].map((id) => conn(id, 'i.ytimg.com', LIVE_STALL_MS + 500))
    })
    await sleep(20)
    expect(yt()).toMatchObject({ state: 'partial' })
    expect(yt()?.detail).toMatch(/не получают ответа/)
    // until the re-check time, a passing check does not bring it back (no flip-flop)
    await h.svc.repick()
    expect(yt()?.state).toBe('partial')
    await h.svc.onVpn(false)
  })

  it('the thresholds are sane', () => {
    expect(LIVE_STALLS).toBeGreaterThanOrEqual(3)
    expect(LIVE_STALL_MS).toBeGreaterThanOrEqual(4000)
    expect(LIVE_RECHECK_MS).toBeLessThan(10 * 60_000)
    expect(LIVE_REPEAT_MS).toBeGreaterThan(LIVE_RECHECK_MS)
  })
})

describe('ZapretService — DNS failover (0.7.1)', () => {
  it('the core reporting 8.8.8.8 failing → the zapret domains to 1.1.1.1 (and kept there)', async () => {
    const h = harness({
      world: () => true,
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    expect(h.lastRoute().dns).toBe('primary')
    const line = 'ERROR dns: exchange failed for www.youtube.com: dial tcp 8.8.8.8:443: i/o timeout'
    h.svc.onCoreLine('INFO something else')
    h.svc.onCoreLine(line)
    expect(h.lastRoute().dns).toBe('primary')
    for (let i = 1; i < DNS_FAILS; i++) h.svc.onCoreLine(line)
    await sleep(10)
    expect(h.lastRoute().dns).toBe('fallback')
    expect(h.logs.join('\n')).toMatch(/DNS 8\.8\.8\.8 не отвечает/)
    // the next check finds 8.8.8.8 fine again — still on 1.1.1.1 for a while
    await h.svc.repick()
    expect(h.lastRoute().dns).toBe('fallback')
    await h.svc.onVpn(false)
  })
})

describe('ZapretService — QUIC apart from TCP (0.7.2)', () => {
  const NODE = 'rr2---sn-8ph2xajvh-n8vs.googlevideo.com'

  it('the video opens over QUIC only → UDP to YouTube direct, TCP to googlevideo through the VPN', async () => {
    const h = harness({
      // the pages open; the node: QUIC with S1, TCP never
      world: (s, host, quic) => (host === NODE ? !!quic && s === S1 : host !== 'redirector.googlevideo.com' || !!quic),
      videoNodes: [NODE],
      settings: { services: ['youtube'] }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(v.strategy?.id).toBe(S1)
    expect(v.items[0]).toMatchObject({ state: 'direct', note: 'видео по QUIC' })
    const r = h.lastRoute()
    // the pages: TCP (their own result) and QUIC → one rule; the video nodes: QUIC only
    expect(r.direct).toContainEqual({ domain_suffix: expect.arrayContaining(['youtube.com', 'ytimg.com']) })
    expect(r.direct).toContainEqual({ domain_suffix: ['googlevideo.com'], network: ['udp'] })
    expect(r.proxy).toEqual([{ domain_suffix: ['googlevideo.com'], network: ['tcp'] }])
  })
})

describe('ZapretService — a sturdy pick (0.7.2)', () => {
  const NODE = 'rr2---sn-8ph2xajvh-n8vs.googlevideo.com'
  const S10 = STRATEGIES[10].id

  it('what worked here last is tried first; a lucky single pass does not win over a confirmed one', async () => {
    // S0 opens the video on its first try only (DPI «remembers»); S10 every time
    const runsOf = (id: string): number => h.applied.filter((x) => x === id).length
    const h: ReturnType<typeof harness> = harness({
      world: (s, host) => host !== NODE || s === S10 || (s === S0 && runsOf(S0) <= 1),
      videoNodes: [NODE],
      settings: { services: ['youtube'] },
      memory: {
        'net-home': {
          id: S0,
          at: Date.now() - 60_000,
          v: 2,
          ok: ['youtube'],
          good: [{ id: S10, at: Date.now() - 3600_000, ok: ['youtube', 'youtube:video'] }]
        }
      }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    // the remembered one broke (its check) → a pick: S0, then the one that opened the video here
    await h.svc.repick()
    const v = h.svc.view()
    const pickStart = h.applied.lastIndexOf(S0, h.applied.indexOf(S10))
    expect(h.applied.slice(pickStart, pickStart + 2)).toEqual([S0, S10])
    expect(v.strategy?.id).toBe(S10)
    expect(v.items[0].state).toBe('direct')
    expect(h.logs.join('\n')).toMatch(/перепроверка/)
  })
})

describe('ZapretService — own domains without an address (0.7.2)', () => {
  it('a bare root without an address: «нет адреса», direct while its subdomain opens; the subdomain is never cut off', async () => {
    const h = harness({
      world: (_s, host) =>
        host === 'pragmaengine.com' || host === 'www.pragmaengine.com' ? 'noaddr' : true,
      settings: {
        services: [],
        custom: ['pragmaengine.com', 'live.wardogs.bulkhead.pragmaengine.com']
      },
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(v.items[0]).toMatchObject({
      key: 'd:pragmaengine.com',
      state: 'direct',
      note: 'нет адреса — проверяется по поддоменам'
    })
    expect(v.items[1]).toMatchObject({ state: 'direct' })
  })

  it('the more specific entry wins: a direct root with a failing subdomain cuts it out', async () => {
    const h = harness({
      world: (_s, host) => !host.includes('bad.'),
      settings: { services: [], custom: ['example.org', 'bad.example.org'] },
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } }
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    const r = h.lastRoute()
    expect(r.direct).toEqual([
      {
        type: 'logical',
        mode: 'and',
        rules: [{ domain_suffix: ['example.org'] }, { domain_suffix: ['bad.example.org'], invert: true }]
      }
    ])
    expect(r.proxy).toEqual([{ domain_suffix: ['bad.example.org'] }])
  })
})

describe('ZapretService — rules «Напрямую + zapret» (0.7.2)', () => {
  const rules: RoutingRule[] = [
    { id: 'a', enabled: true, conditionType: 'Domain', value: 'game.example.org', action: 'ZAPRET' },
    { id: 'b', enabled: true, conditionType: 'IPCIDR', value: '198.51.100.0/24', action: 'ZAPRET' },
    {
      id: 'c',
      enabled: true,
      conditionType: 'DomainSuffix',
      value: 'blocked.example.net',
      action: 'ZAPRET',
      zapretFallback: false
    },
    { id: 'd', enabled: true, conditionType: 'DomainKeyword', value: 'game', action: 'ZAPRET' },
    { id: 'e', enabled: true, conditionType: 'Domain', value: 'other.example.org', action: 'DIRECT' }
  ]

  it('their domains / addresses go to zapret; a failing one goes through the VPN unless the user said no', async () => {
    const h = harness({
      world: (_s, host) => host !== 'blocked.example.net' && host !== 'www.blocked.example.net' && host !== 'game.example.org',
      settings: { services: [] },
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } },
      rules
    })
    // before the VPN: plain «Напрямую»
    expect(h.svc.effectiveRules(rules).map((r) => r.action)).toEqual([
      'DIRECT',
      'DIRECT',
      'DIRECT',
      'DIRECT',
      'DIRECT'
    ])
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    const req = h.daemon.requests.at(-1)!
    expect(req.hosts).toEqual(['game.example.org', 'blocked.example.net'])
    expect(req.ips).toEqual(['198.51.100.0/24'])
    // a failing rule → VPN; the fallback switched off → stays direct; a keyword → plain direct
    expect(h.svc.effectiveRules(rules).map((r) => r.action)).toEqual([
      'PROXY',
      'DIRECT',
      'DIRECT',
      'DIRECT',
      'DIRECT'
    ])
    expect(h.rulesChanged).toBeGreaterThan(0)
    expect(v.rules?.a.state).toBe('vpn')
    expect(v.rules?.b.state).toBe('direct')
    expect(v.rules?.c.state).toBe('plain')
    expect(v.rules?.d).toMatchObject({ state: 'plain' })
    expect(v.rules?.d.detail).toMatch(/Слово в домене/)
    expect(v.rules?.e).toBeUndefined()
    // off → plain direct again
    await h.svc.onVpn(false)
    expect(h.svc.effectiveRules(rules)[0].action).toBe('DIRECT')
  })
})

describe('ZapretService — IP rules, safely (0.7.2 review)', () => {
  const rules: RoutingRule[] = [
    { id: 'n', enabled: true, conditionType: 'IPCIDR', value: '198.51.100.0/24', action: 'ZAPRET' },
    { id: 'w', enabled: true, conditionType: 'IPCIDR', value: '10.0.0.0/7', action: 'ZAPRET' },
    { id: 'z', enabled: true, conditionType: 'IPCIDR', value: '010.1.1.1', action: 'ZAPRET' },
    { id: 's', enabled: true, conditionType: 'IPCIDR', value: '2001:DB8:0:0::1', action: 'ZAPRET' }
  ]

  it('only canonical, not too wide; a bad rule is left out, the rest go; a range: «проверяется по трафику»', async () => {
    const h = harness({
      world: () => true,
      settings: { services: [] },
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } },
      rules
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(h.daemon.requests.at(-1)?.ips).toEqual(['198.51.100.0/24', '2001:db8::1'])
    expect(v.rules?.n).toMatchObject({ state: 'direct', note: 'проверяется по трафику' })
    expect(v.rules?.w.state).toBe('plain')
    expect(v.rules?.w.detail).toMatch(/не шире \/8/)
    expect(v.rules?.z.state).toBe('plain')
    expect(v.rules?.s.state).toBe('direct')
  })

  it('our servers\' addresses unknown (failed / empty with servers) → no IP rules to zapret at all', async () => {
    for (const excludeIps of [
      async (): Promise<string[]> => {
        throw new Error('dns')
      },
      async (): Promise<string[]> => []
    ]) {
      const h = harness({
        world: () => true,
        settings: { services: [] },
        memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } },
        rules,
        excludeIps
      })
      h.setRunning(true)
      await h.svc.onVpn(true)
      await h.idle()
      expect(h.daemon.requests.at(-1)?.ips).toBeUndefined()
      expect(h.logs.join('\n')).toMatch(/правила по IP пока без zapret/)
      await h.svc.onVpn(false)
    }
  })

  it('live traffic of a range: a connection to an address inside it counts', async () => {
    let clock = Date.now()
    const h = harness({
      world: () => true,
      settings: { services: [] },
      memory: { 'net-home': { id: S0, at: Date.now(), v: 2 } },
      rules,
      now: () => clock
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    clock += 60_000
    const conn = (id: string, ip: string) => ({
      id,
      rule: 'rule_set=cw-0-d => route(direct)',
      start: new Date(clock - LIVE_STALL_MS - 1000).toISOString(),
      download: 0,
      metadata: { host: '', network: 'tcp', destinationIP: ip }
    })
    // outside the range: nothing
    h.svc.onConnections({ connections: ['a', 'b', 'c'].map((id) => conn(id, '198.51.101.9')) })
    expect(h.svc.view().rules?.n.state).toBe('direct')
    h.svc.onConnections({ connections: ['d', 'e', 'f'].map((id) => conn(id, '198.51.100.77')) })
    await sleep(20)
    expect(h.svc.view().rules?.n.state).toBe('vpn')
    expect(h.svc.effectiveRules(rules)[0].action).toBe('PROXY')
    await h.svc.onVpn(false)
  })
})

describe('ZapretService — a light check (0.7.3)', () => {
  const memo = { 'net-home': { id: S0, at: Date.now(), v: 2 } }

  it('≤ 2 connections at a time; the log names the reason, the time and the connections', async () => {
    const h = harness({ world: (s) => s === S0, memory: memo, targetDelayMs: 15 })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    expect(h.checked.length).toBeGreaterThan(2)
    expect(h.maxParallel()).toBeLessThanOrEqual(2)
    const line = h.logs.find((l) => l.includes('перепроверка (после подключения)'))
    expect(line).toMatch(/— \d{1,2}:\d{2}:\d{2}–\d{1,2}:\d{2}:\d{2} \(\d+ с\), соединений: \d+, напрямую \d+ из \d+$/)
    await h.svc.onVpn(false)
  })

  it('a one-off failure is checked once more: no re-pick when it opens the second time', async () => {
    let flaky = 0
    const h = harness({
      // the regular check (after the first one) misses www.youtube.com once
      world: (s, host) => {
        if (s !== S0) return false
        if (host === 'www.youtube.com' && flaky === 1) {
          flaky = 2
          return false
        }
        return true
      },
      memory: memo,
      checkEveryMs: 60
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    flaky = 1
    for (let i = 0; i < 200 && !h.logs.some((l) => l.includes('со второй попытки')); i++)
      await sleep(10)
    expect(h.logs.join('\n')).toMatch(/со второй попытки открылось — youtube/)
    expect(h.logs.join('\n')).not.toMatch(/подбираем/)
    expect(h.applied).toEqual([S0])
    expect(h.svc.view().items.every((i) => i.state === 'direct')).toBe(true)
    await h.svc.onVpn(false)
  })

  it('zapret off / VPN off in the middle of a check: the probes in flight end at once, nothing new starts', async () => {
    const h = harness({ world: () => true, memory: memo, targetDelayMs: 10_000 })
    h.setRunning(true)
    await h.svc.onVpn(true)
    for (let i = 0; i < 200 && h.inFlight === 0; i++) await sleep(5)
    expect(h.inFlight).toBeGreaterThan(0)
    const asked = h.checked.length
    const t0 = Date.now()
    h.setRunning(false)
    await h.svc.onVpn(false)
    await sleep(30)
    expect(h.inFlight).toBe(0)
    expect(Date.now() - t0).toBeLessThan(2000)
    await sleep(100)
    expect(h.checked.length).toBe(asked)
    expect(h.logs.join('\n')).toMatch(/перепроверка \(после подключения\) — .*прервана/)
  })

  it('the broker leaving our servers out of WinDivert is logged once', async () => {
    const h = harness({ world: (s) => s === S0, memory: memo })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    expect(h.logs.filter((l) => l.includes('не проходит через zapret'))).toHaveLength(1)
    await h.svc.onVpn(false)
  })
})

describe('ZapretService — «Напрямую + zapret» for a program (0.7.4)', () => {
  const memo = { 'net-home': { id: S0, at: Date.now(), v: 2 } }
  const prog: RoutingRule = {
    id: 'p',
    enabled: true,
    conditionType: 'ProcessName',
    value: 'Game.exe',
    action: 'ZAPRET'
  }
  const conn = (id: string, ip: string, port = '443', network = 'tcp', exe = 'C:\\Games\\game.exe') => ({
    id,
    rule: 'rule_set=[cw-0-d] => route(cw-0)',
    chains: ['direct', 'cw-0'],
    start: new Date().toISOString(),
    download: 100,
    metadata: { host: '', network, destinationIP: ip, destinationPort: port, processPath: exe }
  })

  it('direct, not checked, never to the VPN; the state says «порты 80/443»', async () => {
    const h = harness({ world: () => true, settings: { services: [] }, memory: memo, rules: [prog] })
    h.setRunning(true)
    await h.svc.onVpn(true)
    const v = await h.idle()
    expect(v.rules?.p).toEqual({ state: 'direct', note: 'порты 80/443' })
    expect(h.svc.effectiveRules([prog])[0].action).toBe('DIRECT')
    expect(h.checked).toEqual([])
    // nothing learned yet: no IP profiles for winws
    expect(h.daemon.requests.at(-1)?.ips).toBeUndefined()
    await h.svc.onVpn(false)
    expect(h.svc.view().rules?.p.state).toBe('plain')
  })

  it('only programs, nothing remembered: winws starts with the first strategy (no pick)', async () => {
    const h = harness({ world: () => true, settings: { services: [] }, rules: [prog] })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    expect(h.daemon.requests.map((r) => r.strategy)).toEqual([S0])
    expect(h.memory['net-home']).toBeUndefined()
    await h.svc.onVpn(false)
  })

  it('its addresses on 80/443 go to zapret: public only, never our servers, throttled, only when new', async () => {
    const h = harness({
      world: () => true,
      settings: { services: [] },
      memory: memo,
      rules: [prog],
      excludeIps: async () => ['8.8.8.8/32'],
      learnGapMs: 80,
      learnBatchMs: 0
    })
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    const n0 = h.daemon.requests.length
    h.svc.onConnections({
      connections: [
        conn('a', '1.1.1.1'),
        conn('b', '8.8.8.8'), // our server
        conn('c', '192.168.1.10'), // the LAN
        conn('d', '9.9.9.9', '27015', 'udp'), // a game's own UDP: not zapret's
        conn('e', '2606:4700:4700:0:0:0:0:1111', '443', 'udp'), // QUIC
        conn('f', '4.4.4.4', '443', 'tcp', 'C:\\other.exe') // another program
      ]
    })
    // throttled: not at once after winws started
    expect(h.daemon.requests.length).toBe(n0)
    await sleep(200)
    expect(h.daemon.requests.length).toBe(n0 + 1)
    expect(h.daemon.requests.at(-1)?.ips).toEqual(['2606:4700:4700::1111', '1.1.1.1'])
    // the same addresses again: no new list
    h.svc.onConnections({ connections: [conn('a2', '1.1.1.1')] })
    await sleep(200)
    expect(h.daemon.requests.length).toBe(n0 + 1)
    // a new one: the next list (after the gap)
    h.svc.onConnections({ connections: [conn('g', '1.0.0.1', '80')] })
    expect(h.daemon.requests.length).toBe(n0 + 1)
    await sleep(200)
    expect(h.daemon.requests.length).toBe(n0 + 2)
    // newest first; 1.1.1.1 was seen again since — newer than the QUIC address
    expect(h.daemon.requests.at(-1)?.ips).toEqual(['1.0.0.1', '1.1.1.1', '2606:4700:4700::1111'])
    await h.svc.onVpn(false)
    // a new session starts empty
    h.setRunning(true)
    await h.svc.onVpn(true)
    await h.idle()
    expect(h.daemon.requests.at(-1)?.ips).toBeUndefined()
    await h.svc.onVpn(false)
  })
})
