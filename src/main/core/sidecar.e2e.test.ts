// End-to-end check of SidecarManager against the real cores (opt-in):
//   CW_E2E=1 npx vitest run src/main/core/sidecar.e2e.test.ts
// Needs resources/bin (sing-box.exe + xray.exe) and internet access (the
// latency probe fetches gstatic.com/generate_204). The "live" node is a local
// xray VLESS server on 127.0.0.1, the "dead" one points at a closed port, the
// "blackhole" one at a non-routable address (times out like a node that is
// blocked from Russia). The Windows system proxy is mocked — the registry is
// never touched. TUN itself needs UAC and is not started here; the TUN broker
// runs non-elevated with a TUN-less sing-box config.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AutoInfo, OutboundConfig, ServerPing, StatusUpdate } from '@shared/types'
import { TEST_RULES, TEST_SETTINGS } from './fixtures'

const tmp = mkdtempSync(join(tmpdir(), 'cw-e2e-'))

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmp } }))
vi.mock('../system/proxy', () => ({
  enableSystemProxy: vi.fn(async () => undefined),
  disableSystemProxy: vi.fn(async () => undefined)
}))

const BIN = resolve(__dirname, '../../../resources/bin')
const XRAY = join(BIN, 'xray.exe')
const SINGBOX = join(BIN, 'sing-box.exe')
const enabled = !!process.env.CW_E2E && existsSync(SINGBOX) && existsSync(XRAY)

const UUID = '0b6f7c1e-3a7d-4c55-9a51-6f2f1b0d9e11' // random, local test server only
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
  name: '⚡ Автовыбор',
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
        outbounds: [{ protocol: 'freedom' }]
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
      // subscription order: the dead «⚡ Автовыбор» first, as in the real subscription
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
    const node: OutboundConfig = { ...live, server: 'www.gstatic.com', port: 443 }
    const ips = await resolveServers([node])
    expect(ips['www.gstatic.com']?.length).toBeGreaterThan(0)
    const cfg = generateSingboxConfig({
      outbounds: [node],
      activeOutboundId: 'auto',
      rules: TEST_RULES,
      settings: { ...TEST_SETTINGS, proxyMode: 'tun' },
      socksPort: 1,
      httpPort: 2,
      clashApiPort: 3,
      logFile: 'l',
      cacheFile: 'c',
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
          parentPid: process.pid
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
            `(Get-CimInstance Win32_Process -Filter "Name='sing-box.exe'" | Where-Object { $_.CommandLine -like '*${cfg.replace(/'/g, "''")}*' }).ProcessId`
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
})
