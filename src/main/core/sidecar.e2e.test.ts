// End-to-end check of SidecarManager against the real cores (opt-in):
//   CW_E2E=1 npx vitest run src/main/core/sidecar.e2e.test.ts
// Needs resources/bin (cipherway-core.exe + cipherway-xray.exe) and internet access (the
// latency probe fetches gstatic.com/generate_204). The "live" node is a local
// xray VLESS server on 127.0.0.1, the "dead" one points at a closed port, the
// "blackhole" one at a non-routable address (times out like a node that is
// blocked from Russia). The Windows system proxy is mocked — the registry is
// never touched. TUN itself needs UAC and is not started here; the TUN broker
// runs non-elevated (a real TUN config then fails to open the adapter — which is
// what the «first start» tests want). Only processes these tests started are ever
// stopped, always by pid. Nothing here may run elevated: see `elevated` below.
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AutoInfo,
  OutboundConfig,
  RoutingRule,
  RulesConfig,
  ServerPing,
  StatusUpdate
} from '@shared/types'
import { TEST_RULES, TEST_SETTINGS } from './fixtures'
import { CORE_EXE, XRAY_EXE } from './coreNames'

const tmp = mkdtempSync(join(tmpdir(), 'cw-e2e-'))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmp, getVersion: () => '0.0.0-e2e' }
}))
vi.mock('../system/proxy', () => ({
  enableSystemProxy: vi.fn(async () => undefined),
  disableSystemProxy: vi.fn(async () => undefined)
}))
const memory = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../store', () => ({
  store: {
    get: (k: string) => memory.get(k) ?? null,
    set: (k: string, v: unknown) => void memory.set(k, v)
  },
  getSettings: () => ({}),
  DEFAULT_SETTINGS: {}
}))
vi.mock('../secrets', () => ({
  getSubscriptionUrl: () => memory.get('url') ?? null,
  setSubscriptionUrl: (u: string | null) => void memory.set('url', u)
}))
// the real adapter can't be created here, and the machine may have a real one up
const fakeAdapter = vi.hoisted(() => ({ up: false }))
vi.mock('./broker', async (orig) => ({
  ...(await orig<typeof import('./broker')>()),
  hasTunAdapter: () => fakeAdapter.up
}))

const BIN = resolve(__dirname, '../../../resources/bin')
const XRAY = join(BIN, XRAY_EXE)
const SINGBOX = join(BIN, CORE_EXE)
/** an elevated run could create a real adapter and real routes: never */
const elevated = ((): boolean => {
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
})()
const enabled = !!process.env.CW_E2E && !elevated && existsSync(SINGBOX) && existsSync(XRAY)
/** the brokers here may look for / remove only this (non-existent) adapter */
const E2E_TUN = 'CipherWayE2E'

const UUID = '0b6f7c1e-3a7d-4c55-9a51-6f2f1b0d9e11' // random, local test server only
/**
 * Xray's freedom refuses private addresses by default; with another VPN client's
 * TUN on the machine (fake-ip DNS, 198.18.x.x) that is everything.
 */
const FREEDOM = { protocol: 'freedom', settings: { finalRules: [{ action: 'allow' }] } }
const SERVER_PORT = 27_431
const HTTP_PORT = 27_432

const live: OutboundConfig = {
  id: 'ob_live',
  name: 'Live',
  protocol: 'vless',
  server: '127.0.0.1',
  port: SERVER_PORT,
  uuid: UUID,
  encryption: 'none',
  security: 'none',
  network: 'tcp'
}
const dead: OutboundConfig = { ...live, id: 'ob_dead', name: 'Dead', port: 1 }
/** TEST-NET-ish non-routable address: connects time out instead of failing fast */
const blackhole: OutboundConfig = {
  ...live,
  id: 'ob_hole',
  name: 'Blackhole',
  server: '10.255.255.1',
  port: 443
}

let server: ChildProcess | null = null

function curl(args: string[], timeout = 20_000): Promise<string> {
  return new Promise((res) =>
    execFile('curl', args, { timeout, windowsHide: true }, (_e, out) => res(String(out)))
  )
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms
  let v = await fn()
  while (!ok(v) && Date.now() < end) {
    await sleep(200)
    v = await fn()
  }
  return v
}

describe.skipIf(!enabled)('SidecarManager with real cores', () => {
  beforeAll(async () => {
    const cfg = join(tmp, 'server.json')
    writeFileSync(
      cfg,
      JSON.stringify({
        log: { loglevel: 'warning' },
        inbounds: [
          {
            listen: '127.0.0.1',
            port: SERVER_PORT,
            protocol: 'vless',
            settings: { clients: [{ id: UUID }], decryption: 'none' },
            streamSettings: { network: 'raw', security: 'none' }
          }
        ],
        outbounds: [FREEDOM]
      })
    )
    server = spawn(XRAY, ['run', '-c', cfg], { windowsHide: true })
    await sleep(800)
  })

  afterAll(() => {
    server?.kill()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('latency while disconnected: temporary cores, live answers, dead does not', async () => {
    const { SidecarManager } = await import('./SidecarManager')
    const m = new SidecarManager(
      () => undefined,
      () => undefined,
      () => undefined
    )
    const res = await m.testLatency([live, dead])
    const byId = Object.fromEntries(res.map((r) => [r.outboundId, r.latencyMs]))
    expect(typeof byId.ob_live).toBe('number')
    expect(byId.ob_dead).toBeNull()
    expect(m.isRunning).toBe(false)
    expect(existsSync(join(tmp, 'run', 'probe'))).toBe(false) // creds cleaned up
  }, 30_000)

  it('connect → hot mode/server switch → connections → disconnect', async () => {
    const { SidecarManager } = await import('./SidecarManager')
    const { toConnItems } = await import('./connections')
    const states: StatusUpdate['state'][] = []
    const m = new SidecarManager(
      () => undefined,
      (s) => states.push(s),
      () => undefined
    )
    await m.start({
      outbounds: [live, dead],
      activeOutboundId: 'auto',
      rules: TEST_RULES,
      settings: { ...TEST_SETTINGS, httpPort: HTTP_PORT, routingMode: 'rule' }
    })
    try {
      expect(states.at(-1)).toBe('connected')
      const api = m.clash!
      expect(await api.getMode()).toBe('Rule')
      expect(await api.groupNow('proxy')).toBe('auto')
      // default log level is warn now (0.4.1)
      const cfg = JSON.parse(readFileSync(join(tmp, 'run', 'config.json'), 'utf8'))
      expect(cfg.log.level).toBe('warn')

      // «Весь трафик» without a restart
      expect(await m.setRoutingMode('global')).toBe(true)
      expect(await api.getMode()).toBe('Global')

      // server switch without a restart
      expect(await m.selectServer('ob_live')).toBe(true)
      expect(await api.groupNow('proxy')).toBe('ob_live')

      // latency through the running core
      const res = await m.testLatency([live, dead])
      expect(typeof res.find((r) => r.outboundId === 'ob_live')?.latencyMs).toBe('number')
      expect(res.find((r) => r.outboundId === 'ob_dead')?.latencyMs).toBeNull()

      // a real request through the mixed inbound shows up as a curl.exe connection
      const slow = curl([
        '-s',
        '-o',
        'NUL',
        '-x',
        `http://127.0.0.1:${HTTP_PORT}`,
        '--limit-rate',
        '20k',
        '--max-time',
        '6',
        'https://speed.cloudflare.com/__down?bytes=400000'
      ])
      await sleep(2500)
      const raw = await api.connections()
      const items = toConnItems(raw ?? {}, {
        outbounds: [live, dead],
        prev: new Map(),
        now: Date.now()
      })
      const c = items.find((i) => i.host === 'speed.cloudflare.com')
      expect(c).toMatchObject({ route: 'proxy', serverName: 'Live' })
      expect(c?.process?.toLowerCase()).toBe('curl.exe')
      expect(c?.rule).toBe('Режим «Весь трафик через VPN»')

      // «Напрямую»
      expect(await m.setRoutingMode('direct')).toBe(true)
      expect(await api.getMode()).toBe('Direct')
      await slow
    } finally {
      await m.stop()
    }
    expect(states.at(-1)).toBe('disconnected')
    expect(m.clash).toBeNull()
  }, 60_000)

  it('«Лучший сервер»: a dead first node (by last latency) is not used, check → node + its delay', async () => {
    const { SidecarManager } = await import('./SidecarManager')
    const autos: AutoInfo[] = []
    const pings: ServerPing[][] = []
    const m = new SidecarManager(
      () => undefined,
      () => undefined,
      () => undefined,
      (a) => autos.push(a),
      (p) => pings.push(p)
    )
    await m.start({
      // subscription order: a dead node first
      outbounds: [blackhole, live],
      activeOutboundId: 'auto',
      rules: TEST_RULES,
      settings: { ...TEST_SETTINGS, httpPort: HTTP_PORT, routingMode: 'global' },
      latencies: { ob_hole: null, ob_live: 40 }
    })
    try {
      const cfg = JSON.parse(readFileSync(join(tmp, 'run', 'config.json'), 'utf8'))
      const group = cfg.outbounds.find((o: { tag: string }) => o.tag === 'auto')
      expect(group.outbounds).toEqual(['ob_live', 'ob_hole'])

      // the very first request (urltest not checked yet) goes through the live node
      const t0 = Date.now()
      const code = await curl([
        '-s',
        '-o',
        'NUL',
        '-w',
        '%{http_code}',
        '-x',
        `http://127.0.0.1:${HTTP_PORT}`,
        '--max-time',
        '4',
        'https://www.gstatic.com/generate_204'
      ])
      expect(code).toBe('204')
      expect(Date.now() - t0).toBeLessThan(4000)

      // «проверяем…» first, then the chosen node with its own latency
      expect(autos[0]).toMatchObject({ checking: true, dead: false })
      const done = await waitFor(
        () => autos.at(-1)!,
        (a) => !a.checking,
        20_000
      )
      expect(done).toMatchObject({ nodeId: 'ob_live', checking: false, dead: false })
      expect(typeof done.delayMs).toBe('number')
      // every node's latency for the list
      const last = pings.at(-1)!
      expect(last.find((p) => p.outboundId === 'ob_live')?.latencyMs).toEqual(expect.any(Number))
      expect(last.find((p) => p.outboundId === 'ob_hole')?.latencyMs).toBeNull()
    } finally {
      await m.stop()
    }
    expect(autos.at(-1)).toEqual({ checking: false, dead: false })
  }, 60_000)

  it('«Лучший сервер»: nobody answers → honest «dead», not a fake node', async () => {
    const { SidecarManager } = await import('./SidecarManager')
    const autos: AutoInfo[] = []
    const m = new SidecarManager(
      () => undefined,
      () => undefined,
      () => undefined,
      (a) => autos.push(a)
    )
    await m.start({
      outbounds: [dead, { ...dead, id: 'ob_dead2', name: 'Dead 2', port: 2 }],
      activeOutboundId: 'auto',
      rules: TEST_RULES,
      settings: { ...TEST_SETTINGS, httpPort: HTTP_PORT }
    })
    try {
      const done = await waitFor(
        () => autos.at(-1)!,
        (a) => !a.checking,
        30_000
      )
      expect(done).toMatchObject({ checking: false, dead: true, delayMs: null })
    } finally {
      await m.stop()
    }
  }, 60_000)

  it('«Лучший сервер»: a silent node (accepts, never answers) is no reason for «no server answers»', async () => {
    // 0.4.1 decided after 8 s; sing-box publishes `now` only when its slowest
    // member is done (a silent node: ~15 s) — and /group/delay is a no-op until then
    const { createServer } = await import('node:net')
    const sockets: import('node:net').Socket[] = []
    const silentSrv = createServer((s) => {
      sockets.push(s)
      s.on('error', () => undefined)
    })
    await new Promise<void>((r) => silentSrv.listen(27_471, '127.0.0.1', () => r()))
    const silent: OutboundConfig = { ...live, id: 'ob_silent', name: 'Silent', port: 27_471 }
    const { SidecarManager } = await import('./SidecarManager')
    const autos: { a: AutoInfo; t: number }[] = []
    const logs: string[] = []
    const t0 = Date.now()
    const m = new SidecarManager(
      (e) => logs.push(e.message),
      () => undefined,
      () => undefined,
      (a) => autos.push({ a, t: Date.now() - t0 })
    )
    try {
      await m.start({
        outbounds: [silent, live],
        activeOutboundId: 'auto',
        rules: TEST_RULES,
        settings: { ...TEST_SETTINGS, httpPort: HTTP_PORT },
        // the silent node first, as if it had been the fastest last time
        latencies: { ob_silent: 10, ob_live: 50 }
      })
      const done = await waitFor(
        () => autos.at(-1)!.a,
        (a) => !a.checking,
        45_000
      )
      console.log('auto check done after', autos.at(-1)!.t, 'ms')
      expect(done).toMatchObject({ checking: false, dead: false, nodeId: 'ob_live' })
      expect(logs.some((l) => l.startsWith('Ни один сервер не ответил'))).toBe(false)
    } finally {
      await m.stop()
      for (const s of sockets) s.destroy()
      silentSrv.close()
    }
  }, 90_000)

  it('xray dials the pre-resolved node IP from dns.hosts (no system DNS for the node)', async () => {
    const { generateXrayConfig } = await import('./xrayGen')
    // a name no DNS server knows: the request only works through the pin
    const pinned: OutboundConfig = { ...live, id: 'ob_pin', server: 'cw-node.invalid' }
    const cfgPath = join(tmp, 'xray-pin.json')
    const port = 27_441
    writeFileSync(
      cfgPath,
      JSON.stringify(
        generateXrayConfig([{ outbound: pinned, port }], {
          serverIps: { 'cw-node.invalid': ['127.0.0.1'] }
        })
      )
    )
    const x = spawn(XRAY, ['run', '-c', cfgPath], { windowsHide: true })
    try {
      await sleep(1200)
      const code = await curl([
        '-s',
        '-o',
        'NUL',
        '-w',
        '%{http_code}',
        '-x',
        `socks5h://127.0.0.1:${port}`,
        '--max-time',
        '10',
        'https://www.gstatic.com/generate_204'
      ])
      expect(code).toBe('204')
    } finally {
      x.kill()
    }
  }, 30_000)

  it('TUN config with real DNS answers passes sing-box check (route_exclude_address)', async () => {
    const { generateSingboxConfig } = await import('./configGen')
    const { resolveServers } = await import('../system/resolve')
    const { groupsFor, layoutRules, planRules } = await import('../rules/compile')
    const node: OutboundConfig = { ...live, server: 'www.gstatic.com', port: 443 }
    const ips = await resolveServers([node])
    expect(ips['www.gstatic.com']?.length).toBeGreaterThan(0)
    const dir = join(tmp, 'tun-check-rules')
    mkdirSync(dir, { recursive: true })
    const plan = planRules(TEST_RULES, [node])
    const layout = layoutRules(plan, groupsFor(plan), new Map())!
    for (const [f, t] of Object.entries(layout.files)) writeFileSync(join(dir, f), t)
    const cfg = generateSingboxConfig({
      outbounds: [node],
      activeOutboundId: 'auto',
      slots: { groups: groupsFor(plan), dir, selectors: layout.selectors },
      settings: { ...TEST_SETTINGS, proxyMode: 'tun' },
      socksPort: 1,
      httpPort: 2,
      clashApiPort: 3,
      logFile: 'l',
      xrayPorts: { [node.id]: 4 },
      serverIps: ips
    })
    const tun = cfg.inbounds[0] as { route_exclude_address?: string[] }
    expect(tun.route_exclude_address).toEqual(
      expect.arrayContaining([`${ips['www.gstatic.com'][0]}/32`])
    )
    const file = join(tmp, 'tun-check.json')
    writeFileSync(file, JSON.stringify(cfg))
    await new Promise<void>((res, rej) =>
      execFile(SINGBOX, ['check', '-c', file], { cwd: tmp, windowsHide: true }, (e, _o, err) =>
        e ? rej(new Error(String(err))) : res()
      )
    )
  }, 30_000)

  it('TUN broker (run without elevation): start, restart signal, crash report, stop', async () => {
    const { brokerScript } = await import('./broker')
    const { generateProbeConfig } = await import('./configGen')
    const { ClashApi } = await import('./clashApi')
    // Cyrillic in the path: Windows PowerShell 5.1 must read the script as UTF-8 (BOM)
    const dir = join(tmp, 'брокер')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const clashPort = 27_451
    const cfg = join(dir, 'sb.json')
    writeFileSync(
      cfg,
      JSON.stringify(
        generateProbeConfig({
          outbounds: [],
          clashApiPort: clashPort,
          logFile: join(dir, 'sb.log'),
          xrayPorts: {}
        })
      )
    )
    const f = (n: string) => join(dir, n)
    const ps1 = f('broker.ps1')
    writeFileSync(
      ps1,
      '\ufeff' +
        brokerScript({
          exe: SINGBOX,
          config: cfg,
          workDir: BIN,
          stopFile: f('stop.signal'),
          restartFile: f('restart.signal'),
          exitFile: f('core.exit'),
          parentPid: process.pid,
          tunName: E2E_TUN
        })
    )
    const broker = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      {
        windowsHide: true
      }
    )
    const api = new ClashApi(clashPort)
    const corePid = (): Promise<string> =>
      new Promise((res) =>
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "Name='${CORE_EXE}'" | Where-Object { $_.CommandLine -like '*${cfg.replace(/'/g, "''")}*' }).ProcessId`
          ],
          { windowsHide: true },
          (_e, out) => res(String(out).trim())
        )
      )
    try {
      expect(await waitFor(() => api.ping(), Boolean, 15_000)).toBe(true)
      const pid1 = await corePid()
      expect(pid1).toMatch(/^\d+$/)

      // restart signal → a fresh sing-box (this is the one TUN retry)
      writeFileSync(f('restart.signal'), '1')
      await waitFor(
        () => existsSync(f('restart.signal')),
        (v) => !v,
        10_000
      )
      await waitFor(
        () => corePid(),
        (p) => /^\d+$/.test(p) && p !== pid1,
        10_000
      )
      expect(await waitFor(() => api.ping(), Boolean, 15_000)).toBe(true)
      const pid2 = await corePid()
      expect(pid2).not.toBe(pid1)

      // sing-box dies on its own → the broker reports it in core.exit
      process.kill(Number(pid2))
      expect(await waitFor(() => existsSync(f('core.exit')), Boolean, 10_000)).toBe(true)

      // stop signal → broker exits and removes it
      writeFileSync(f('stop.signal'), '1')
      await waitFor(
        () => broker.exitCode,
        (c) => c !== null,
        10_000
      )
      expect(broker.exitCode).not.toBeNull()
      expect(existsSync(f('stop.signal'))).toBe(false)
    } finally {
      if (broker.exitCode === null) broker.kill()
      const pid = await corePid()
      if (/^\d+$/.test(pid)) process.kill(Number(pid))
    }
  }, 90_000)

  // --- 0.4.2 ---------------------------------------------------------------

  const rule = (
    conditionType: RoutingRule['conditionType'],
    value: string,
    action: string
  ): RoutingRule => ({
    id: `${conditionType}-${value}-${action}`,
    enabled: true,
    conditionType,
    value,
    action
  })

  /** a slow download through the mixed inbound → the live connection of curl.exe */
  async function curlConn(
    m: { clash: { connections: () => Promise<unknown> } | null },
    labels: () => Record<string, string>
  ) {
    const { toConnItems } = await import('./connections')
    const slow = curl([
      '-s',
      '-o',
      'NUL',
      '-x',
      `http://127.0.0.1:${HTTP_PORT}`,
      '--limit-rate',
      '20k',
      '--max-time',
      '4',
      'https://speed.cloudflare.com/__down?bytes=400000'
    ])
    const found = await waitFor(
      async () => {
        const raw = (await m.clash?.connections()) ?? {}
        return toConnItems(raw as never, {
          outbounds: [live, dead],
          prev: new Map(),
          now: Date.now(),
          labels: labels()
        }).find((i) => i.host === 'speed.cloudflare.com')
      },
      (c) => !!c && (c.route !== 'direct' || c.download > 0 || c.rule !== ''),
      8000
    )
    await slow
    return found
  }

  it('rules change on the fly: same sing-box process, new route; process names ignore case', async () => {
    const { SidecarManager } = await import('./SidecarManager')
    const states: StatusUpdate['state'][] = []
    const logs: string[] = []
    const m = new SidecarManager(
      (e) => logs.push(e.message),
      (s) => states.push(s),
      () => undefined
    )
    const params = (rules: RulesConfig) => ({
      outbounds: [live, dead],
      activeOutboundId: 'ob_live',
      rules,
      settings: { ...TEST_SETTINGS, httpPort: HTTP_PORT, routingMode: 'rule' as const }
    })
    // Koala-style lower/upper case: the process is curl.exe
    await m.start(
      params({ defaultBehavior: 'proxy', rules: [rule('ProcessName', 'CURL.EXE', 'DIRECT')] })
    )
    try {
      expect(states.at(-1)).toBe('connected')
      const pid = m.corePid
      expect(pid).toBeGreaterThan(0)

      const c1 = await curlConn(m, () => m.labels)
      expect(c1).toMatchObject({ route: 'direct', rule: 'программа CURL.EXE' })

      // the same program → through the VPN (a named server), applied without a restart
      await m.applyRules(
        params({ defaultBehavior: 'proxy', rules: [rule('ProcessName', 'Curl.Exe', 'Live')] })
      )
      expect(m.corePid).toBe(pid)
      const c2 = await curlConn(m, () => m.labels)
      expect(c2).toMatchObject({ route: 'proxy', serverName: 'Live', rule: 'программа Curl.Exe' })

      // first match wins: a DIRECT domain rule above the process rule
      await m.applyRules(
        params({
          defaultBehavior: 'proxy',
          rules: [
            rule('DomainSuffix', 'cloudflare.com', 'DIRECT'),
            rule('ProcessName', 'curl.exe', 'PROXY')
          ]
        })
      )
      expect(m.corePid).toBe(pid)
      const c3 = await curlConn(m, () => m.labels)
      expect(c3).toMatchObject({ route: 'direct', rule: 'домен cloudflare.com' })

      // only «Всё остальное» changes: a selector switch, still the same process
      await m.applyRules(params({ defaultBehavior: 'direct', rules: [] }))
      expect(m.corePid).toBe(pid)
      const c4 = await curlConn(m, () => m.labels)
      expect(c4).toMatchObject({ route: 'direct', rule: 'Всё остальное' })
      await m.applyRules(params({ defaultBehavior: 'proxy', rules: [] }))
      const c5 = await curlConn(m, () => m.labels)
      expect(c5).toMatchObject({ route: 'proxy', serverName: 'Live' })

      // REJECT: the request fails at once
      await m.applyRules(
        params({ defaultBehavior: 'proxy', rules: [rule('Domain', 'www.gstatic.com', 'REJECT')] })
      )
      const code = await curl([
        '-s',
        '-o',
        'NUL',
        '-w',
        '%{http_code}',
        '-x',
        `http://127.0.0.1:${HTTP_PORT}`,
        '--max-time',
        '4',
        'https://www.gstatic.com/generate_204'
      ])
      expect(code).not.toBe('204')
      expect(m.corePid).toBe(pid)
      expect(logs).toContain('Правила применены без переподключения')
      expect(states).not.toContain('error')
    } finally {
      await m.stop()
    }
  }, 90_000)

  it('a core that fails to start ends in «error» with its reason (not stuck «connecting»)', async () => {
    const { SidecarManager } = await import('./SidecarManager')
    const states: [StatusUpdate['state'], string | undefined][] = []
    const m = new SidecarManager(
      () => undefined,
      (s, msg) => states.push([s, msg]),
      () => undefined
    )
    const broken: OutboundConfig = {
      id: 'ob_bad',
      name: 'Bad',
      protocol: 'hysteria2',
      server: '127.0.0.1',
      port: 1,
      password: 'x',
      obfs: 'bogus'
    }
    await expect(
      m.start({
        outbounds: [broken],
        activeOutboundId: 'auto',
        rules: TEST_RULES,
        settings: { ...TEST_SETTINGS, httpPort: HTTP_PORT }
      })
    ).rejects.toThrow(/obfs/)
    expect(states.at(-1)?.[0]).toBe('error')
    expect(states.at(-1)?.[1]).toMatch(/^Ядро sing-box не запустилось: create service: .*obfs/)
    expect(m.isRunning).toBe(false)
  }, 60_000)

  it('one queue: parallel connects / rule changes never start two cores', async () => {
    const { SidecarManager } = await import('./SidecarManager')
    const states: StatusUpdate['state'][] = []
    const logs: string[] = []
    const m = new SidecarManager(
      (e) => logs.push(e.message),
      (s) => states.push(s),
      () => undefined
    )
    const p = {
      outbounds: [live, dead],
      activeOutboundId: 'auto',
      rules: TEST_RULES,
      settings: { ...TEST_SETTINGS, httpPort: HTTP_PORT }
    }
    try {
      await Promise.all([m.start(p), m.start(p), m.applyRules(p), m.start(p), m.applyRules(p)])
      expect(m.isRunning).toBe(true)
      const cmdLines = (exe: string): Promise<string> =>
        new Promise((res) =>
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine }`
            ],
            { windowsHide: true },
            (_e, out) => res(String(out))
          )
        )
      const count = (exe: string): Promise<number> =>
        new Promise((res) =>
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `@(Get-CimInstance Win32_Process -Filter "Name='${exe}'" | Where-Object { $_.CommandLine -like '*${join(tmp, 'run').replace(/'/g, "''")}*' }).Count`
            ],
            { windowsHide: true },
            (_e, out) => res(Number(String(out).trim()))
          )
        )
      const n = await count(CORE_EXE)
      if (n !== 1) console.log(await cmdLines(CORE_EXE))
      expect(n).toBe(1)
      expect(await count(XRAY_EXE)).toBe(1)
      expect(states.filter((s) => s === 'connected')).toHaveLength(1)
      expect(logs.filter((l) => l.startsWith('Запуск xray'))).toHaveLength(1)
      expect(logs.some((l) => /Не удалось запустить ядро Xray/.test(l))).toBe(false)
      // a stop issued while a start waits in the queue cancels it
      await m.stop()
      const queued = m.start(p)
      const stopping = m.stop()
      await Promise.all([queued, stopping])
      expect(m.isRunning).toBe(false)
      expect(states.at(-1)).toBe('disconnected')
      expect(states).not.toContain('error')
    } finally {
      await m.stop()
    }
  }, 90_000)

  describe('«Служба TUN» broker (run without elevation, temp folders)', () => {
    const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')
    const sid = 'S-1-5-21-1000000001-1000000002-1000000003-1001'
    const root = join(tmp, 'ProgramData', 'CipherWay')
    const home = join(root, 'u', sid)
    const userRun = join(tmp, 'пользователь', 'run')
    const clashPort = 27_461
    const f = (n: string) => join(home, n)

    // (not at collection time: the suite is skipped without CW_E2E)
    beforeAll(() => {
      for (const d of [join(root, 'bin'), join(home, 'rules'), join(userRun, 'rules')]) {
        mkdirSync(d, { recursive: true })
      }
    })

    async function broker(): Promise<ChildProcess> {
      const { serviceBrokerScript } = await import('./serviceScripts')
      for (const n of [CORE_EXE, 'wintun.dll']) {
        if (!existsSync(join(root, 'bin', n))) copyFileSync(join(BIN, n), join(root, 'bin', n))
      }
      const script = serviceBrokerScript({
        sid,
        userRunDir: userRun,
        hashes: { [CORE_EXE]: sha(SINGBOX), 'wintun.dll': sha(join(BIN, 'wintun.dll')) },
        rootOverride: root,
        tunName: E2E_TUN
      })
      writeFileSync(f('broker.ps1'), '\ufeff' + script)
      return spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f('broker.ps1')],
        {
          windowsHide: true
        }
      )
    }
    const state = () => {
      try {
        return JSON.parse(readFileSync(f('state.json'), 'utf8').replace(/^\ufeff/, ''))
      } catch {
        return null
      }
    }
    const ctl = (c: object) => writeFileSync(join(userRun, 'tun-ctl.json'), JSON.stringify(c))
    const goodConfig = () => ({
      log: { level: 'warn', output: f('sing-box.log'), timestamp: true },
      dns: { servers: [{ type: 'https', tag: 'local', server: '77.88.8.8' }], final: 'local' },
      experimental: {
        clash_api: { external_controller: `127.0.0.1:${clashPort}`, default_mode: 'Rule' }
      },
      inbounds: [],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: {
        rule_set: [
          {
            type: 'local',
            tag: 'cw-0-d',
            format: 'source',
            path: join(home, 'rules', 'cw-0-d.json')
          }
        ],
        rules: [{ rule_set: ['cw-0-d'], action: 'route', outbound: 'direct' }],
        final: 'direct'
      }
    })

    async function runOnce(
      config: object,
      ctlOver: object = {}
    ): Promise<{ status: string; error: string; corePid: number }> {
      writeFileSync(join(userRun, 'config.json'), JSON.stringify(config))
      writeFileSync(
        join(userRun, 'rules', 'cw-0-d.json'),
        JSON.stringify({ version: 3, rules: [] })
      )
      const session = randomBytes(16).toString('hex')
      ctl({
        session,
        pid: process.pid,
        cmd: 'run',
        restart: 0,
        rules: 0,
        ts: Date.now(),
        ...ctlOver
      })
      const b = await broker()
      await waitFor(
        () => b.exitCode,
        (c) => c !== null,
        20_000
      )
      if (b.exitCode === null) b.kill()
      const st = state()
      return { status: st?.status, error: st?.error ?? '', corePid: st?.corePid ?? 0 }
    }

    it('full cycle: validated copy, rules synced on request, restart, stop', async () => {
      const { ClashApi } = await import('./clashApi')
      writeFileSync(join(userRun, 'config.json'), JSON.stringify(goodConfig()))
      writeFileSync(
        join(userRun, 'rules', 'cw-0-d.json'),
        JSON.stringify({ version: 3, rules: [] })
      )
      const session = randomBytes(16).toString('hex')
      const c = { session, pid: process.pid, cmd: 'run', restart: 0, rules: 0, ts: Date.now() }
      ctl(c)
      const b = await broker()
      const api = new ClashApi(clashPort)
      try {
        const st = await waitFor(
          state,
          (s) => s?.session === session && s?.status === 'running',
          20_000
        )
        expect(st?.status).toBe('running')
        expect(await waitFor(() => api.ping(), Boolean, 15_000)).toBe(true)
        // the core runs the protected copy, not the user's file
        expect(readFileSync(f('config.json'), 'utf8')).toBe(
          readFileSync(join(userRun, 'config.json'), 'utf8')
        )
        expect(existsSync(f(join('rules', 'cw-0-d.json')))).toBe(true)

        // new rules: copied once asked (the core re-reads them itself)
        const next = JSON.stringify({ version: 3, rules: [{ domain: ['example.com'] }] })
        writeFileSync(join(userRun, 'rules', 'cw-0-d.json'), next)
        writeFileSync(join(userRun, 'rules', 'evil.json'), next) // wrong name: ignored
        writeFileSync(join(userRun, 'rules', 'cw-1-d.json'), 'not a rule-set') // wrong content: ignored
        ctl({ ...c, rules: 1 })
        expect((await waitFor(state, (s) => s?.rules === 1, 10_000))?.rules).toBe(1)
        expect(readFileSync(f(join('rules', 'cw-0-d.json')), 'utf8')).toBe(next)
        expect(existsSync(f(join('rules', 'evil.json')))).toBe(false)
        expect(existsSync(f(join('rules', 'cw-1-d.json')))).toBe(false)

        // restart on request: a new core process
        const pid1 = state()?.corePid
        ctl({ ...c, rules: 1, restart: 1 })
        const st2 = await waitFor(state, (s) => s?.restart === 1 && s?.status === 'running', 15_000)
        expect(st2?.corePid).not.toBe(pid1)
        expect(await waitFor(() => api.ping(), Boolean, 15_000)).toBe(true)

        // stop
        ctl({ ...c, rules: 1, restart: 1, cmd: 'stop' })
        await waitFor(
          () => b.exitCode,
          (x) => x !== null,
          10_000
        )
        expect(state()?.status).toBe('stopped')
        expect(await api.ping()).toBe(false)
      } finally {
        if (b.exitCode === null) b.kill()
      }
    }, 90_000)

    it('accepts the real TUN config the app generates for the service', async () => {
      const { generateSingboxConfig } = await import('./configGen')
      const { groupsFor, layoutRules, planRules } = await import('../rules/compile')
      const hy2: OutboundConfig = {
        id: 'ob_hy',
        name: 'HY2',
        protocol: 'hysteria2',
        server: 'hy.example.com',
        port: 8443,
        password: 'p',
        sni: 'hy.example.com',
        obfs: 'salamander',
        obfsPassword: 'o'
      }
      const vm: OutboundConfig = {
        id: 'ob_vm',
        name: 'VM',
        protocol: 'vmess',
        server: '198.51.100.9',
        port: 443,
        uuid: UUID,
        security: 'tls'
      }
      const nodes = [live, hy2, vm]
      const plan = planRules(TEST_RULES, nodes)
      const groups = groupsFor(plan)
      const layout = layoutRules(plan, groups, new Map())!
      for (const [name, text] of Object.entries(layout.files))
        writeFileSync(join(userRun, 'rules', name), text)
      const cfg = generateSingboxConfig({
        outbounds: nodes,
        activeOutboundId: 'auto',
        slots: { groups, dir: join(home, 'rules'), selectors: layout.selectors },
        settings: { ...TEST_SETTINGS, proxyMode: 'tun', verboseLog: true },
        socksPort: 1,
        httpPort: 2,
        clashApiPort: clashPort,
        clashSecret: randomBytes(16).toString('hex'),
        logFile: f('sing-box.log'),
        xrayPorts: { ob_live: 27_499 },
        serverIps: { 'hy.example.com': ['198.51.100.8'] }
      })
      writeFileSync(join(userRun, 'config.json'), JSON.stringify(cfg, null, 2))
      const session = randomBytes(16).toString('hex')
      const c = { session, pid: process.pid, cmd: 'run', restart: 0, rules: 0, ts: Date.now() }
      ctl(c)
      const b = await broker()
      try {
        // «running» = the config passed validation and the core was started (without
        // admin rights it then fails to open the TUN — that is expected here)
        const st = await waitFor(
          state,
          (s) => s?.session === session && s?.status !== 'starting',
          20_000
        )
        expect(st?.error ?? '').toBe('')
        expect(st?.status).toBe('running')
        expect(readdirSync(join(home, 'rules')).filter((n) => n.startsWith('cw-'))).toHaveLength(
          groups * 5
        )
      } finally {
        ctl({ ...c, cmd: 'stop' })
        await waitFor(
          () => b.exitCode,
          (x) => x !== null,
          10_000
        )
        if (b.exitCode === null) b.kill()
      }
    }, 60_000)

    it('refuses configs that would let the elevated core touch other files', async () => {
      const g = goodConfig()
      const bad: [string, object][] = [
        [
          'cache_file',
          {
            ...g,
            experimental: {
              ...g.experimental,
              cache_file: { enabled: true, path: 'C:\\Windows\\x.db' }
            }
          }
        ],
        [
          'external_ui',
          {
            ...g,
            experimental: {
              clash_api: { external_controller: `127.0.0.1:${clashPort}`, external_ui: 'C:\\' }
            }
          }
        ],
        [
          'clash on LAN',
          { ...g, experimental: { clash_api: { external_controller: `0.0.0.0:${clashPort}` } } }
        ],
        [
          'log elsewhere',
          { ...g, log: { level: 'warn', output: 'C:\\Windows\\System32\\evil.dll' } }
        ],
        [
          'rule-set outside',
          {
            ...g,
            route: {
              ...g.route,
              rule_set: [
                {
                  type: 'local',
                  tag: 'cw-0-d',
                  format: 'source',
                  path: join(userRun, 'rules', 'cw-0-d.json')
                }
              ]
            }
          }
        ],
        [
          'remote rule-set',
          {
            ...g,
            route: {
              ...g.route,
              rule_set: [
                { type: 'remote', tag: 'cw-0-d', format: 'binary', url: 'https://x/y.srs' }
              ]
            }
          }
        ],
        [
          'mixed inbound',
          { ...g, inbounds: [{ type: 'mixed', tag: 'm', listen: '0.0.0.0', listen_port: 1080 }] }
        ],
        [
          'tls certificate',
          {
            ...g,
            outbounds: [
              { type: 'direct', tag: 'direct' },
              {
                type: 'hysteria2',
                tag: 'h',
                server: 'x',
                server_port: 1,
                tls: { enabled: true, certificate_path: 'C:\\secret.pem' }
              }
            ]
          }
        ],
        [
          'endpoints',
          { ...g, endpoints: [{ type: 'tailscale', tag: 't', state_directory: 'C:\\' }] }
        ],
        [
          'hosts dns',
          {
            ...g,
            dns: {
              servers: [
                { type: 'hosts', tag: 'h', path: ['C:\\Windows\\System32\\drivers\\etc\\hosts'] }
              ]
            }
          }
        ]
      ]
      for (const [name, cfg] of bad) {
        const res = await runOnce(cfg)
        expect(res.status, name).toBe('error')
        // no core was started for it
        expect(res.corePid, name).toBe(0)
        expect(res.error, name).not.toBe('')
      }
    }, 180_000)

    it('a stale or foreign request is refused', async () => {
      expect((await runOnce(goodConfig(), { ts: Date.now() - 10 * 60_000 })).status).toBe('refused')
      expect((await runOnce(goodConfig(), { pid: 999_999_999 })).status).toBe('refused')
      expect((await runOnce(goodConfig(), { cmd: 'stop' })).status).toBe('refused')
    }, 60_000)

    it('the task XML is accepted by Task Scheduler (validate only — nothing is registered)', async () => {
      const { taskXml } = await import('./serviceScripts')
      const esc = (v: string) =>
        v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      const xml = taskXml()
        .replace('$PsX', esc('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
        .replace('$BrokerX', esc(f('broker.ps1')))
        .replace('$DirX', esc(home))
      const xmlFile = join(tmp, 'task.xml')
      writeFileSync(xmlFile, xml, 'utf8')
      const ps = join(tmp, 'validate-task.ps1')
      writeFileSync(
        ps,
        '\ufeff' +
          [
            `$xml = [IO.File]::ReadAllText('${xmlFile.replace(/'/g, "''")}')`,
            "$svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()",
            // 1 = TASK_VALIDATE_ONLY
            `try { $null = $svc.GetFolder('\\').RegisterTask('CipherWay e2e validate', $xml, 1, $null, $null, 5, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;${sid})'); 'VALID' } catch { 'ERR ' + $_.Exception.Message }`
          ].join('\r\n')
      )
      const out = await new Promise<string>((res) =>
        execFile(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps],
          { windowsHide: true },
          (_e, o) => res(String(o).trim())
        )
      )
      expect(out).toBe('VALID')
    }, 30_000)

    // --- 0.4.3: the first TUN start ------------------------------------------

    it('a core that dies at the start: code, time and its FATAL reach the state file', async () => {
      // a real TUN config, without admin rights: sing-box exits, its FATAL only on stderr
      const { generateSingboxConfig } = await import('./configGen')
      const { groupsFor, layoutRules, planRules } = await import('../rules/compile')
      const plan = planRules(TEST_RULES, [])
      const groups = groupsFor(plan)
      const layout = layoutRules(plan, groups, new Map())!
      for (const [name, text] of Object.entries(layout.files))
        writeFileSync(join(userRun, 'rules', name), text)
      const cfg = generateSingboxConfig({
        outbounds: [],
        activeOutboundId: 'auto',
        slots: { groups, dir: join(home, 'rules'), selectors: layout.selectors },
        settings: { ...TEST_SETTINGS, proxyMode: 'tun' },
        socksPort: 1,
        httpPort: 2,
        clashApiPort: clashPort,
        clashSecret: 'e2e',
        logFile: f('sing-box.log'),
        xrayPorts: {}
      })
      writeFileSync(join(userRun, 'config.json'), JSON.stringify(cfg, null, 2))
      const session = randomBytes(16).toString('hex')
      const c = { session, pid: process.pid, cmd: 'run', restart: 0, rules: 0, ts: Date.now() }
      ctl(c)
      const b = await broker()
      try {
        const st = await waitFor(
          state,
          (s) => s?.session === session && typeof s?.exitCode === 'number',
          30_000
        )
        expect(st.status).toBe('running') // the broker stays for a restart request
        expect(st.exitCode).not.toBe(0)
        expect(typeof st.uptimeMs).toBe('number')
        expect(st.stderr).toMatch(/FATAL/)
        expect(readFileSync(f('broker.log'), 'utf8')).toMatch(/ядро завершилось само: код /)
      } finally {
        ctl({ ...c, cmd: 'stop' })
        await waitFor(
          () => b.exitCode,
          (x) => x !== null,
          10_000
        )
        if (b.exitCode === null) b.kill()
      }
      expect(state()?.stopReason).toBe('команда остановки')
    }, 60_000)

    it('one unreadable moment of the request file does not stop the core', async () => {
      const { ClashApi } = await import('./clashApi')
      writeFileSync(join(userRun, 'config.json'), JSON.stringify(goodConfig()))
      const session = randomBytes(16).toString('hex')
      const c = { session, pid: process.pid, cmd: 'run', restart: 0, rules: 0, ts: Date.now() }
      ctl(c)
      const b = await broker()
      const api = new ClashApi(clashPort)
      try {
        await waitFor(state, (s) => s?.session === session && s?.status === 'running', 20_000)
        expect(await waitFor(() => api.ping(), Boolean, 15_000)).toBe(true)
        const pid = state()?.corePid
        // the file disappears for a second (the 0.4.2 broker killed the core on the first miss)
        rmSync(join(userRun, 'tun-ctl.json'))
        await sleep(1000)
        ctl(c)
        await sleep(1000)
        expect(b.exitCode).toBeNull()
        expect(state()?.status).toBe('running')
        expect(state()?.corePid).toBe(pid)
        expect(await api.ping()).toBe(true)
      } finally {
        ctl({ ...c, cmd: 'stop' })
        await waitFor(
          () => b.exitCode,
          (x) => x !== null,
          10_000
        )
        if (b.exitCode === null) b.kill()
      }
    }, 60_000)

    it('first TUN start through the service: the core dies → one automatic retry → connected', async () => {
      const { SidecarManager } = await import('./SidecarManager')
      const { ServiceLauncher } = await import('./tunService')
      let brokerProc: ChildProcess | null = null
      let brokersStarted = 0
      const logs: string[] = []
      const states: StatusUpdate['state'][] = []
      /** a broker without elevation; a TUN-less config from the retry on (no admin rights here) */
      class Fake extends ServiceLauncher {
        override async restartCore(): Promise<void> {
          const file = join(userRun, 'config.json')
          const cfg = JSON.parse(readFileSync(file, 'utf8'))
          writeFileSync(file, JSON.stringify({ ...cfg, inbounds: [] }, null, 2))
          fakeAdapter.up = true
          await super.restartCore()
        }
      }
      const m = new SidecarManager(
        (e) => logs.push(e.message),
        (s) => states.push(s),
        () => undefined,
        undefined,
        undefined,
        undefined,
        {
          launcherFactory: async (_paths, cancelled) =>
            new Fake(
              {
                binDir: BIN,
                runDir: userRun,
                configPath: join(userRun, 'config.json'),
                rulesDir: join(userRun, 'rules'),
                logPath: f('sing-box.log')
              },
              {
                home,
                task: 'e2e',
                log: () => undefined,
                isCancelled: cancelled,
                runTask: async () => {
                  // like the real task: only one instance at a time
                  if (!brokerProc || brokerProc.exitCode !== null) {
                    brokersStarted++
                    brokerProc = await broker()
                  }
                  return { code: 0, out: '' }
                }
              }
            )
        }
      )
      // SidecarManager writes into <userData>\run: the broker of this test reads from there
      Object.defineProperty(m, 'runDir', { get: () => userRun })
      Object.defineProperty(m, 'rulesDir', { get: () => join(userRun, 'rules') })
      try {
        await m.start({
          outbounds: [live],
          activeOutboundId: 'ob_live',
          rules: TEST_RULES,
          settings: { ...TEST_SETTINGS, proxyMode: 'tun', routingMode: 'global' }
        })
        expect(states.at(-1)).toBe('connected')
        expect(m.isRunning).toBe(true)
        const retries = logs.filter((l) => /^Ядро завершилось при создании адаптера/.test(l))
        expect(retries).toHaveLength(1)
        expect(retries[0]).toMatch(
          /^Ядро завершилось при создании адаптера \(код -?\d+, через [\d,]+ с\), повторяем$/
        )
        // what sing-box printed reached the journal
        expect(logs.some((l) => /FATAL/.test(l))).toBe(true)
        // the retry went to the same broker: the task was not started anew
        expect(brokersStarted).toBe(1)
        expect(states).not.toContain('error')
      } finally {
        fakeAdapter.up = false
        await m.stop()
        await waitFor(
          () => brokerProc?.exitCode ?? null,
          (x) => x !== null,
          10_000
        )
        if (brokerProc && (brokerProc as ChildProcess).exitCode === null)
          (brokerProc as ChildProcess).kill()
      }
    }, 120_000)
  })

  // --- 0.4.3 ---------------------------------------------------------------

  async function code204(): Promise<string> {
    return curl([
      '-s',
      '-o',
      'NUL',
      '-w',
      '%{http_code}',
      '-x',
      `http://127.0.0.1:${HTTP_PORT}`,
      '--max-time',
      '6',
      'https://www.gstatic.com/generate_204'
    ])
  }

  describe('cores dying while connected', () => {
    const params = {
      outbounds: [live, dead],
      activeOutboundId: 'ob_live',
      rules: TEST_RULES,
      settings: { ...TEST_SETTINGS, httpPort: HTTP_PORT, routingMode: 'global' as const }
    }

    async function connected() {
      const { SidecarManager } = await import('./SidecarManager')
      const logs: { level: string; message: string }[] = []
      const states: [StatusUpdate['state'], string | undefined][] = []
      const notices: string[] = []
      const m = new SidecarManager(
        (e) => logs.push(e),
        (s, msg) => states.push([s, msg]),
        () => undefined,
        undefined,
        undefined,
        undefined,
        { onNotice: (n) => notices.push(n.text) }
      )
      await m.start(params)
      return { m, logs, states, notices }
    }

    it('the binaries have our own names; a kill of xray → restarted, traffic flows, sing-box untouched', async () => {
      expect(existsSync(join(BIN, 'sing-box.exe'))).toBe(false)
      expect(existsSync(join(BIN, 'xray.exe'))).toBe(false)
      const { m, logs, states, notices } = await connected()
      try {
        expect(await code204()).toBe('204')
        const core = m.corePid
        const x1 = m.xrayPid!
        // what `taskkill /f` of another VPN client does to it
        process.kill(x1)
        await waitFor(
          () => notices,
          (n) => n.includes('Ядро перезапущено'),
          10_000
        )
        expect(notices).toEqual(['Ядро перезапущено'])
        expect(m.xrayPid).toBeGreaterThan(0)
        expect(m.xrayPid).not.toBe(x1)
        expect(m.corePid).toBe(core) // no sing-box restart: the ports stayed
        expect(await waitFor(code204, (c) => c === '204', 10_000)).toBe('204')
        expect(m.isRunning).toBe(true)
        expect(states.map((s) => s[0])).not.toContain('error')
        expect(logs.some((l) => /Ядро Xray остановилось \(код \d+\) — перезапуск/.test(l.message))).toBe(true)
      } finally {
        await m.stop()
      }
    }, 60_000)

    it('a kill of sing-box → restarted through the queue, xray untouched, selection kept', async () => {
      const { m, states, notices } = await connected()
      try {
        const x = m.xrayPid
        const c1 = m.corePid!
        process.kill(c1)
        await waitFor(
          () => notices,
          (n) => n.includes('Ядро перезапущено'),
          15_000
        )
        expect(m.corePid).toBeGreaterThan(0)
        expect(m.corePid).not.toBe(c1)
        expect(m.xrayPid).toBe(x)
        expect(await m.clash!.groupNow('proxy')).toBe('ob_live')
        expect(await m.clash!.getMode()).toBe('Global')
        expect(await waitFor(code204, (c) => c === '204', 10_000)).toBe('204')
        expect(states.map((s) => s[0])).not.toContain('error')
      } finally {
        await m.stop()
      }
    }, 60_000)

    it('xray can\'t come back: after 3 tries an honest error with its own start failure', async () => {
      const { m, states, notices, logs } = await connected()
      try {
        // the next start fails by itself, with a message from xray
        writeFileSync(join(tmp, 'run', 'xray.json'), '{ not json')
        const t0 = Date.now()
        process.kill(m.xrayPid!)
        await waitFor(
          () => states.at(-1)?.[0],
          (s) => s === 'error',
          30_000
        )
        // 1 + 3 + 5 s of pauses
        expect(Date.now() - t0).toBeGreaterThan(8500)
        const msg = states.at(-1)?.[1] ?? ''
        expect(msg).toMatch(/^Ядро Xray остановилось \(код \d+\) и не перезапустилось/)
        expect(msg).toContain('Failed to start')
        expect(msg).not.toContain('REALITY')
        expect(notices).toEqual([])
        expect(m.isRunning).toBe(false)
        expect(logs.filter((l) => /попытка \d из 3/.test(l.message))).toHaveLength(3)
      } finally {
        await m.stop()
      }
    }, 60_000)

    it('a stop while a dead core waits for its restart cancels the restart', async () => {
      const { m, states } = await connected()
      process.kill(m.xrayPid!)
      await sleep(200)
      await m.stop()
      await sleep(1500)
      expect(states.at(-1)?.[0]).toBe('disconnected')
      expect(m.xrayPid).toBeUndefined()
      expect(m.corePid).toBeUndefined()
    }, 30_000)
  })

  describe('first TUN start (fake broker)', () => {
    const tunParams = {
      outbounds: [live],
      activeOutboundId: 'ob_live',
      rules: TEST_RULES,
      settings: { ...TEST_SETTINGS, proxyMode: 'tun' as const }
    }

    it('no WARN is ever shown as the reason; one retry; code and time in the error', async () => {
      const { SidecarManager } = await import('./SidecarManager')
      const logFile = join(tmp, 'fake-core.log')
      let restarts = 0
      const launcher = {
        kind: 'service' as const,
        coreRuleDir: join(tmp, 'run', 'rules'),
        coreLogPath: logFile,
        launch: async () =>
          writeFileSync(
            logFile,
            '+0300 2026-11-05 16:58:40 WARN inbound/tun[tun-in]: open interface take too much time to finish!\n'
          ),
        restartCore: async () => {
          restarts++
        },
        syncRules: async () => undefined,
        exited: async () => true,
        exitInfo: async () => ({ code: 1, uptimeMs: 12_500, stderr: '' }),
        failure: () => null,
        stop: async () => undefined
      }
      const logs: string[] = []
      const states: [StatusUpdate['state'], string | undefined][] = []
      const m = new SidecarManager(
        (e) => logs.push(e.message),
        (s, msg) => states.push([s, msg]),
        () => undefined,
        undefined,
        undefined,
        undefined,
        { launcherFactory: async () => launcher }
      )
      await expect(m.start(tunParams)).rejects.toThrow(/не запустилось/)
      const [state, msg] = states.at(-1)!
      expect(state).toBe('error')
      expect(msg).toBe('Ядро sing-box не запустилось (код 1, через 12,5 с)')
      expect(msg).not.toMatch(/WARN|too much time/)
      expect(restarts).toBe(1)
      expect(logs).toContain(
        'Ядро завершилось при создании адаптера (код 1, через 12,5 с), повторяем'
      )
    }, 60_000)

    it('a stale core.exit is not an exit; the broker\'s report of this session is', async () => {
      const { LegacyLauncher } = await import('./tunService')
      const { generateProbeConfig } = await import('./configGen')
      const { ClashApi } = await import('./clashApi')
      const dir = join(tmp, 'legacy-stale')
      mkdirSync(dir, { recursive: true })
      const clashPort = 27_481
      const cfgPath = join(dir, 'c.json')
      writeFileSync(
        cfgPath,
        JSON.stringify(
          generateProbeConfig({
            outbounds: [],
            clashApiPort: clashPort,
            logFile: join(dir, 'sb.log'),
            xrayPorts: {}
          })
        )
      )
      // left by 0.4.2 or by an earlier session
      writeFileSync(join(dir, 'core.exit'), '1')
      writeFileSync(join(dir, 'core-0123456789abcdef.exit'), '{"code":1}')
      writeFileSync(join(dir, 'restart.signal'), '1')
      let proc: ChildProcess | null = null
      const l = new LegacyLauncher(
        { binDir: BIN, runDir: dir, configPath: cfgPath, rulesDir: dir, logPath: join(dir, 'sb.log') },
        () => undefined,
        () => false,
        {
          tunName: E2E_TUN,
          spawnBroker: (script) => {
            proc = spawn(
              'powershell.exe',
              ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
              { windowsHide: true }
            )
            return proc
          }
        }
      )
      await l.launch()
      try {
        expect(existsSync(join(dir, 'core.exit'))).toBe(false)
        expect(existsSync(join(dir, 'core-0123456789abcdef.exit'))).toBe(false)
        expect(existsSync(join(dir, 'restart.signal'))).toBe(false)
        const api = new ClashApi(clashPort)
        expect(await waitFor(() => api.ping(), Boolean, 15_000)).toBe(true)
        // an old broker still finishing writes its report late: not ours
        writeFileSync(join(dir, 'core.exit'), '1')
        expect(await l.exited()).toBe(false)
        expect(await l.exitInfo()).toBeNull()

        const out = await new Promise<string>((res) =>
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "Name='${CORE_EXE}'" | Where-Object { $_.CommandLine -like '*${cfgPath.replace(/'/g, "''")}*' }).ProcessId`
            ],
            { windowsHide: true },
            (_e, o) => res(String(o).trim())
          )
        )
        expect(out).toMatch(/^\d+$/)
        process.kill(Number(out))
        expect(await waitFor(() => l.exited(), Boolean, 10_000)).toBe(true)
        const info = await l.exitInfo()
        expect(typeof info?.code).toBe('number')
        expect(typeof info?.uptimeMs).toBe('number')

        // restart signal → a new core, the report is gone
        await l.restartCore()
        expect(await waitFor(() => api.ping(), Boolean, 15_000)).toBe(true)
        expect(await l.exited()).toBe(false)
      } finally {
        await l.stop()
        await waitFor(
          () => (proc as ChildProcess | null)?.exitCode ?? null,
          (x) => x !== null,
          10_000
        )
      }
    }, 90_000)

    it('the FATAL of a core started by the broker gets into the error (real stderr, no elevation)', async () => {
      const { SidecarManager } = await import('./SidecarManager')
      const { LegacyLauncher } = await import('./tunService')
      const procs: ChildProcess[] = []
      const dir = join(tmp, 'legacy-fatal')
      mkdirSync(dir, { recursive: true })
      const states: [StatusUpdate['state'], string | undefined][] = []
      const logs: string[] = []
      const m = new SidecarManager(
        (e) => logs.push(e.message),
        (s, msg) => states.push([s, msg]),
        () => undefined,
        undefined,
        undefined,
        undefined,
        {
          launcherFactory: async (paths, cancelled) =>
            new LegacyLauncher(paths, () => undefined, cancelled, {
              tunName: E2E_TUN,
              spawnBroker: (script) => {
                const p = spawn(
                  'powershell.exe',
                  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
                  { windowsHide: true }
                )
                procs.push(p)
                return p
              }
            })
        }
      )
      try {
        // TUN without admin rights: sing-box exits at once, twice
        await expect(m.start(tunParams)).rejects.toThrow()
        const msg = states.at(-1)?.[1] ?? ''
        expect(states.at(-1)?.[0]).toBe('error')
        expect(msg).toMatch(/^Ядро sing-box не запустилось: /)
        expect(msg).not.toMatch(/WARN/)
        expect(logs.filter((l) => /повторяем$/.test(l))).toHaveLength(1)
      } finally {
        await m.stop()
        for (const p of procs) {
          await waitFor(
            () => p.exitCode,
            (x) => x !== null,
            10_000
          )
          if (p.exitCode === null) p.kill()
        }
      }
    }, 120_000)
  })

  describe('update from 0.4.2: the service', () => {
    const sid = 'S-1-5-21-1000000001-1000000002-1000000003-2002'
    const root = join(tmp, 'pd-update', 'CipherWay')
    const home = join(root, 'u', sid)
    const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')

    function runScript(path: string): Promise<number | null> {
      return new Promise((res) => {
        const p = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path],
          { windowsHide: true }
        )
        p.on('exit', (c) => res(c))
      })
    }

    it('«outdated» → one install: new files, old ones gone, a foreign sing-box.exe left alone', async () => {
      const { TunService } = await import('./tunService')
      const { installScript } = await import('./serviceScripts')
      const { generateProbeConfig } = await import('./configGen')
      for (const d of [join(root, 'bin'), join(home, 'rules')]) mkdirSync(d, { recursive: true })
      // what 0.4.2 left: the old file (running!), its manifest
      const oldExe = join(root, 'bin', 'sing-box.exe')
      copyFileSync(SINGBOX, oldExe)
      copyFileSync(join(BIN, 'wintun.dll'), join(root, 'bin', 'wintun.dll'))
      writeFileSync(
        join(home, 'manifest.json'),
        JSON.stringify({
          version: 1,
          app: '0.4.2',
          broker: 'c'.repeat(64),
          files: { 'sing-box.exe': sha(SINGBOX), 'wintun.dll': sha(join(BIN, 'wintun.dll')) }
        })
      )
      // a sing-box.exe of another VPN client, elsewhere
      const otherDir = join(tmp, 'other-vpn')
      mkdirSync(otherDir, { recursive: true })
      const otherExe = join(otherDir, 'sing-box.exe')
      copyFileSync(SINGBOX, otherExe)
      const run = (exe: string, port: number): ChildProcess => {
        const cfg = join(tmp, `update-${port}.json`)
        writeFileSync(
          cfg,
          JSON.stringify(
            generateProbeConfig({
              outbounds: [],
              clashApiPort: port,
              logFile: join(tmp, `update-${port}.log`),
              xrayPorts: {}
            })
          )
        )
        return spawn(exe, ['run', '-c', cfg], { windowsHide: true })
      }
      const oldCore = run(oldExe, 27_491)
      const otherCore = run(otherExe, 27_492)
      const logs: string[] = []
      const svc = new TunService({
        binDir: BIN,
        runDir: join(tmp, 'run'),
        appVersion: '0.4.3',
        log: (_l, m) => logs.push(m),
        rootOverride: root,
        taskExists: async () => true,
        sidOverride: sid
      })
      try {
        await sleep(800)
        expect(oldCore.exitCode).toBeNull()
        expect((await svc.status()).state).toBe('outdated')

        const brokerText = await svc.brokerText(sid)
        const script = installScript({
          sid,
          srcBinDir: BIN,
          brokerText,
          hashes: { [CORE_EXE]: sha(SINGBOX), 'wintun.dll': sha(join(BIN, 'wintun.dll')) },
          brokerHash: createHash('sha256').update(brokerText, 'utf8').digest('hex'),
          appVersion: '0.4.3',
          testRoot: root
        })
        const path = join(tmp, 'install-test.ps1')
        writeFileSync(path, '\ufeff' + script)
        expect(await runScript(path)).toBe(0)

        expect(existsSync(join(root, 'bin', CORE_EXE))).toBe(true)
        expect(existsSync(oldExe)).toBe(false)
        await waitFor(
          () => oldCore.exitCode,
          (c) => c !== null,
          5000
        )
        expect(oldCore.exitCode).not.toBeNull()
        // not our file: never stopped, whatever its name
        expect(otherCore.exitCode).toBeNull()
        expect(existsSync(otherExe)).toBe(true)
        expect((await svc.status()).state).toBe('ok')
      } finally {
        if (oldCore.exitCode === null) oldCore.kill()
        if (otherCore.exitCode === null) otherCore.kill()
      }
    }, 90_000)

    it('every generated PowerShell script parses', async () => {
      const { brokerScript } = await import('./broker')
      const { installScript, serviceBrokerScript, uninstallScript } =
        await import('./serviceScripts')
      const hashes = { [CORE_EXE]: 'a'.repeat(64), 'wintun.dll': 'b'.repeat(64) }
      const service = serviceBrokerScript({ sid, userRunDir: 'C:\\r', hashes })
      const scripts: Record<string, string> = {
        service,
        legacy: brokerScript({
          exe: 'C:\\x.exe',
          config: 'C:\\c.json',
          workDir: 'C:\\',
          stopFile: 'C:\\s',
          restartFile: 'C:\\r',
          exitFile: 'C:\\e',
          parentPid: 1
        }),
        install: installScript({
          sid,
          srcBinDir: 'C:\\b',
          brokerText: service,
          hashes,
          brokerHash: 'c'.repeat(64),
          appVersion: '0.4.3'
        }),
        remove: uninstallScript(sid)
      }
      const dir = join(tmp, 'parse')
      mkdirSync(dir, { recursive: true })
      for (const [name, text] of Object.entries(scripts)) {
        const file = join(dir, `${name}.ps1`)
        writeFileSync(file, '\ufeff' + text)
        const out = await new Promise<string>((res) =>
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count`
            ],
            { windowsHide: true },
            (_e, o) => res(String(o).trim())
          )
        )
        expect(out, name).toBe('0')
      }
    }, 30_000)
  })

  describe('the subscription follows the panel', () => {
    const REAL_PORT = 27_501
    const SUB_PORT = 27_502
    let realityServer: ChildProcess | null = null
    let httpServer: HttpServer | null = null
    let goodKey = ''
    let staleKey = ''
    let body = ''

    const link = (name: string, key: string): string =>
      `vless://${UUID}@[::1]:${REAL_PORT}?security=reality&encryption=none&flow=xtls-rprx-vision&type=tcp&pbk=${key}&sid=ab12&sni=www.cloudflare.com&fp=chrome#${encodeURIComponent(name)}`
    const AUTO_HOST = `vless://${UUID}@10.255.255.1:443?security=none&type=tcp#${encodeURIComponent('⚡ Автовыбор')}`
    const serve = (...links: string[]): void => {
      body = Buffer.from(links.join('\n')).toString('base64')
    }

    beforeAll(async () => {
      const keys = () => {
        const out = execFileSync(XRAY, ['x25519'], { encoding: 'utf8', windowsHide: true })
        return {
          priv: /PrivateKey:\s*(\S+)/.exec(out)![1],
          pub: /Password[^:]*:\s*(\S+)/.exec(out)![1]
        }
      }
      const a = keys()
      goodKey = a.pub
      staleKey = keys().pub
      const cfg = join(tmp, 'reality-server.json')
      writeFileSync(
        cfg,
        JSON.stringify({
          log: { loglevel: 'warning' },
          inbounds: [
            {
              listen: '::1',
              port: REAL_PORT,
              protocol: 'vless',
              settings: { clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: 'none' },
              streamSettings: {
                network: 'raw',
                security: 'reality',
                realitySettings: {
                  dest: 'www.cloudflare.com:443',
                  serverNames: ['www.cloudflare.com'],
                  privateKey: a.priv,
                  shortIds: ['ab12']
                }
              }
            }
          ],
          outbounds: [FREEDOM]
        })
      )
      realityServer = spawn(XRAY, ['run', '-c', cfg], { windowsHide: true })
      httpServer = createHttpServer((_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'profile-update-interval': '6',
          'profile-title': 'e2e'
        })
        res.end(body)
      })
      await new Promise<void>((r) => httpServer!.listen(SUB_PORT, '127.0.0.1', () => r()))
      await sleep(800)
    })

    afterAll(() => {
      realityServer?.kill()
      httpServer?.close()
    })

    /** Everything handlers.ts wires together, around the real client and the real cores. */
    async function app() {
      const { SidecarManager } = await import('./SidecarManager')
      const { RemnawaveClient } = await import('../remnawave/RemnawaveClient')
      const { SubscriptionSync } = await import('../remnawave/SubscriptionSync')
      const rw = new RemnawaveClient()
      const logs: string[] = []
      const states: StatusUpdate['state'][] = []
      const hints: Record<string, string>[] = []
      const params = () => ({
        outbounds: rw.getCached()?.outbounds ?? [],
        activeOutboundId: (memory.get('activeOutboundId') as string | null) ?? undefined,
        rules: TEST_RULES,
        settings: { ...TEST_SETTINGS, httpPort: HTTP_PORT, routingMode: 'global' as const },
        latencies: {}
      })
      const m = new SidecarManager(
        (e) => logs.push(e.message),
        (s) => states.push(s),
        () => undefined,
        undefined,
        undefined,
        undefined,
        {
          onRealityHeal: () => void sync.heal().finally(() => m.realityHealDone()),
          onServerHints: (h) => hints.push(h)
        }
      )
      const sync = new SubscriptionSync({
        url: () => (memory.get('url') as string | null) ?? null,
        fetch: (url, t) => rw.fetchSubscription(url, t),
        cached: () => rw.getCached(),
        getActive: () => (memory.get('activeOutboundId') as string | null) ?? null,
        setActive: (id) => void memory.set('activeOutboundId', id),
        getLatencies: () => ({}),
        setLatencies: () => undefined,
        settingHours: () => 12,
        applyToCore: () => m.reload(params()),
        activeChanged: () => undefined,
        log: (_l, msg) => logs.push(msg),
        notify: () => undefined
      })
      return { m, rw, sync, logs, states, hints, params }
    }

    function reset(cached: string[]): void {
      memory.clear()
      memory.set('url', `http://127.0.0.1:${SUB_PORT}/sub`)
      memory.set('subscriptionCache', {
        url: '',
        fetchedAt: 1,
        outbounds: parseOutboundsSync(cached)
      })
    }
    let parseOutboundsSync: (l: string[]) => OutboundConfig[] = () => []
    beforeAll(async () => {
      const { parseOutbounds } = await import('../remnawave/parsers')
      parseOutboundsSync = (l) => parseOutbounds(l.join('\n'))
    })

    it('before a connect: new key picked up, «⚡ Автовыбор» hidden, selection by name, interval from the panel', async () => {
      // the cache of ≤0.4.2: ids from the whole link, an old key
      reset([link('Германия', staleKey)])
      const cache = memory.get('subscriptionCache') as { outbounds: OutboundConfig[] }
      cache.outbounds[0].id = 'ob_old_hash'
      memory.set('activeOutboundId', 'ob_old_hash')
      serve(AUTO_HOST, link('Германия', goodKey))

      const { m, rw, sync, states, params } = await app()
      await sync.beforeConnect()
      const data = rw.getCached()!
      expect(data.outbounds.map((o) => o.name)).toEqual(['Германия'])
      expect(data.updateIntervalHours).toBe(6)
      expect(memory.get('activeOutboundId')).toBe(data.outbounds[0].id)

      await m.start(params())
      try {
        expect(states.at(-1)).toBe('connected')
        const xcfg = readFileSync(join(tmp, 'run', 'xray.json'), 'utf8')
        expect(xcfg).toContain(goodKey)
        expect(xcfg).not.toContain(staleKey)
        const cfg = JSON.parse(readFileSync(join(tmp, 'run', 'config.json'), 'utf8'))
        const auto = cfg.outbounds.find((o: { tag: string }) => o.tag === 'auto')
        expect(auto.outbounds).toEqual([data.outbounds[0].id])
        expect(await waitFor(code204, (c) => c === '204', 15_000)).toBe('204')
      } finally {
        await m.stop()
      }
    }, 90_000)

    it('the subscription can\'t be fetched: the connect goes on with the saved copy', async () => {
      reset([link('Германия', goodKey)])
      memory.set('url', 'http://127.0.0.1:1/nothing-listens-here')
      const { m, sync, logs, states, params } = await app()
      await sync.beforeConnect()
      expect(logs.at(-1)).toMatch(/сохранённой копии/)
      await m.start(params())
      try {
        expect(states.at(-1)).toBe('connected')
        expect(await waitFor(code204, (c) => c === '204', 15_000)).toBe('204')
      } finally {
        await m.stop()
      }
    }, 60_000)

    it('REALITY error with a stale key: the subscription is fetched, the core restarted, traffic flows', async () => {
      reset([link('Германия', staleKey)])
      serve(AUTO_HOST, link('Германия', goodKey))
      const { m, rw, logs, states, params } = await app()
      memory.set('activeOutboundId', rw.getCached()!.outbounds[0].id)
      await m.start(params()) // on purpose without beforeConnect: the stale key is in use
      try {
        expect(states.at(-1)).toBe('connected')
        const code = await waitFor(code204, (c) => c === '204', 30_000)
        expect(code).toBe('204')
        expect(logs.some((l) => /Сервер ответил чужим сертификатом/.test(l))).toBe(true)
        expect(logs.some((l) => /Перезапуск ядра с новой конфигурацией/.test(l))).toBe(true)
        expect(readFileSync(join(tmp, 'run', 'xray.json'), 'utf8')).toContain(goodKey)
        // the lines were collapsed, not repeated
        expect(logs.filter((l) => /REALITY: received real certificate/.test(l)).length).toBeLessThan(4)
      } finally {
        await m.stop()
      }
    }, 90_000)

    it('the error stays after the refresh → a hint on exactly that server', async () => {
      reset([link('Германия', staleKey), link('Голландия', staleKey)])
      // the panel doesn't know better
      serve(link('Германия', staleKey), link('Голландия', staleKey))
      const { m, rw, hints, logs, params } = await app()
      const [de, nl] = rw.getCached()!.outbounds
      memory.set('activeOutboundId', de.id)
      await m.start(params())
      try {
        const res = await waitFor(
          async () => {
            await code204()
            return hints.at(-1) ?? {}
          },
          (h) => !!h[de.id],
          60_000
        )
        expect(res[de.id]).toContain('другой сервер')
        expect(res[nl.id]).toBeUndefined()
        expect(logs.filter((l) => /проверяем подписку/.test(l))).toHaveLength(1)
        // no restart: nothing changed
        expect(logs.some((l) => /Перезапуск ядра/.test(l))).toBe(false)
      } finally {
        await m.stop()
      }
    }, 120_000)

    it('a change while connected: restart without a word from the user, selection survives or falls to auto', async () => {
      reset([link('Германия', goodKey), link('Голландия', goodKey)])
      serve(link('Германия', goodKey), link('Голландия', goodKey))
      const { m, rw, sync, logs, states, params } = await app()
      const [de, nl] = rw.getCached()!.outbounds
      memory.set('activeOutboundId', nl.id)
      await m.start(params())
      try {
        const pid = m.corePid
        // nothing new: the core is left alone
        expect((await sync.refresh()).changed).toBe(false)
        await sleep(300)
        expect(m.corePid).toBe(pid)

        // «Голландия» is gone → «Лучший сервер»
        serve(link('Германия', goodKey))
        expect((await sync.refresh()).changed).toBe(true)
        expect(memory.get('activeOutboundId')).toBe('auto')
        await waitFor(
          () => m.corePid !== pid && m.isRunning,
          Boolean,
          30_000
        )
        expect(m.isRunning).toBe(true)
        expect(await m.clash!.groupNow('proxy')).toBe('auto')
        expect(de.id).toBe(rw.getCached()!.outbounds[0].id)
        expect(logs.some((l) => /больше нет в подписке/.test(l))).toBe(true)
        expect(states.at(-1)).toBe('connected')
        expect(states).not.toContain('error')
      } finally {
        await m.stop()
      }
    }, 90_000)
  })
})
