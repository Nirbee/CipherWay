import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry } from './types'
import { appendCapped, LogBatcher, UI_LOG_LIMIT } from './logBuffer'

const entry = (i: number): LogEntry => ({
  ts: i,
  level: 'info',
  source: 'singbox',
  message: `line ${i}`
})
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => entry(from + i))

describe('appendCapped (UI log buffer)', () => {
  it('appends while under the limit', () => {
    expect(appendCapped([1, 2], [3], 5)).toEqual([1, 2, 3])
  })

  it('drops the oldest lines once the limit is reached', () => {
    expect(appendCapped([1, 2, 3, 4], [5, 6], 4)).toEqual([3, 4, 5, 6])
  })

  it('a batch bigger than the limit keeps only its newest lines', () => {
    expect(appendCapped([1], [2, 3, 4, 5, 6], 3)).toEqual([4, 5, 6])
  })

  it('never grows past UI_LOG_LIMIT under a flood of batches', () => {
    let buf: LogEntry[] = []
    for (let b = 0; b < 50; b++) buf = appendCapped(buf, range(b * 300, 300), UI_LOG_LIMIT)
    expect(buf).toHaveLength(UI_LOG_LIMIT)
    expect(buf.at(-1)?.message).toBe(`line ${50 * 300 - 1}`)
    expect(buf[0].message).toBe(`line ${50 * 300 - UI_LOG_LIMIT}`)
  })

  it('does not mutate its inputs', () => {
    const a = [1, 2, 3]
    appendCapped(a, [4], 3)
    expect(a).toEqual([1, 2, 3])
  })
})

describe('LogBatcher (main → renderer)', () => {
  afterEach(() => vi.useRealTimers())

  it('sends one batch per interval instead of one IPC message per line', () => {
    vi.useFakeTimers()
    const batches: LogEntry[][] = []
    const b = new LogBatcher((x) => batches.push(x), 300, 100)
    for (const e of range(0, 50)) b.push(e)
    expect(batches).toHaveLength(0)
    vi.advanceTimersByTime(300)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(50)
  })

  it('overflow: keeps the newest lines and reports how many were dropped', () => {
    vi.useFakeTimers()
    const batches: LogEntry[][] = []
    const b = new LogBatcher((x) => batches.push(x), 300, 100)
    for (const e of range(0, 250)) b.push(e)
    vi.advanceTimersByTime(300)
    const [batch] = batches
    expect(batch).toHaveLength(101)
    expect(batch[0]).toMatchObject({ level: 'warn', source: 'app' })
    expect(batch[0].message).toContain('150')
    expect(batch[1].message).toBe('line 150')
    expect(batch.at(-1)?.message).toBe('line 249')
  })

  it('flush() sends immediately and resets', () => {
    const batches: LogEntry[][] = []
    const b = new LogBatcher((x) => batches.push(x), 10_000, 100)
    b.push(entry(1))
    b.flush()
    b.flush()
    expect(batches).toEqual([[entry(1)]])
  })
})
