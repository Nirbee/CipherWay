import { describe, expect, it } from 'vitest'
import type { OutboundConfig } from '@shared/types'
import { createMasker } from '../mask'
import {
  buildReport,
  clampMetrics,
  fitReport,
  gameTestOut,
  jsonBytes,
  maskIps,
  Period,
  sanitizeReport,
  shapeOf,
  tunnelSummary,
  type TunnelSample
} from './report'

const SUB = 'https://sub.example.com/api/sub/AbCdEfGh12345678'
const UUID = '1b2c3d4e-1111-4222-8333-123456789abc'
const NODES = [
  {
    id: 'ob_1',
    name: 'Нидерланды',
    protocol: 'vless',
    server: 'nl.node.example',
    port: 443,
    uuid: UUID,
    publicKey: 'Zq3xRk8vWp2LmN5tY7uB9cD1eF4gH6jK0lM3nO5pQ7s'
  },
  {
    id: 'ob_2',
    name: 'Германия',
    protocol: 'hysteria2',
    server: '203.0.113.7',
    port: 443,
    password: 'hy2-secret-pass'
  }
] as OutboundConfig[]

const META = {
  consentVersion: '1',
  installId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  appVersion: '0.6.0',
  os: { build: '19045.5131', edition: 'Professional' },
  mode: 'tun' as const,
  system: { ipv6: true },
  now: Date.parse('2026-11-23T12:00:00Z')
}

const ka = (t: number, ms: number | null): TunnelSample => ({
  t,
  ms,
  node: 'Нидерланды',
  protocol: 'vless',
  method: 'keepalive'
})

function filled(): Period {
  const p = new Period()
  p.from = Date.parse('2026-11-23T11:00:00Z')
  const conn = (id: string, host: string, ip: string, chain: string, down: number) => ({
    id,
    metadata: {
      network: 'tcp',
      destinationIP: ip,
      destinationPort: '443',
      host,
      processPath: 'C:\\Users\\Ivan\\AppData\\Local\\Yandex\\browser.exe'
    },
    upload: 10,
    download: down,
    chains: [chain],
    rule: 'final'
  })
  p.conns.ingest(
    {
      connections: [
        conn('a', 'www.youtube.com', '142.250.1.1', 'ob_1', 5000),
        conn('b', 'blocked.example', '93.184.216.34', 'direct', 0)
      ]
    },
    NODES,
    new Set(),
    1000
  )
  // b closed without an answer while going direct
  p.conns.ingest(
    { connections: [conn('a', 'www.youtube.com', '142.250.1.1', 'ob_1', 6000)] },
    NODES,
    new Set(),
    4000
  )
  p.events.note('reality', 'Нидерланды', '', 1000)
  p.addNodeDelay('Нидерланды', 'vless', 80)
  p.addNodeDelay('Нидерланды', 'vless', null)
  p.addNodeTcp('Германия', 'hysteria2', null, 'udp_protocol')
  p.addTunnel(ka(1, 50))
  p.addTunnel(ka(2, 2500))
  p.addSkip('dns', 'tun_dns_hijacked')
  p.addProbe({
    type: 'target',
    t: 'x',
    target: 'sub.example.com',
    group: 'sub',
    port: 443,
    route: 'direct',
    ok: false,
    latency_ms: null,
    loss_pct: 100,
    failures: 1,
    method: 'plain',
    // something that must never leave: the link with its token, a UUID
    error: `${SUB} ${UUID} password=hy2-secret-pass`
  })
  return p
}

describe('DevVersion report (schema 1, field names of the bot summaries)', () => {
  it('has the contract fields', () => {
    const r = buildReport(filled(), { ...META, drops: 2 })
    expect(Object.keys(r).sort()).toEqual(
      [
        'app_version',
        'apps',
        'consent_version',
        'events',
        'game_tests',
        'install_id',
        'mode',
        'nodes',
        'os',
        'period',
        'probes',
        'schema',
        'system'
      ].sort()
    )
    expect(r.schema).toBe(1)
    expect(r.period).toEqual({ from: '2026-11-23T11:00:00.000Z', to: '2026-11-23T12:00:00.000Z' })
    const apps = r.apps as Record<string, unknown>[]
    expect(apps[0]).toMatchObject({ name: 'browser.exe', direct_failures: 1 })
    expect((apps[0].via as Record<string, unknown>)['vpn:Нидерланды']).toEqual({
      up: 10,
      down: 6000,
      conns: 1
    })
    const domains = apps[0].domains as Record<string, unknown>[]
    expect(domains.find((d) => d.domain === 'www.youtube.com')).toMatchObject({
      direct_failures: 0
    })
    expect(domains.find((d) => d.domain === 'blocked.example')).toMatchObject({
      direct_failures: 1
    })
    const nodes = r.nodes as Record<string, unknown>[]
    expect(nodes.find((n) => n.node === 'Нидерланды' && n.kind === 'tile')).toMatchObject({
      protocol: 'vless',
      latency_ms: 80,
      loss_pct: 50,
      ok: true,
      failures: 1
    })
    expect(nodes.find((n) => n.node === 'Германия')).toMatchObject({
      method: 'tcp_direct',
      skipped: 'udp_protocol'
    })
    expect(nodes.find((n) => n.kind === 'tunnel')).toMatchObject({
      node: 'Нидерланды',
      protocol: 'vless',
      stalls: 1,
      drops: 2,
      ok: true,
      failures: 0
    })
    expect((r.probes as Record<string, unknown>[])[0]).toMatchObject({
      target: 'sub.example.com',
      route: 'direct',
      ok: false,
      failures: 1
    })
    expect((r.system as Record<string, unknown>).probe_skips).toEqual({ dns: 'tun_dns_hijacked' })
  })

  it('log failures of the core count into the program and its domain', () => {
    const r = buildReport(filled(), {
      ...META,
      directFailures: [{ host: 'blocked.example', port: '443', count: 4, process: 'browser.exe' }]
    })
    const app = (r.apps as Record<string, unknown>[])[0]
    expect(app.direct_failures).toBe(5)
    const d = (app.domains as Record<string, unknown>[]).find((x) => x.domain === 'blocked.example')
    expect(d?.direct_failures).toBe(5)
  })

  it('tunnel summary: latency (p50) / p95 / loss / stalls', () => {
    const s = tunnelSummary([ka(1, 40), ka(2, 60), ka(3, null), ka(4, 3000)])
    expect(s).toMatchObject({
      samples: 4,
      failures: 1,
      ok: true,
      latency_ms: 60,
      p95_ms: 3000,
      loss_pct: 25,
      stalls: 1
    })
    expect(tunnelSummary([])).toBeNull()
  })

  it('«Тест игры» → one record per route with game / ok / failures / latency', () => {
    const recs = gameTestOut({
      started_at: 'x',
      duration_s: 300,
      process: 'rainbowsix.exe',
      mode: 'tun',
      node: 'Нидерланды',
      protocol: 'vless',
      flows: [],
      checks: [
        {
          host: '1.2.3.4',
          port: 443,
          net: 'tcp',
          direct: { ok: true, ms: 30 },
          vpn: { ok: true, ms: 90 }
        },
        {
          host: '1.2.3.5',
          port: 443,
          net: 'tcp',
          direct: { ok: false, ms: null },
          vpn: { ok: true, ms: 70 }
        },
        {
          host: '1.2.3.6',
          port: 6015,
          net: 'udp',
          direct: null,
          vpn: null,
          skipped: 'udp_no_generic_probe'
        }
      ]
    })
    expect(recs[0]).toMatchObject({
      game: 'rainbowsix.exe',
      route: 'direct',
      ok: true,
      failures: 1,
      loss_pct: 50,
      latency_ms: 30
    })
    expect(recs[1]).toMatchObject({
      route: 'vpn',
      node: 'Нидерланды',
      failures: 0,
      loss_pct: 0,
      latency_ms: 70
    })
    expect(recs[0].checks).toBeDefined()
    expect(recs[1].checks).toBeUndefined()
  })

  it('masking: link / token, UUID, password, key, node host, user and PC name, local and own IPs', () => {
    const mask = createMasker({ outbounds: NODES, subscriptionUrl: SUB })
    const r = buildReport(filled(), {
      ...META,
      system: {
        note: `C:\\Users\\Ivan\\Desktop pc DESKTOP-IVAN7 key Zq3xRk8vWp2LmN5tY7uB9cD1eF4gH6jK0lM3nO5pQ7s nl.node.example:443`,
        log: 'dial 192.168.1.10:5353 from 10.0.0.2, lan 100.101.5.6, tun 172.19.0.1, v6 fe80::1c2b:3a4d and fd7a:115c:a1e0::5, me 95.24.11.7',
        keep: 'public 8.8.8.8 and 149.154.167.41'
      }
    })
    const clean = sanitizeReport(r, {
      mask,
      personal: ['Ivan', 'DESKTOP-IVAN7'],
      ownIps: ['95.24.11.7', '192.168.1.10']
    })
    const text = JSON.stringify(clean)
    for (const secret of [
      'AbCdEfGh12345678',
      UUID,
      'hy2-secret-pass',
      'Zq3xRk8vWp2LmN5tY7uB9cD1eF4gH6jK0lM3nO5pQ7s',
      'nl.node.example',
      'Ivan',
      'DESKTOP-IVAN7',
      '192.168.1.10',
      '10.0.0.2',
      '100.101.5.6',
      '172.19.0.1',
      'fe80::1c2b',
      'fd7a:115c',
      '95.24.11.7'
    ]) {
      expect(text).not.toContain(secret)
    }
    const sys = clean.system as Record<string, string>
    expect(sys.log).toBe(
      'dial <own-ip>:5353 from <private-ip>, lan <lan-ip>, tun <private-ip>, v6 <local-ip6> and <local-ip6>, me <own-ip>'
    )
    // public destinations stay: they are what the report is about
    expect(sys.keep).toBe('public 8.8.8.8 and 149.154.167.41')
    expect(text).toContain('%USERPROFILE%')
    expect(clean.install_id).toBe(META.installId)
    expect(clean.consent_version).toBe('1')
    expect(text).toContain('www.youtube.com')
  })

  it('IP masking leaves versions / builds alone', () => {
    expect(maskIps('build 19045.5131, sing-box 1.13.14, ip 10.1.2.3')).toBe(
      'build 19045.5131, sing-box 1.13.14, ip <private-ip>'
    )
  })

  it('metric bounds: failures ≤ 1000, latency / jitter ≤ 60 000, loss 0…100', () => {
    const o = {
      nodes: [{ failures: 5000, latency_ms: 90_000, jitter_ms: 70_000, loss_pct: 130 }],
      apps: [{ direct_failures: 2000, domains: [{ direct_failures: 1500 }] }],
      x: { loss_pct: -3 }
    }
    clampMetrics(o)
    expect(o).toEqual({
      nodes: [{ failures: 1000, latency_ms: 60_000, jitter_ms: 60_000, loss_pct: 100 }],
      apps: [{ direct_failures: 1000, domains: [{ direct_failures: 1000 }] }],
      x: { loss_pct: 0 }
    })
  })

  it('size limits: ≤ max bytes and ≤ 200 000 values; long tails are cut; null when nothing can', () => {
    const p = new Period()
    const conns = []
    for (let a = 0; a < 80; a++) {
      for (let i = 0; i < 150; i++) {
        conns.push({
          id: `${a}-${i}`,
          metadata: {
            network: 'tcp',
            destinationIP: `93.${a}.${i >> 8}.${i & 255}`,
            destinationPort: '443',
            host: `host-${i}.app${a}.example.com`,
            processPath: `C:\\Games\\app${a}.exe`
          },
          upload: i,
          download: i * 3,
          chains: ['direct']
        })
      }
    }
    p.conns.ingest({ connections: conns }, [], new Set(), 1000)
    const r = buildReport(p, META)
    expect(jsonBytes(r)).toBeGreaterThan(512 * 1024)
    expect(shapeOf(r).values).toBeGreaterThan(200_000)
    const fit = fitReport(r, 512 * 1024)!
    expect(fit).not.toBeNull()
    expect(jsonBytes(fit)).toBeLessThanOrEqual(512 * 1024)
    expect(shapeOf(fit).values).toBeLessThanOrEqual(200_000)
    expect(shapeOf(fit).depth).toBeLessThanOrEqual(10)
    expect(fit.truncated).toBe(true)
    expect(fit.install_id).toBe(META.installId)
    expect(fitReport(r, 100)).toBeNull()
    // already small: unchanged
    const small = buildReport(new Period(), META)
    expect(fitReport(small, 512 * 1024)).toBe(small)
  })

  it('app_version is what the server takes', () => {
    expect(buildReport(new Period(), { ...META, appVersion: '0.6.0 beta/1' }).app_version).toBe(
      '0.6.0beta1'
    )
  })
})
