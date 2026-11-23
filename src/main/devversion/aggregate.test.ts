import { describe, expect, it } from 'vitest'
import type { OutboundConfig } from '@shared/types'
import type { RawConnection } from '../core/connections'
import {
  ConnAggregator,
  EventBook,
  MAX_DOMAINS,
  MAX_IPS,
  MAX_PROCESSES,
  REALTIME_HOLD_MS,
  classifyLine,
  maskUserPath,
  toSample
} from './aggregate'

const NODES: OutboundConfig[] = [
  { id: 'ob_1', name: 'Нидерланды', protocol: 'vless', server: 'nl.node.example', port: 443 },
  { id: 'ob_2', name: 'Германия', protocol: 'hysteria2', server: '203.0.113.7', port: 443 }
] as OutboundConfig[]
const HIDDEN = new Set(['nl.node.example', '203.0.113.7'])

let seq = 0
function conn(p: {
  id?: string
  exe?: string
  host?: string
  ip?: string
  port?: number
  net?: 'tcp' | 'udp'
  chain?: string
  up?: number
  down?: number
  rule?: string
}): RawConnection {
  return {
    id: p.id ?? `c${++seq}`,
    metadata: {
      network: p.net ?? 'tcp',
      destinationIP: p.ip ?? '93.184.216.34',
      destinationPort: String(p.port ?? 443),
      host: p.host ?? '',
      processPath: `C:\\Users\\Ivan\\AppData\\Local\\${p.exe ?? 'app.exe'}`
    },
    upload: p.up ?? 0,
    download: p.down ?? 0,
    chains: [p.chain ?? 'direct'],
    rule: p.rule ?? 'final'
  }
}

describe('DevVersion aggregate: samples', () => {
  it('masks the Windows user in paths; any drive and case', () => {
    expect(maskUserPath('C:\\Users\\Ivan\\AppData\\x.exe')).toBe('%USERPROFILE%\\AppData\\x.exe')
    expect(maskUserPath('d:/users/petr/game.exe')).toBe('%USERPROFILE%/game.exe')
    expect(maskUserPath('C:\\Program Files\\x.exe')).toBe('C:\\Program Files\\x.exe')
  })

  it('maps chains to direct / server name / reject; drops our cores and node addresses', () => {
    const names = new Map(NODES.map((o) => [o.id, o.name]))
    expect(toSample(conn({ chain: 'ob_1' }), names, HIDDEN)?.via).toBe('vpn:Нидерланды')
    expect(toSample(conn({ chain: 'proxy' }), names, HIDDEN)?.via).toBe('vpn')
    expect(toSample(conn({ chain: 'direct' }), names, HIDDEN)?.via).toBe('direct')
    expect(toSample(conn({ rule: 'x => reject' }), names, HIDDEN)?.via).toBe('reject')
    expect(toSample(conn({ exe: 'cipherway-xray.exe' }), names, HIDDEN)).toBeNull()
    expect(toSample(conn({ host: 'nl.node.example' }), names, HIDDEN)).toBeNull()
    expect(toSample(conn({ ip: '203.0.113.7' }), names, HIDDEN)).toBeNull()
    const s = toSample(conn({ exe: 'Game.EXE', host: 'API.Game.com' }), names, HIDDEN)
    expect(s).toMatchObject({ proc: 'game.exe', domain: 'api.game.com' })
    expect(s?.path).toBe('%USERPROFILE%\\AppData\\Local\\Game.EXE')
  })
})

describe('DevVersion aggregate: incremental folding', () => {
  it('adds only the byte delta of a live connection; counts it once', () => {
    const a = new ConnAggregator()
    a.ingest(
      { connections: [conn({ id: 'x', host: 'a.com', up: 100, down: 1000 })] },
      NODES,
      HIDDEN,
      1000
    )
    a.ingest(
      { connections: [conn({ id: 'x', host: 'a.com', up: 150, down: 3000 })] },
      NODES,
      HIDDEN,
      4000
    )
    const p = a.procs.get('app.exe')!
    expect(p.up).toBe(150)
    expect(p.down).toBe(3000)
    expect(p.conns).toBe(1)
    expect(p.domains.get('a.com')).toMatchObject({ up: 150, down: 3000, conns: 1, ports: [443] })
    expect(p.via.direct).toEqual({ up: 150, down: 3000, conns: 1 })
    expect(p.ips.get('93.184.216.34:443/tcp')?.conns).toBe(1)
  })

  it('a connection that vanished with nothing received counts as «no reply»', () => {
    const a = new ConnAggregator()
    a.ingest(
      {
        connections: [
          conn({ id: 'dead', host: 'blocked.com', up: 500 }),
          conn({ id: 'ok', host: 'fine.com', down: 10 })
        ]
      },
      NODES,
      HIDDEN,
      1000
    )
    a.ingest({ connections: [] }, NODES, HIDDEN, 4000)
    const p = a.procs.get('app.exe')!
    expect(p.noReply).toBe(1)
    expect(p.domains.get('blocked.com')?.noReply).toBe(1)
    expect(p.domains.get('fine.com')?.noReply).toBe(0)
    expect(a.liveCount).toBe(0)
  })

  it('a new period starts from zero but a live connection is not counted again', () => {
    const a = new ConnAggregator()
    a.ingest({ connections: [conn({ id: 'x', down: 1000 })] }, NODES, HIDDEN, 1000)
    a.resetPeriod()
    a.ingest({ connections: [conn({ id: 'x', down: 1500 })] }, NODES, HIDDEN, 4000)
    const p = a.procs.get('app.exe')!
    expect(p.down).toBe(500)
    expect(p.conns).toBe(0)
  })

  it('limits: ≤ 100 processes, ≤ 200 domains and ≤ 200 IPs per process — the rarest go', () => {
    const a = new ConnAggregator()
    const many: RawConnection[] = []
    for (let i = 0; i < 400; i++) {
      many.push(
        conn({ exe: 'browser.exe', host: `d${i}.com`, ip: `10.0.${i >> 8}.${i & 255}`, down: i })
      )
    }
    for (let i = 0; i < 180; i++) many.push(conn({ exe: `p${i}.exe`, down: i * 10 }))
    a.ingest({ connections: many }, NODES, HIDDEN, 1000)
    expect(a.procs.size).toBeLessThanOrEqual(MAX_PROCESSES * 1.5)
    const b = a.procs.get('browser.exe')!
    expect(b.domains.size).toBeLessThanOrEqual(MAX_DOMAINS)
    expect(b.ips.size).toBeLessThanOrEqual(MAX_IPS)
    // the biggest stay
    expect(b.domains.has('d399.com')).toBe(true)
    expect(b.domains.has('d0.com')).toBe(false)
    // a run past the slack trims back to the cap
    a.ingest({ connections: many.concat([conn({ exe: 'zz.exe' })]) }, NODES, HIDDEN, 4000)
    expect(a.procs.size).toBeLessThanOrEqual(MAX_PROCESSES * 1.5)
  })

  it('fewer samples when the list is long', () => {
    expect(ConnAggregator.strideFor(50)).toBe(3)
    expect(ConnAggregator.strideFor(400)).toBe(6)
    expect(ConnAggregator.strideFor(2000)).toBe(10)
  })
})

describe('DevVersion aggregate: game / call detection', () => {
  it('UDP of a non-browser program at game rates = real-time; browser QUIC is not', () => {
    const a = new ConnAggregator()
    a.ingest(
      {
        connections: [
          conn({ id: 'q', exe: 'chrome.exe', net: 'udp', up: 0 }),
          conn({ id: 'g', exe: 'someshooter.exe', net: 'udp', up: 0 })
        ]
      },
      NODES,
      HIDDEN,
      1000
    )
    a.ingest(
      {
        connections: [
          conn({ id: 'q', exe: 'chrome.exe', net: 'udp', up: 900_000 }),
          conn({ id: 'g', exe: 'someshooter.exe', net: 'udp', up: 30_000 })
        ]
      },
      NODES,
      HIDDEN,
      4000
    )
    expect(a.realtime(4000)).toBe('someshooter.exe')
    expect(a.realtime(4000 + REALTIME_HOLD_MS + 1)).toBeNull()
  })

  it('a known game exe counts with any traffic', () => {
    const a = new ConnAggregator()
    a.ingest({ connections: [conn({ exe: 'RainbowSix.exe', down: 100 })] }, NODES, HIDDEN, 1000)
    expect(a.realtime(2000)).toBe('rainbowsix.exe')
  })

  it('a slow UDP trickle (NTP, DNS) is not a game', () => {
    const a = new ConnAggregator()
    a.ingest({ connections: [conn({ id: 'n', exe: 'tool.exe', net: 'udp' })] }, NODES, HIDDEN, 1000)
    a.ingest(
      { connections: [conn({ id: 'n', exe: 'tool.exe', net: 'udp', up: 300 })] },
      NODES,
      HIDDEN,
      4000
    )
    expect(a.realtime(4000)).toBeNull()
  })
})

describe('DevVersion aggregate: core log events', () => {
  it('classifies timeouts / REALITY / resets with outbound and target', () => {
    expect(
      classifyLine(
        'ERROR [123 5.0s] connection: open connection to 149.154.167.41:443 using outbound/direct[direct]: dial tcp 149.154.167.41:443: i/o timeout'
      )
    ).toEqual({ kind: 'timeout', outboundTag: 'direct', target: '149.154.167.41:443' })
    expect(
      classifyLine('2026/01/01 00:00:00 [Warning] [42] REALITY: received real certificate')
    ).toMatchObject({ kind: 'reality' })
    expect(
      classifyLine('ERROR [1 1s] connection: outbound/socks[ob_1]: read: connection reset by peer')
    ).toMatchObject({ kind: 'reset', outboundTag: 'ob_1' })
    expect(classifyLine('INFO [1] inbound/tun[tun-in]: inbound connection to x.com:443')).toBeNull()
    // our own loopback hops are not targets
    expect(
      classifyLine('ERROR connection: dial tcp 127.0.0.1:10808: connect: connection refused')
    ).toBeNull()
  })

  it('counts per kind + outbound + target; the recent list folds quick repeats', () => {
    const b = new EventBook()
    b.note('timeout', 'direct', 'a:443', 1000)
    b.note('timeout', 'direct', 'a:443', 2000)
    b.note('reality', 'Нидерланды', '', 3000)
    expect(b.total).toBe(3)
    expect([...b.entries.values()].find((e) => e.kind === 'timeout')).toMatchObject({
      count: 2,
      first: 1000,
      last: 2000
    })
    expect(b.recent.map((r) => r.kind)).toEqual(['timeout', 'reality'])
  })
})
