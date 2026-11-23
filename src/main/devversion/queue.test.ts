import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Backoff, DiskQueue } from './queue'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-devq-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('DevVersion queue on disk', () => {
  it('oldest first; read / replace / remove', async () => {
    const q = new DiskQueue(join(dir, 'q'))
    const a = await q.push(Buffer.from('aaa'), 1000)
    const b = await q.push(Buffer.from('bb'), 2000)
    expect((await q.list()).map((i) => i.name)).toEqual([a, b])
    expect((await q.read(a)).toString()).toBe('aaa')
    await q.replace(a, Buffer.from('a'))
    expect(await q.totals()).toEqual({ reports: 2, bytes: 3 })
    await q.remove(a)
    expect((await q.list()).map((i) => i.name)).toEqual([b])
  })

  it('never grows past its limit: the oldest reports are dropped', async () => {
    const q = new DiskQueue(join(dir, 'q'), 100)
    for (let i = 0; i < 5; i++) await q.push(Buffer.alloc(30, i), 1000 + i)
    const left = await q.list()
    expect(left.reduce((s, i) => s + i.bytes, 0)).toBeLessThanOrEqual(100)
    // the newest survive
    expect((await q.read(left[left.length - 1].name))[0]).toBe(4)
    expect(left.length).toBe(3)
  })

  it('a missing folder is an empty queue; clear removes everything', async () => {
    const q = new DiskQueue(join(dir, 'nope'))
    expect(await q.list()).toEqual([])
    await q.push(Buffer.from('x'))
    await q.clear()
    expect(await q.totals()).toEqual({ reports: 0, bytes: 0 })
  })
})

describe('DevVersion backoff', () => {
  it('doubles from 1 min up to 60 min (± 20 %), an explicit wait wins, success resets', () => {
    const b = new Backoff(60_000, 3_600_000, () => 0.5) // no jitter at 0.5
    expect(b.ready(0)).toBe(true)
    expect(b.fail(0)).toBe(60_000)
    expect(b.ready(59_999)).toBe(false)
    expect(b.ready(60_000)).toBe(true)
    expect(b.fail(0)).toBe(120_000)
    expect(b.fail(0)).toBe(240_000)
    for (let i = 0; i < 10; i++) b.fail(0)
    expect(b.fail(0)).toBe(3_600_000)
    expect(b.fail(1000, 5000)).toBe(5000)
    expect(b.readyAt).toBe(6000)
    b.succeed()
    expect(b.ready(0)).toBe(true)
    expect(b.attempts).toBe(0)
  })

  it('jitter stays within ± 20 %', () => {
    const lo = new Backoff(60_000, 3_600_000, () => 0)
    const hi = new Backoff(60_000, 3_600_000, () => 1)
    expect(lo.fail(0)).toBe(48_000)
    expect(hi.fail(0)).toBe(72_000)
  })
})
