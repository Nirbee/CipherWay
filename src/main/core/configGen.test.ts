import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AppSettings, RulesConfig } from '@shared/types'
import { parseOutbounds } from '../remnawave/parsers'
import { filterSubscription } from '../remnawave/subscriptionGuard'
import {
  buildOutbound,
  generateProbeConfig,
  generateSingboxConfig,
  groupOutbounds,
  orderByLatency,
  serverDomains,
  type GenParams
} from './configGen'
import {
  buildXrayOutbound,
  generateXrayConfig,
  isXrayHandled,
  xrayHosts,
  type XrayBridge
} from './xrayGen'
import { CORE_EXE, XRAY_EXE } from './coreNames'
import type { ServerIps } from '../system/resolve'
import { MIXED_SUB_BODY, TEST_RULES, TEST_SETTINGS } from './fixtures'
import { groupsFor, layoutRules, planRules, type HeadlessRule } from '../rules/compile'

const outbounds = filterSubscription(parseOutbounds(MIXED_SUB_BODY)).outbounds
const [vlessA, vlessB, hy2] = outbounds
const bridges: XrayBridge[] = [
  { outbound: vlessA, port: 20101 },
  { outbound: vlessB, port: 20102 }
]
const xrayPorts = { [vlessA.id]: 20101, [vlessB.id]: 20102 }

/** what resolveServers() would return for the fixture (TEST-NET / doc ranges) */
const SERVER_IPS: ServerIps = {
  'nl.example.com': ['198.51.100.7', '2001:db8::7'],
  '203.0.113.10': ['203.0.113.10'],
  'hy.example.com': ['198.51.100.8']
}

const GEO = new Map<string, HeadlessRule[]>([
  ['geosite-category-ads-all', [{ domain_suffix: ['ads.example.com'] }]],
  ['geoip-ru', [{ ip_cidr: ['5.0.0.0/8'] }]],
  ['geosite-category-ru', [{ domain_suffix: ['ru'] }]]
])
const SLOT_DIR = 'C:\\cw\\rules'

/** the slot layout of `rules` (+ its files, for `sing-box check`) */
function slotsFor(rules: RulesConfig, dir = SLOT_DIR) {
  const plan = planRules(rules, outbounds)
  const groups = groupsFor(plan)
  const layout = layoutRules(plan, groups, GEO)!
  return { slots: { groups, dir, selectors: layout.selectors }, files: layout.files }
}

function singbox(settings: Partial<AppSettings> = {}, extra: Partial<GenParams> = {}) {
  return generateSingboxConfig({
    outbounds,
    activeOutboundId: vlessA.id,
    slots: slotsFor(TEST_RULES).slots,
    settings: { ...TEST_SETTINGS, ...settings },
    socksPort: 10808,
    httpPort: 10809,
    clashApiPort: 19090,
    logFile: 'sing-box.log',
    xrayPorts,
    ...extra
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
    // unmatched traffic: «Всё остальное» selector → the proxy selector → the active node
    expect(cfg.route.final).toBe('cw-final')
    expect(byTag['cw-final']).toMatchObject({ type: 'selector', default: 'proxy' })
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

  it('remote DNS goes through the cw-dns selector (tunnel, or direct for «всё напрямую»)', () => {
    const servers = (singbox().dns as { servers: { tag: string; detour?: string }[] }).servers
    // sing-box refuses to start with a detour to the empty direct outbound
    expect(servers.find((s) => s.tag === 'local')?.detour).toBeUndefined()
    expect(servers.find((s) => s.tag === 'remote')?.detour).toBe('cw-dns')
    const direct = generateSingboxConfig({
      ...{ outbounds, activeOutboundId: vlessA.id, settings: TEST_SETTINGS, xrayPorts },
      slots: slotsFor({ defaultBehavior: 'direct', rules: [] }).slots,
      socksPort: 0,
      httpPort: 1,
      clashApiPort: 2,
      logFile: 'l'
    })
    expect(direct.outbounds.find((o) => o.tag === 'cw-dns')).toMatchObject({
      type: 'selector',
      default: 'direct'
    })
    expect(direct.outbounds.find((o) => o.tag === 'cw-final')).toMatchObject({ default: 'direct' })
  })

  it('no cache_file: the previous run’s mode / selector choice never comes back at start', () => {
    expect(singbox().experimental).not.toHaveProperty('cache_file')
    expect(JSON.stringify(singbox({ proxyMode: 'tun' }))).not.toMatch(/cache/)
  })

  it('user rules are local rule-sets in the slot folder (no downloads by the core)', () => {
    const sets = singbox().route.rule_set ?? []
    expect(sets.length).toBeGreaterThan(0)
    for (const r of sets) {
      expect(r.type).toBe('local')
      expect(r.path.startsWith(`${SLOT_DIR}\\`)).toBe(true)
    }
  })

  it('TUN mode: cipherway-xray.exe goes direct before anything else (no loop)', () => {
    const cfg = singbox({ proxyMode: 'tun' })
    expect(cfg.route.rules[0]).toEqual({
      process_name: ['cipherway-xray.exe'],
      action: 'route',
      outbound: 'direct'
    })
    expect(cfg.route.auto_detect_interface).toBe(true)
    expect(cfg.inbounds[0]).toMatchObject({ type: 'tun', auto_route: true, strict_route: true })
  })

  it('system mode: no process rule for xray (its traffic never enters sing-box)', () => {
    const cfg = singbox()
    expect(cfg.route.rules.some((r) => r.process_name?.includes('cipherway-xray.exe'))).toBe(false)
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

  it('PROXY rules route to a slot selector that points at the proxy selector', () => {
    const cfg = singbox()
    const rule = cfg.route.rules.find((r) => r.rule_set?.[0] === 'cw-0-p')
    expect(rule).toMatchObject({ action: 'route', outbound: 'cw-0' })
    expect(cfg.outbounds.find((o) => o.tag === 'cw-0')).toMatchObject({ default: 'proxy' })
  })
})

describe('the «⚡ Автовыбор» of the panel (0.4.3)', () => {
  it('reaches neither the urltest group nor the selector', () => {
    const auto =
      'vless://11111111-2222-4333-8444-555555555555@khjvfcbtf.example.com:443' +
      '?security=reality&pbk=K&sni=a.example.org#%E2%9A%A1%20%D0%90%D0%B2%D1%82%D0%BE%D0%B2%D1%8B%D0%B1%D0%BE%D1%80'
    const all = parseOutbounds(`${auto}\n${Buffer.from(MIXED_SUB_BODY, 'base64').toString()}`)
    expect(all.map((o) => o.name)).toContain('⚡ Автовыбор')
    const list = filterSubscription(all).outbounds
    expect(list.map((o) => o.name)).not.toContain('⚡ Автовыбор')
    const cfg = singbox({}, { outbounds: list })
    const hidden = all.find((o) => o.name === '⚡ Автовыбор')!.id
    const tags = (t: string) => cfg.outbounds.find((o) => o.tag === t)?.outbounds ?? []
    expect(tags('auto')).toHaveLength(list.length)
    expect(tags('auto')).not.toContain(hidden)
    expect(tags('proxy')).not.toContain(hidden)
    expect(JSON.stringify(cfg)).not.toContain('khjvfcbtf')
  })
})

describe('routing modes (Правила / Весь трафик / Напрямую)', () => {
  it('clash_mode switch sits before the user rules; LAN stays direct', () => {
    const rules = singbox().route.rules
    const idx = (pred: (r: (typeof rules)[number]) => boolean) => rules.findIndex(pred)
    const direct = idx((r) => r.clash_mode === 'Direct')
    const global = idx((r) => r.clash_mode === 'Global')
    const firstUser = idx((r) => r.rule_set?.[0]?.startsWith('cw-') ?? false)
    expect(rules[direct]).toEqual({ clash_mode: 'Direct', action: 'route', outbound: 'direct' })
    expect(rules[global]).toEqual({ clash_mode: 'Global', action: 'route', outbound: 'proxy' })
    expect(direct).toBeLessThan(firstUser)
    expect(global).toBeLessThan(firstUser)
    expect(idx((r) => r.ip_is_private === true)).toBeLessThan(global)
  })

  it('Clash API: loopback only, with the per-start secret', () => {
    const api = singbox({}, { clashSecret: 'f00d' }).experimental?.clash_api
    expect(api).toMatchObject({ external_controller: '127.0.0.1:19090', secret: 'f00d' })
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

describe('TUN: node traffic of xray bypasses the TUN (0.4.1)', () => {
  type Tun = { route_exclude_address?: string[]; auto_route?: boolean }

  it('resolved node IPs (v4 + v6) are excluded from the TUN routes', () => {
    const tun = singbox({ proxyMode: 'tun' }, { serverIps: SERVER_IPS }).inbounds[0] as Tun
    expect(tun.auto_route).toBe(true)
    expect(tun.route_exclude_address).toEqual([
      '198.51.100.7/32',
      '2001:db8::7/128',
      '203.0.113.10/32',
      '198.51.100.8/32'
    ])
  })

  it('loopback / unresolved: no exclusion entries; system mode has no TUN at all', () => {
    const tun = singbox({ proxyMode: 'tun' }, { serverIps: { localhost: ['127.0.0.1', '::1'] } })
      .inbounds[0] as Tun
    expect(tun.route_exclude_address).toBeUndefined()
    expect(singbox({ proxyMode: 'tun' }).inbounds[0]).not.toHaveProperty('route_exclude_address')
    expect(singbox({}, { serverIps: SERVER_IPS }).inbounds[0].type).toBe('mixed')
  })

  it('the process_name cipherway-xray.exe → direct rule stays as a safety net', () => {
    const rules = singbox({ proxyMode: 'tun' }, { serverIps: SERVER_IPS }).route.rules
    expect(rules[0]).toEqual({
      process_name: ['cipherway-xray.exe'],
      action: 'route',
      outbound: 'direct'
    })
  })

  it('xray dials the pre-resolved IPs: dns.hosts (IPv4 only) + sockopt UseIP', () => {
    const cfg = generateXrayConfig(bridges, { serverIps: SERVER_IPS })
    expect(cfg.dns).toEqual({ hosts: { 'nl.example.com': ['198.51.100.7'] } })
    const a = cfg.outbounds.find((o) => o.tag === `out-${vlessA.id}`) as {
      streamSettings: { sockopt?: object; realitySettings: { serverName: string } }
    }
    expect(a.streamSettings.sockopt).toEqual({ domainStrategy: 'UseIP' })
    // SNI is still the REALITY server name, not the IP
    expect(a.streamSettings.realitySettings.serverName).toBe('www.example.org')
    // an IP-literal node needs no pinning
    const b = cfg.outbounds.find((o) => o.tag === `out-${vlessB.id}`) as { streamSettings: object }
    expect(b.streamSettings).not.toHaveProperty('sockopt')
  })

  it('xrayHosts: IPv6 only when the host has no IPv4; unresolved hosts are left to xray', () => {
    const v6only = { ...vlessA, server: 'v6.example.com' }
    expect(xrayHosts([v6only], { 'v6.example.com': ['2001:db8::1'] })).toEqual({
      'v6.example.com': ['2001:db8::1']
    })
    expect(xrayHosts([vlessA], {})).toEqual({})
    expect(generateXrayConfig(bridges)).not.toHaveProperty('dns')
  })
})

describe('log level (0.4.1)', () => {
  it('warn by default, info with «Подробный журнал»', () => {
    expect(singbox().log.level).toBe('warn')
    expect(singbox({ verboseLog: true }).log.level).toBe('info')
    // xray: always info — the only way to trace a REALITY error to its node
    // (filtered in SidecarManager unless «Подробный журнал» is on)
    expect(generateXrayConfig(bridges).log.loglevel).toBe('info')
  })
})

describe('«Лучший сервер (авто)»: member order by last latency (0.4.1)', () => {
  it('answered fastest first, then never measured (subscription order), dead last', () => {
    expect(
      orderByLatency(['dead1', 'slow', 'new1', 'fast', 'dead2', 'new2'], {
        dead1: null,
        slow: 900,
        fast: 120,
        dead2: null
      })
    ).toEqual(['fast', 'slow', 'new1', 'new2', 'dead1', 'dead2'])
  })

  it('no measurements = subscription order; ties keep subscription order', () => {
    expect(orderByLatency(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(orderByLatency(['a', 'b', 'c'], { c: 100, a: 100 })).toEqual(['a', 'c', 'b'])
  })

  it('a dead first node of the subscription («⚡ Автовыбор») is not urltest’s first member', () => {
    const ids = outbounds.map((o) => o.id)
    const cfg = singbox({}, { latencies: { [ids[0]]: null, [ids[1]]: 250, [ids[2]]: 400 } })
    const auto = cfg.outbounds.find((o) => o.tag === 'auto') as unknown as { outbounds: string[] }
    expect(auto.outbounds).toEqual([ids[1], ids[2], ids[0]])
    // the selector keeps the subscription order for the UI / Clash API
    const sel = cfg.outbounds.find((o) => o.tag === 'proxy') as unknown as { outbounds: string[] }
    expect(sel.outbounds).toEqual(['auto', ...ids])
    expect(groupOutbounds(ids, 'auto', { [ids[2]]: 10 })[0].outbounds).toEqual([
      ids[2],
      ids[0],
      ids[1]
    ])
  })
})

// --- validate against the real binaries when they are downloaded ----------

const BIN = resolve(__dirname, '../../../resources/bin')
const SINGBOX = join(BIN, CORE_EXE)
const XRAY = join(BIN, XRAY_EXE)
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

  it.skipIf(!existsSync(XRAY))('xray run -test accepts pinned IPs', () => {
    const file = join(tmp, 'xray-pinned.json')
    const cfg = generateXrayConfig(bridges, { serverIps: SERVER_IPS })
    writeFileSync(file, JSON.stringify(cfg, null, 2))
    check(XRAY, ['run', '-test', '-c', file])
  })

  /** slot files of `rules` written into the temp folder (check reads local rule-sets) */
  function writeSlots(rules: RulesConfig, name: string) {
    const dir = join(tmp, name)
    mkdirSync(dir, { recursive: true })
    const { slots, files } = slotsFor(rules, dir)
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text)
    return slots
  }

  for (const mode of ['system', 'tun'] as const) {
    for (const routingMode of ['rule', 'global', 'direct'] as const) {
      it.skipIf(!existsSync(SINGBOX))(`sing-box check accepts ${mode}/${routingMode}`, () => {
        const file = join(tmp, `sing-box-${mode}-${routingMode}.json`)
        const cfg = singbox(
          { proxyMode: mode, routingMode, verboseLog: routingMode === 'global' },
          {
            serverIps: SERVER_IPS,
            latencies: { [outbounds[0].id]: null },
            slots: writeSlots(TEST_RULES, `slots-${mode}-${routingMode}`)
          }
        )
        writeFileSync(file, JSON.stringify(cfg, null, 2))
        check(SINGBOX, ['check', '-c', file])
      })
    }
  }

  it.skipIf(!existsSync(SINGBOX))('sing-box check accepts the latency probe config', () => {
    const file = join(tmp, 'sing-box-probe.json')
    const probe = generateProbeConfig({
      outbounds,
      clashApiPort: 19091,
      logFile: 'p.log',
      xrayPorts
    })
    writeFileSync(file, JSON.stringify(probe, null, 2))
    check(SINGBOX, ['check', '-c', file])
  })

  it.skipIf(!existsSync(SINGBOX))('sing-box check accepts imported rule types', () => {
    const file = join(tmp, 'sing-box-rules.json')
    const cfg = generateSingboxConfig({
      outbounds,
      activeOutboundId: 'auto',
      slots: writeSlots(
        {
          defaultBehavior: 'auto',
          rules: [
            {
              id: '1',
              enabled: true,
              conditionType: 'DomainRegex',
              value: '^(.+\\.)?ads\\.',
              action: 'REJECT'
            },
            {
              id: '2',
              enabled: true,
              conditionType: 'DstPort',
              value: '6881-6889',
              action: 'DIRECT'
            },
            { id: '3', enabled: true, conditionType: 'DstPort', value: '22', action: 'DIRECT' },
            {
              id: '4',
              enabled: true,
              conditionType: 'IPCIDR',
              value: '2001:db8::/32',
              action: 'DIRECT'
            },
            { id: '5', enabled: true, conditionType: 'GeoIP', value: 'lan', action: 'DIRECT' },
            {
              id: '6',
              enabled: true,
              conditionType: 'ProcessName',
              value: 'discord.exe',
              action: 'PROXY'
            },
            {
              id: '7',
              enabled: true,
              conditionType: 'ProcessPath',
              value: 'C:\\Games (x86)\\g+1.exe',
              action: 'DIRECT'
            },
            {
              id: '8',
              enabled: true,
              conditionType: 'GeoIP',
              value: 'telegram',
              action: 'Germany'
            },
            {
              id: '9',
              enabled: true,
              conditionType: 'GeoSite',
              value: 'category-ads-all',
              action: 'REJECT'
            }
          ]
        },
        'slots-imported'
      ),
      settings: TEST_SETTINGS,
      socksPort: 10808,
      httpPort: 10809,
      clashApiPort: 19090,
      logFile: 'l',
      xrayPorts
    })
    writeFileSync(file, JSON.stringify(cfg, null, 2))
    check(SINGBOX, ['check', '-c', file])
  })
})
