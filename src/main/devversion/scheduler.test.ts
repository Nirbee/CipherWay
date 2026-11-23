import { describe, expect, it } from 'vitest'
import type { RawConnection } from '../core/connections'
import { ConnAggregator } from './aggregate'
import {
  HEAVY_INTERVAL_MS,
  HeavyGate,
  NODE_SAMPLES,
  QUIET_MS,
  runLimited,
  TUNNEL_PROBE_MS,
  tuningFrom
} from './scheduler'

const udp = (id: string, exe: string, up: number): RawConnection => ({
  id,
  metadata: {
    network: 'udp',
    destinationIP: '185.38.21.83',
    destinationPort: '6015',
    processPath: `C:\\Games\\${exe}`
  },
  upload: up,
  download: up,
  chains: ['direct']
})

describe('DevVersion: heavy probes wait for games', () => {
  it('not before the first slot; then runs; next slot = interval ± 20 %', () => {
    const g = new HeavyGate(0, HEAVY_INTERVAL_MS, () => 0.5, 1000)
    expect(g.check(500, null)).toBe('wait')
    expect(g.check(1000, null)).toBe('run')
    g.done(2000)
    expect(g.nextAt).toBe(2000 + HEAVY_INTERVAL_MS)
    const lo = new HeavyGate(0, HEAVY_INTERVAL_MS, () => 0, 0)
    lo.done(0)
    expect(lo.nextAt).toBe(HEAVY_INTERVAL_MS * 0.8)
  })

  it('game traffic: deferred while it lasts and for 2 min after', () => {
    const g = new HeavyGate(0, HEAVY_INTERVAL_MS, () => 0.5, 0)
    expect(g.check(1000, 'rainbowsix.exe')).toBe('deferred')
    expect(g.deferred).toBe(true)
    expect(g.check(60_000, 'rainbowsix.exe')).toBe('deferred')
    // the game ended at 60 s: quiet period
    expect(g.check(60_000 + QUIET_MS - 1, null)).toBe('deferred')
    expect(g.check(60_000 + QUIET_MS, null)).toBe('run')
    expect(g.deferred).toBe(false)
  })

  it('end to end: real-time UDP in the connection snapshots defers the heavy run', () => {
    const agg = new ConnAggregator()
    const gate = new HeavyGate(0, HEAVY_INTERVAL_MS, () => 0.5, 0)
    // a game exchanging ~20 KB/s over UDP
    agg.ingest({ connections: [udp('g', 'shooter.exe', 0)] }, [], new Set(), 0)
    agg.ingest({ connections: [udp('g', 'shooter.exe', 30_000)] }, [], new Set(), 3000)
    expect(gate.check(3000, agg.realtime(3000))).toBe('deferred')
    // the game is closed; 90 s later the program no longer counts, 2 more min of quiet
    agg.ingest({ connections: [] }, [], new Set(), 6000)
    const later = 3000 + 90_001
    expect(agg.realtime(later)).toBeNull()
    expect(gate.check(later, agg.realtime(later))).toBe('deferred')
    expect(gate.check(later + QUIET_MS, agg.realtime(later + QUIET_MS))).toBe('run')
  })

  it('interrupted by a game: no new slot, waits for quiet', () => {
    const g = new HeavyGate(0, HEAVY_INTERVAL_MS, () => 0.5, 0)
    expect(g.check(0, null)).toBe('run')
    g.interrupted(10_000)
    expect(g.check(10_000 + QUIET_MS - 1, null)).toBe('deferred')
    expect(g.check(10_000 + QUIET_MS, null)).toBe('run')
  })
})

describe('DevVersion: runLimited', () => {
  it('never more than 2 at a time, results in order, failures are undefined', async () => {
    let running = 0
    let peak = 0
    const tasks = Array.from({ length: 7 }, (_, i) => async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      if (i === 3) throw new Error('boom')
      return i * 10
    })
    const { results, stopped } = await runLimited(tasks, { gapMs: 0 })
    expect(peak).toBe(2)
    expect(stopped).toBe(false)
    expect(results).toEqual([0, 10, 20, undefined, 40, 50, 60])
  })

  it('stops between tasks when told (a game started)', async () => {
    let done = 0
    let stop = false
    const tasks = Array.from({ length: 10 }, () => async () => {
      done++
      if (done === 3) stop = true
    })
    const res = await runLimited(tasks, { concurrency: 1, gapMs: 0, shouldStop: () => stop })
    expect(res.stopped).toBe(true)
    expect(done).toBe(3)
  })

  it('pauses between tasks of one worker', async () => {
    const pauses: number[] = []
    await runLimited(
      Array.from({ length: 3 }, () => async () => undefined),
      { concurrency: 1, gapMs: 300, sleep: async (ms) => void pauses.push(ms) }
    )
    expect(pauses).toEqual([300, 300])
  })
})

describe('DevVersion: defaults and server flags', () => {
  it('defaults: heavy run every 30 min, 5 delays per server, tunnel every 60 s', () => {
    expect(HEAVY_INTERVAL_MS).toBe(30 * 60_000)
    expect(NODE_SAMPLES).toBe(5)
    expect(TUNNEL_PROBE_MS).toBe(60_000)
    expect(tuningFrom({})).toEqual({
      heavyIntervalMs: 30 * 60_000,
      nodeSamples: 5,
      heavyProbes: true,
      tunnelProbeMs: 60_000
    })
  })

  it('flags override within bounds; bad values keep the default', () => {
    expect(
      tuningFrom({
        probe_interval_s: 3600,
        node_samples: 2,
        heavy_probes: false,
        tunnel_probe_s: 120
      })
    ).toEqual({
      heavyIntervalMs: 3_600_000,
      nodeSamples: 2,
      heavyProbes: false,
      tunnelProbeMs: 120_000
    })
    expect(
      tuningFrom({
        probe_interval_s: 10,
        node_samples: 50,
        heavy_probes: 'no',
        tunnel_probe_s: 1.5
      })
    ).toEqual(tuningFrom({}))
    expect(tuningFrom({ node_samples: '3' }).nodeSamples).toBe(5)
  })
})
