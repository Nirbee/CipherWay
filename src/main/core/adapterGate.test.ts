import { describe, expect, it } from 'vitest'
import { AdapterGate } from './adapterGate'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('AdapterGate: one wintun adapter at a time', () => {
  it('the second waits until the first is done; the waiter is told who is busy', async () => {
    const gate = new AdapterGate()
    const order: string[] = []
    const waited: string[] = []
    const a = gate.run('LAN', async () => {
      order.push('LAN start')
      await sleep(40)
      order.push('LAN done')
    })
    const b = gate.run(
      'VPN',
      async () => {
        order.push('VPN start')
      },
      { onWait: (who) => waited.push(who) }
    )
    await Promise.all([a, b])
    expect(order).toEqual(['LAN start', 'LAN done', 'VPN start'])
    expect(waited).toEqual(['LAN'])
    expect(gate.busy).toBeNull()
  })

  it('nobody inside: runs at once, no «waiting» message', async () => {
    const gate = new AdapterGate()
    const waited: string[] = []
    expect(await gate.run('VPN', async () => 7, { onWait: (w) => waited.push(w) })).toBe(7)
    expect(waited).toEqual([])
  })

  it('an error inside frees the gate and reaches the caller', async () => {
    const gate = new AdapterGate()
    await expect(
      gate.run('LAN', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    const t0 = Date.now()
    await gate.run('VPN', async () => undefined, { maxWaitMs: 5000 })
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('never waits forever: after maxWaitMs the waiter goes ahead', async () => {
    const gate = new AdapterGate()
    let release!: () => void
    const stuck = gate.run(
      'LAN',
      () =>
        new Promise<void>((r) => {
          release = r
        })
    )
    const t0 = Date.now()
    await gate.run('VPN', async () => undefined, { maxWaitMs: 50 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40)
    expect(Date.now() - t0).toBeLessThan(1000)
    release()
    await stuck
  })

  it('three in a row keep their order', async () => {
    const gate = new AdapterGate()
    const order: number[] = []
    await Promise.all(
      [1, 2, 3].map((n) =>
        gate.run(String(n), async () => {
          await sleep(10)
          order.push(n)
        })
      )
    )
    expect(order).toEqual([1, 2, 3])
  })
})
