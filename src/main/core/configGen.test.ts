import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/types'
import { parseOutbounds } from '../remnawave/parsers'
import { filterSubscription } from '../remnawave/subscriptionGuard'
import {
  buildOutbound,
  generateProbeConfig,
  generateSingboxConfig,
  groupOutbounds,
  serverDomains
} from './configGen'
import { buildXrayOutbound, generateXrayConfig, isXrayHandled, type XrayBridge } from './xrayGen'
import { MIXED_SUB_BODY, TEST_RULES, TEST_SETTINGS } from './fixtures'

const outbounds = filterSubscription(parseOutbounds(MIXED_SUB_BODY)).outbounds
const [vlessA, vlessB, hy2] = outbounds
const bridges: XrayBridge[] = [
  { outbound: vlessA, port: 20101 },
  { outbound: vlessB, port: 20102 }
]
const xrayPorts = { [vlessA.id]: 20101, [vlessB.id]: 20102 }

function singbox(settings: Partial<AppSettings> = {}) {
  return generateSingboxConfig({
    outbounds,
    activeOutboundId: vlessA.id,
    rules: TEST_RULES,
    settings: { ...TEST_SETTINGS, ...settings },
    socksPort: 10808,
    httpPort: 10809,
    clashApiPort: 19090,
    logFile: 'sing-box.log',
    cacheFile: 'cache.db',
    xrayPorts
  })
}

describe('mixed subscription fixture', () => {
  it('parses 2 VLESS + 1 Hysteria2', () => {
    expect(outbounds.map((o) => o.protocol)).toEqual(['vless', 'vless', 'hysteria2'])
    expect(outbounds.filter(isXrayHandled)).toHaveLength(2)
    expect(vlessA.encryption).toBe('none')
  })
})

describe('generateXrayConfig', () => {
  const cfg = generateXrayConfig(bridges)

  it('one loopback SOCKS inbound per VLESS node, UDP on, no auth', () => {
    expect(cfg.inbounds).toHaveLength(2)
    for (const [i, inb] of cfg.inbounds.entries()) {
      expect(inb).toMatchObject({
        listen: '127.0.0.1',
        port: bridges[i].port,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true, ip: '127.0.0.1' }
      })
    }
  })

  it('routes each inbound to its own VLESS outbound; default is blackhole', () => {
    expect(cfg.outbounds[0]).toEqual({ tag: 'block', protocol: 'blackhole' })
    expect(cfg.routing.rules).toEqual([
      { type: 'field', inboundTag: [`in-${vlessA.id}`], outboundTag: `out-${vlessA.id}` },
      { type: 'field', inboundTag: [`in-${vlessB.id}`], outboundTag: `out-${vlessB.id}` }
    ])
  })

  it('builds VLESS + REALITY + vision with the link fingerprint', () => {
    expect(buildXrayOutbound(vlessA)).toEqual({
      tag: `out-${vlessA.id}`,
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: 'nl.example.com',
            port: 443,
            users: [
              {
                id: '11111111-2222-4333-8444-555555555555',
                encryption: 'none',
                flow: 'xtls-rprx-vision'
              }
            ]
          }
        ]
      },
      streamSettings: {
        network: 'raw',
        security: 'reality',
        realitySettings: {
          serverName: 'www.example.org',
          fingerprint: 'firefox',
          publicKey: '4hqL4-CvFAFMKy-sTIDBSJ5O19YzUFGMfGJYw8GWKCU',
          shortId: 'ab12cd34',
          spiderX: '/'
        }
      }
    })
    const b = buildXrayOutbound(vlessB) as { streamSettings: { realitySettings: object } }
    expect(b.streamSettings.realitySettings).toMatchObject({ fingerprint: 'qq', shortId: '0f' })
  })

  it('refuses non-VLESS outbounds', () => {
    expect(() => buildXrayOutbound(hy2)).toThrow()
  })
})

describe('generateSingboxConfig with xray bridges', () => {
  it('VLESS nodes become socks outbounds to the xray ports, Hysteria2 stays native', () => {
    const cfg = singbox()
    const byTag = Object.fromEntries(cfg.outbounds.map((o) => [o.tag, o]))
    expect(byTag[vlessA.id]).toEqual({
      type: 'socks',
      tag: vlessA.id,
      server: '127.0.0.1',
      server_port: 20101,
      version: '5'
    })
    expect(byTag[vlessB.id]).toMatchObject({ type: 'socks', server_port: 20102 })
    expect(byTag[hy2.id]).toMatchObject({
      type: 'hysteria2',
      server: 'hy.example.com',
      server_port: 8443,
      obfs: { type: 'salamander', password: 'obfs-pass' }
    })
    expect(byTag.direct).toEqual({ type: 'direct', tag: 'direct' })
    // unmatched traffic goes to the selector, which defaults to the active node
    expect(cfg.route.final).toBe('proxy')
    expect(byTag.proxy).toMatchObject({ type: 'selector', default: vlessA.id })
  })

  it('throws if a VLESS node has no xray port', () => {
    expect(() => buildOutbound(vlessA)).toThrow()
  })

  it('resolves node hostnames via the direct DNS server (IP literals skipped)', () => {
    expect(serverDomains(outbounds)).toEqual(['nl.example.com', 'hy.example.com'])
    const rules = (singbox().dns as { rules: object[] }).rules
    expect(rules[0]).toEqual({ domain: ['nl.example.com', 'hy.example.com'], server: 'local' })
  })

  it('never sets a DNS detour to the empty direct outbound (sing-box refuses to start)', () => {
    const servers = (singbox().dns as { servers: { tag: string; detour?: string }[] }).servers
    expect(servers.find((s) => s.tag === 'local')?.detour).toBeUndefined()
    expect(servers.find((s) => s.tag === 'remote')?.detour).toBe('proxy')
    const direct = generateSingboxConfig({
      ...{ outbounds, activeOutboundId: vlessA.id, settings: TEST_SETTINGS, xrayPorts },
      rules: { defaultBehavior: 'direct', rules: [] },
      socksPort: 0,
      httpPort: 1,
      clashApiPort: 2,
      logFile: 'l',
      cacheFile: 'c'
    })
    const ds = (direct.dns as { servers: { detour?: string }[] }).servers
    expect(ds.every((s) => s.detour === undefined)).toBe(true)
  })

  it('TUN mode: xray.exe goes direct before anything else (no loop)', () => {
    const cfg = singbox({ proxyMode: 'tun' })
    expect(cfg.route.rules[0]).toEqual({
      process_name: ['xray.exe'],
      action: 'route',
      outbound: 'direct'
    })
    expect(cfg.route.auto_detect_interface).toBe(true)
    expect(cfg.inbounds[0]).toMatchObject({ type: 'tun', auto_route: true, strict_route: true })
  })

  it('system mode: no process rule for xray (its traffic never enters sing-box)', () => {
    const cfg = singbox()
    expect(cfg.route.rules.some((r) => r.process_name?.includes('xray.exe'))).toBe(false)
    expect(cfg.inbounds[0]).toMatchObject({ type: 'mixed', listen: '127.0.0.1' })
  })
})

describe('server groups: «Лучший сервер (авто)» + selector', () => {
  const ids = outbounds.map((o) => o.id)

  it('urltest over every node, 5 min interval, 50 ms tolerance, gstatic probe', () => {
    const byTag = Object.fromEntries(singbox().outbounds.map((o) => [o.tag, o]))
    expect(byTag.auto).toMatchObject({
      type: 'urltest',
      outbounds: ids,
      url: 'https://www.gstatic.com/generate_204',
      interval: '5m',
      tolerance: 50
    })
    expect(byTag.proxy).toMatchObject({
      type: 'selector',
      outbounds: ['auto', ...ids],
      interrupt_exist_connections: true
    })
  })

  it('selector default: active node, «auto», or auto for an unknown/missing id', () => {
    const sel = (active?: string) => groupOutbounds(ids, active)[1].default
    expect(sel(vlessB.id)).toBe(vlessB.id)
    expect(sel('auto')).toBe('auto')
    expect(sel('ob_gone')).toBe('auto')
    expect(sel(undefined)).toBe('auto')
  })

  it('PROXY rules route to the selector, not to a fixed node', () => {
    const rule = singbox().route.rules.find((r) => r.process_name?.includes('telegram.exe'))
    expect(rule).toMatchObject({ action: 'route', outbound: 'proxy' })
  })
})

describe('routing modes (Правила / Весь трафик / Напрямую)', () => {
  it('clash_mode switch sits before the user rules; LAN stays direct', () => {
    const rules = singbox().route.rules
    const idx = (pred: (r: (typeof rules)[number]) => boolean) => rules.findIndex(pred)
    const direct = idx((r) => r.clash_mode === 'Direct')
    const global = idx((r) => r.clash_mode === 'Global')
    const firstUser = idx((r) => r.rule_set?.includes('geosite-category-ads-all') ?? false)
    expect(rules[direct]).toEqual({ clash_mode: 'Direct', action: 'route', outbound: 'direct' })
    expect(rules[global]).toEqual({ clash_mode: 'Global', action: 'route', outbound: 'proxy' })
    expect(direct).toBeLessThan(firstUser)
    expect(global).toBeLessThan(firstUser)
    expect(idx((r) => r.ip_is_private === true)).toBeLessThan(global)
  })

  it('default_mode follows the saved routing mode', () => {
    expect(singbox().experimental?.clash_api?.default_mode).toBe('Rule')
    expect(singbox({ routingMode: 'global' }).experimental?.clash_api?.default_mode).toBe('Global')
    expect(singbox({ routingMode: 'direct' }).experimental?.clash_api?.default_mode).toBe('Direct')
  })

  it('«Напрямую» resolves DNS locally, «Весь трафик» via the tunnel', () => {
    const rules = (singbox().dns as { rules: { clash_mode?: string; server: string }[] }).rules
    expect(rules).toContainEqual({ clash_mode: 'Direct', server: 'local' })
    expect(rules).toContainEqual({ clash_mode: 'Global', server: 'remote' })
  })

  it('process lookup is on (Подключения screen) in both proxy modes', () => {
    expect(singbox().route.find_process).toBe(true)
    expect(singbox({ proxyMode: 'tun' }).route.find_process).toBe(true)
  })
})

describe('generateProbeConfig (latency test while disconnected)', () => {
  const probe = generateProbeConfig({
    outbounds,
    clashApiPort: 19091,
    logFile: 'probe.log',
    xrayPorts
  })

  it('has no inbounds — nothing on the machine is routed through it', () => {
    expect(probe.inbounds).toEqual([])
    expect(probe.route.final).toBe('direct')
    expect(probe.experimental?.clash_api?.external_controller).toBe('127.0.0.1:19091')
  })

  it('contains every node under its own id', () => {
    const tags = probe.outbounds.map((o) => o.tag)
    expect(tags).toEqual([...outbounds.map((o) => o.id), 'direct'])
  })
})

// --- validate against the real binaries when they are downloaded ----------

const BIN = resolve(__dirname, '../../../resources/bin')
const SINGBOX = join(BIN, 'sing-box.exe')
const XRAY = join(BIN, 'xray.exe')
const tmp = mkdtempSync(join(tmpdir(), 'cw-cfg-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function check(exe: string, args: string[]): void {
  try {
    execFileSync(exe, args, { cwd: tmp, stdio: 'pipe', timeout: 30_000 })
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer }
    throw new Error(`${exe} rejected the config:\n${err.stderr ?? ''}${err.stdout ?? ''}`)
  }
}

describe('real core validation', () => {
  it.skipIf(!existsSync(XRAY))('xray run -test accepts the generated config', () => {
    const file = join(tmp, 'xray.json')
    writeFileSync(file, JSON.stringify(generateXrayConfig(bridges), null, 2))
    check(XRAY, ['run', '-test', '-c', file])
  })

  for (const mode of ['system', 'tun'] as const) {
    for (const routingMode of ['rule', 'global', 'direct'] as const) {
      it.skipIf(!existsSync(SINGBOX))(`sing-box check accepts ${mode}/${routingMode}`, () => {
        const file = join(tmp, `sing-box-${mode}-${routingMode}.json`)
        writeFileSync(file, JSON.stringify(singbox({ proxyMode: mode, routingMode }), null, 2))
        check(SINGBOX, ['check', '-c', file])
      })
    }
  }

  it.skipIf(!existsSync(SINGBOX))('sing-box check accepts the latency probe config', () => {
    const file = join(tmp, 'sing-box-probe.json')
    const probe = generateProbeConfig({ outbounds, clashApiPort: 19091, logFile: 'p.log', xrayPorts })
    writeFileSync(file, JSON.stringify(probe, null, 2))
    check(SINGBOX, ['check', '-c', file])
  })

  it.skipIf(!existsSync(SINGBOX))('sing-box check accepts imported rule types', () => {
    const file = join(tmp, 'sing-box-rules.json')
    const cfg = generateSingboxConfig({
      outbounds,
      activeOutboundId: 'auto',
      rules: {
        defaultBehavior: 'proxy',
        rules: [
          { id: '1', enabled: true, conditionType: 'DomainRegex', value: '^(.+\\.)?ads\\.', action: 'REJECT' },
          { id: '2', enabled: true, conditionType: 'DstPort', value: '6881-6889', action: 'DIRECT' },
          { id: '3', enabled: true, conditionType: 'DstPort', value: '22', action: 'DIRECT' },
          { id: '4', enabled: true, conditionType: 'IPCIDR', value: '2001:db8::/32', action: 'DIRECT' },
          { id: '5', enabled: true, conditionType: 'GeoIP', value: 'lan', action: 'DIRECT' }
        ]
      },
      settings: TEST_SETTINGS,
      socksPort: 10808,
      httpPort: 10809,
      clashApiPort: 19090,
      logFile: 'l',
      cacheFile: 'c',
      xrayPorts
    })
    writeFileSync(file, JSON.stringify(cfg, null, 2))
    check(SINGBOX, ['check', '-c', file])
  })
})
