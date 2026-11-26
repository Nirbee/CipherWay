import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ZAPRET, type ZapretSettings, type ZapretView } from '@shared/zapret'
import { NO_ZAPRET, type ZapretRouting } from '../rules/compile'
import type { CheckTarget } from './lists'
import type { DirectPath, DohServer, NetworkInfo, TargetResult } from './checks'
import { DpiStartError, type DpiDaemonLike, type DpiRequest } from './DpiDaemon'
import type { DpiBrokerState } from './dpiBroker'
import { STRATEGIES } from './strategies'
import { dpiErrorText, ZapretService, type StrategyMemo, type ZapretDeps } from './ZapretService'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const [S0, S1, S2, S3] = STRATEGIES.map((s) => s.id)

/** which hosts open directly with which strategy (null = winws off) */
type World = (strategy: string | null, host: string) => boolean

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
}) {
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
        dpiPid: 100 + applied.length
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
    checkTarget: async (t: CheckTarget, _doh, path): Promise<TargetResult> => {
      checked.push({ host: t.host, path })
      return o.world(strategy, t.host)
        ? { host: t.host, ok: true, ms: 10 }
        : { host: t.host, ok: false, error: 'timeout' }
    },
    excludeIps: async () => ['203.0.113.7/32'],
    reserved: () => ['sub.example.net'],
    applyRouting: async (r) => {
      routes.push(r)
    },
    foreignDpi: async () => o.foreign ?? null,
    publish: (v) => views.push(v),
    log: (_l, m) => logs.push(m),
    settleMs: 0,
    checkEveryMs: o.checkEveryMs ?? 3_600_000,
    netPollMs: o.netPollMs ?? 3_600_000
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
    setNet: (n: NetworkInfo | null) => (net = n),
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
    expect(h.applied.length).toBe(STRATEGIES.length + 1)
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
      memory: { 'net-home': { id: S3, at: Date.now() } }
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
      memory: { 'net-home': { id: S0, at: Date.now() } }
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
      memory: { 'net-home': { id: S0, at: Date.now() } },
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
      memory: { 'net-home': { id: S0, at: Date.now() } }
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
      memory: { 'net-home': { id: S0, at: Date.now() } }
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
      memory: { 'net-home': { id: S0, at: Date.now() } }
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
      memory: { 'net-home': { id: S0, at: Date.now() } }
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
    const h = harness({ world: () => true, memory: { 'net-home': { id: S0, at: Date.now() } } })
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
      memory: { 'net-home': { id: S0, at: Date.now() } },
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
    const h = harness({ world: () => true, memory: { 'net-home': { id: S0, at: Date.now() } } })
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
      memory: { 'net-home': { id: S0, at: Date.now() } }
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
    const h = harness({ world: () => true, memory: { 'net-home': { id: S0, at: Date.now() } } })
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
