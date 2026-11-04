// End-to-end check of SidecarManager against the real cores (opt-in):
//   CW_E2E=1 npx vitest run src/main/core/sidecar.e2e.test.ts
// Needs resources/bin (sing-box.exe + xray.exe) and internet access (the
// latency probe fetches gstatic.com/generate_204). The "live" node is a local
// xray VLESS server on 127.0.0.1, the "dead" one points at a closed port. The
// Windows system proxy is mocked — the registry is never touched.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OutboundConfig, StatusUpdate } from '@shared/types'
import { TEST_RULES, TEST_SETTINGS } from './fixtures'

const tmp = mkdtempSync(join(tmpdir(), 'cw-e2e-'))

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmp } }))
vi.mock('../system/proxy', () => ({
  enableSystemProxy: vi.fn(async () => undefined),
  disableSystemProxy: vi.fn(async () => undefined)
}))

const BIN = resolve(__dirname, '../../../resources/bin')
const XRAY = join(BIN, 'xray.exe')
const enabled =
  !!process.env.CW_E2E && existsSync(join(BIN, 'sing-box.exe')) && existsSync(XRAY)

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

let server: ChildProcess | null = null

function curl(args: string[]): Promise<string> {
  return new Promise((res) =>
    execFile('curl', args, { timeout: 20_000, windowsHide: true }, (_e, out) => res(String(out)))
  )
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
    await new Promise((r) => setTimeout(r, 800))
  })

  afterAll(() => {
    server?.kill()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('latency while disconnected: temporary cores, live answers, dead does not', async () => {
    const { SidecarManager } = await import('./SidecarManager')
    const m = new SidecarManager(() => undefined, () => undefined, () => undefined)
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
    let autoNow: string | undefined
    const m = new SidecarManager(
      () => undefined,
      (s) => states.push(s),
      () => undefined,
      (id) => (autoNow = id)
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
      await new Promise((r) => setTimeout(r, 2500))
      const raw = await api.connections()
      const items = toConnItems(raw ?? {}, { outbounds: [live, dead], prev: new Map(), now: Date.now() })
      const c = items.find((i) => i.host === 'speed.cloudflare.com')
      expect(c).toMatchObject({ route: 'proxy', serverName: 'Live' })
      expect(c?.process?.toLowerCase()).toBe('curl.exe')
      expect(c?.rule).toBe('Режим «Весь трафик через VPN»')

      // «Напрямую»
      expect(await m.setRoutingMode('direct')).toBe(true)
      expect(await api.getMode()).toBe('Direct')
      await slow
      void autoNow
    } finally {
      await m.stop()
    }
    expect(states.at(-1)).toBe('disconnected')
    expect(m.clash).toBeNull()
  }, 60_000)
})
