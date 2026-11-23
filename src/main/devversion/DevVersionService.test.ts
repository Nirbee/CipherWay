import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DevLastUpload, DevVersionConsent } from '@shared/devversion'
import type { OutboundConfig } from '@shared/types'
import { createMasker } from '../mask'
import type { RawConnections } from '../core/connections'
import { DEFAULT_CONFIG, TelemetryError, type TelemetryApi } from './api'
import { DevVersionService, type ManagerView } from './DevVersionService'
import { gunzipAsync } from './uploader'

const SUB = 'https://sub.example.com/api/sub/SecretToken1234'
const NODES = [
  {
    id: 'ob_1',
    name: 'Нидерланды',
    protocol: 'vless',
    server: 'nl.node.example',
    port: 443,
    uuid: '1b2c3d4e-1111-4222-8333-123456789abc'
  }
] as OutboundConfig[]

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-devsvc-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function setup(
  opts: { tun?: boolean; running?: boolean; directHosts?: string[]; uploadError?: Error } = {}
) {
  let consent: DevVersionConsent | null = null
  let last: DevLastUpload | null = null
  const uploads: Buffer[] = []
  let deletes = 0
  const api = {
    config: async () => ({ ...DEFAULT_CONFIG }),
    upload: async (b: Uint8Array) => {
      if (opts.uploadError) throw opts.uploadError
      uploads.push(Buffer.from(b))
      return '1'
    },
    deleteAll: async () => {
      deletes++
      return 3
    }
  } as unknown as TelemetryApi
  const manager: ManagerView = {
    isRunning: opts.running ?? false,
    proxyMode: opts.tun ? 'tun' : 'system',
    clash: null,
    directHosts: opts.directHosts ?? [],
    socksFor: () => undefined,
    activeNodeId: async () => null,
    failures: { list: () => [] }
  }
  let reloads = 0
  const svc = new DevVersionService({
    dir,
    appVersion: '0.6.0',
    getConsent: () => consent,
    setConsent: (c) => (consent = c),
    getLastUpload: () => last,
    setLastUpload: (u) => (last = u),
    api,
    apiHost: () => 'cabinet.example.com',
    manager,
    outbounds: () => NODES,
    hidden: () => new Set(['nl.node.example']),
    mask: () => createMasker({ outbounds: NODES, subscriptionUrl: SUB }),
    proxyMode: () => (opts.tun ? 'tun' : 'system'),
    coreExe: join(dir, 'none-core.exe'),
    xrayExe: join(dir, 'none-xray.exe'),
    log: () => undefined,
    onDirectHostsChange: async () => void reloads++
  })
  return {
    svc,
    uploads,
    consent: () => consent,
    deletes: () => deletes,
    reloads: () => reloads
  }
}

const snap = (up: number): RawConnections => ({
  connections: [
    {
      id: 'c1',
      metadata: {
        network: 'tcp',
        destinationIP: '142.250.1.1',
        destinationPort: '443',
        host: `www.youtube.com`,
        processPath: 'C:\\Users\\Ivan\\AppData\\Local\\Yandex\\browser.exe'
      },
      upload: up,
      download: up * 10,
      chains: ['ob_1']
    },
    {
      id: 'c2',
      metadata: {
        network: 'tcp',
        destinationIP: '1.1.1.1',
        destinationPort: '443',
        host: 'nl.node.example'
      },
      upload: 1,
      download: 1,
      chains: ['direct']
    }
  ]
})

describe('DevVersionService', () => {
  it('enable: consent stored with a NEW uuid v4 each time; the bot host goes direct', async () => {
    const t = setup()
    await expect(t.svc.enable('0')).rejects.toThrow()
    expect(t.consent()).toBeNull()
    const st = await t.svc.enable('1')
    expect(st.enabled).toBe(true)
    const first = t.consent()!
    expect(first.install_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(first.consent_version).toBe('1')
    expect(t.reloads()).toBe(1)
    await t.svc.disable(false)
    await t.svc.enable('1')
    expect(t.consent()!.install_id).not.toBe(first.install_id)
    await t.svc.disable(false)
  })

  it('collects only while on; «Отправить сейчас» sends a masked report of the period', async () => {
    const t = setup()
    t.svc.onConnections(snap(1)) // off: ignored
    await t.svc.enable('1')
    for (let i = 1; i <= 6; i++) t.svc.onConnections(snap(i * 100)) // every 3rd snapshot is taken
    t.svc.onCoreLine(
      'singbox',
      'ERROR [1 5s] connection: open connection to 149.154.167.41:443 using outbound/direct[direct]: dial tcp 149.154.167.41:443: i/o timeout'
    )
    const st = t.svc.status()
    expect(st.accumulated.processes).toBe(1)
    expect(st.accumulated.events).toBe(1)
    await t.svc.sendNow()
    expect(t.uploads.length).toBe(1)
    const body = JSON.parse((await gunzipAsync(t.uploads[0])).toString()) as Record<string, unknown>
    const text = JSON.stringify(body)
    expect(body.schema).toBe(1)
    expect(body.install_id).toBe(t.consent()!.install_id)
    expect(text).toContain('www.youtube.com')
    expect(text).toContain('vpn:Нидерланды')
    expect(text).toContain('direct_timeout')
    for (const secret of ['SecretToken1234', 'nl.node.example', 'Ivan', '1b2c3d4e-1111']) {
      expect(text).not.toContain(secret)
    }
    // the period starts over after a report
    expect(t.svc.status().accumulated.processes).toBe(0)
    await t.svc.disable(false)
  })

  it("TUN without the bot host in the core's direct rules: the report waits (never through the VPN)", async () => {
    const t = setup({ tun: true, running: true, directHosts: ['sub.example.com'] })
    await t.svc.enable('1')
    for (let i = 1; i <= 3; i++) t.svc.onConnections(snap(i * 100))
    await expect(t.svc.sendNow()).rejects.toThrow(/напрямую/)
    expect(t.uploads.length).toBe(0)
    expect(t.svc.status().waitingDirect).toBe(true)
    expect(t.svc.status().queue.reports).toBe(1)
    await t.svc.disable(false)

    const ok = setup({ tun: true, running: true, directHosts: ['cabinet.example.com'] })
    await ok.svc.enable('1')
    for (let i = 1; i <= 3; i++) ok.svc.onConnections(snap(i * 100))
    await ok.svc.sendNow()
    expect(ok.uploads.length).toBe(1)
    await ok.svc.disable(false)
  })

  it('403 subscription_inactive: paused with a status text', async () => {
    const t = setup({ uploadError: new TelemetryError('inactive', 403) })
    await t.svc.enable('1')
    for (let i = 1; i <= 3; i++) t.svc.onConnections(snap(i * 100))
    await t.svc.sendNow()
    const st = t.svc.status()
    expect(st.paused).toMatch(/Подписка не активна/)
    expect(st.lastUpload?.ok).toBe(false)
    expect(st.queue.reports).toBe(1)
    await t.svc.disable(false)
  })

  it('disable: the queue and the pending file are deleted; optionally the server data too', async () => {
    const t = setup({ uploadError: new TelemetryError('network') })
    await t.svc.enable('1')
    for (let i = 1; i <= 3; i++) t.svc.onConnections(snap(i * 100))
    await t.svc.sendNow()
    expect((await readdir(join(dir, 'queue'))).length).toBe(1)
    const res = await t.svc.disable(true)
    expect(res.deleted).toBe(3)
    expect(t.deletes()).toBe(1)
    expect(t.consent()).toBeNull()
    expect(await readdir(dir)).toEqual([])
    expect(t.svc.status().enabled).toBe(false)
    // off: nothing is collected
    t.svc.onConnections(snap(5))
    expect(t.svc._period.conns.procs.size).toBe(0)
  })

  it('«Тест игры»: records only that program, then the result joins the report', async () => {
    const t = setup()
    await t.svc.enable('1')
    t.svc.gameStart('game.exe')
    // a local closed port: the direct check fails at once, no real network in the test
    const game = (b: number): RawConnections => ({
      connections: [
        {
          id: 'g1',
          metadata: {
            network: 'tcp',
            destinationIP: '127.0.0.1',
            destinationPort: '9',
            host: 'lobby.game.example',
            processPath: 'C:\\Games\\game.exe'
          },
          upload: b,
          download: b,
          chains: ['direct']
        },
        ...(snap(b).connections ?? [])
      ]
    })
    for (let i = 1; i <= 3; i++) t.svc.onConnections(game(i * 100))
    const v = t.svc.gameStop()
    expect(v.gameTest?.process).toBe('game.exe')
    // probing runs in the background (VPN off: direct checks only)
    for (let i = 0; i < 50 && t.svc.stats().gameTest?.phase !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(t.svc.stats().gameTest?.phase).toBe('done')
    const g = t.svc._period.gameTests[0]
    expect(g.process).toBe('game.exe')
    expect(g.flows.map((f) => f.host)).toEqual(['lobby.game.example'])
    expect(g.checks).toEqual([
      expect.objectContaining({ host: '127.0.0.1', port: 9, net: 'tcp', vpn: null })
    ])
    expect(g.checks[0].direct?.ok).toBe(false)
    await t.svc.disable(false)
  }, 15_000)
})
