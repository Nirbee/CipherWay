import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_FIRST_DELAY_MS,
  UPDATE_INTERVAL_MS,
  UPDATE_RESUME_DELAY_MS,
  UPDATE_RESUME_MIN_GAP_MS,
  UpdateSchedule
} from './schedule'

const MIN = 60_000

describe('UpdateSchedule', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const make = (run = vi.fn(async () => undefined)) => {
    const s = new UpdateSchedule({ run })
    return { s, run }
  }

  it('uses 30 s / 3 h by default', () => {
    expect(UPDATE_FIRST_DELAY_MS).toBe(30_000)
    expect(UPDATE_INTERVAL_MS).toBe(3 * 60 * MIN)
  })

  it('first check ~30 s after start, not before', async () => {
    const { s, run } = make()
    s.start()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('then every 3 hours', async () => {
    const { s, run } = make()
    s.start()
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS)
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS - 1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2)
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('start() twice does not double the checks', async () => {
    const { s, run } = make()
    s.start()
    s.start()
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a failing check does not stop the schedule', async () => {
    const run = vi.fn(async () => {
      throw new Error('offline')
    })
    const { s } = make(run)
    s.start()
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS + UPDATE_INTERVAL_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never runs two checks at once', async () => {
    let release: () => void = () => undefined
    const run = vi.fn(() => new Promise<void>((r) => (release = r)))
    const s = new UpdateSchedule({ run, firstDelayMs: 10, resumeDelayMs: 10, resumeMinGapMs: 0 })
    s.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(1)
    s.onResume() // fires while the first check still hangs
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.armed).toBe(true)
  })

  it('after sleep: a check shortly after waking if the last one is old', async () => {
    const { s, run } = make()
    s.start()
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS)
    expect(run).toHaveBeenCalledTimes(1)
    // the laptop slept for an hour: the wall clock moved, the timers did not
    vi.setSystemTime(Date.now() + 60 * MIN)
    s.onResume()
    await vi.advanceTimersByTimeAsync(UPDATE_RESUME_DELAY_MS - 1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    // and the 3-hour rhythm continues from that check
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('after a short sleep: no extra check', async () => {
    const { s, run } = make()
    s.start()
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS)
    vi.setSystemTime(Date.now() + UPDATE_RESUME_MIN_GAP_MS - MIN)
    s.onResume()
    await vi.advanceTimersByTimeAsync(UPDATE_RESUME_DELAY_MS * 2)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('waking before the first check moves it closer, not twice', async () => {
    const { s, run } = make()
    s.start()
    s.onResume()
    await vi.advanceTimersByTimeAsync(UPDATE_RESUME_DELAY_MS)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a manual check restarts the 3-hour countdown', async () => {
    const { s, run } = make()
    s.start()
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS) // #1
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN)
    s.noteCheck() // the user pressed the button
    await vi.advanceTimersByTimeAsync(60 * MIN) // the old slot passes quietly
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('stop() cancels everything', async () => {
    const { s, run } = make()
    s.start()
    s.stop()
    s.onResume()
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2)
    expect(run).not.toHaveBeenCalled()
    expect(s.armed).toBe(false)
  })
})
