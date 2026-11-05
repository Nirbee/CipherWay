import { describe, expect, it } from 'vitest'
import {
  REALITY_COOLDOWN_MS as COOL,
  REALITY_GRACE_MS as GRACE,
  REALITY_HINT,
  REALITY_HINT_TTL_MS as TTL,
  RealityWatch
} from './realityWatch'

describe('RealityWatch', () => {
  it('the first error asks for one refresh, the following ones wait for it', () => {
    const w = new RealityWatch()
    expect(w.note('a', 1000)).toEqual({ heal: true, hintsChanged: false })
    expect(w.note('a', 1100)).toEqual({ heal: false, hintsChanged: false })
    expect(w.note('b', 1200)).toEqual({ heal: false, hintsChanged: false })
  })

  it('no more than one refresh per 10 minutes', () => {
    const w = new RealityWatch()
    w.note('a', 0)
    w.healDone(100)
    expect(w.note('a', COOL - 1).heal).toBe(false)
    expect(w.note('a', COOL).heal).toBe(true)
  })

  it('never a second refresh while the first one is running', () => {
    const w = new RealityWatch()
    w.note('a', 0)
    expect(w.note('a', COOL * 2).heal).toBe(false)
    w.healDone(COOL * 2)
    expect(w.note('a', COOL * 4).heal).toBe(true)
  })

  it('the error stayed after the refresh → a hint on this server only', () => {
    const w = new RealityWatch()
    w.note('a', 0)
    w.healDone(1000)
    // old connections may still report for a few seconds
    expect(w.note('a', 1000 + GRACE - 1).hintsChanged).toBe(false)
    expect(w.note('a', 1000 + GRACE).hintsChanged).toBe(true)
    expect(w.note('a', 1000 + GRACE + 1).hintsChanged).toBe(false)
    expect(w.hints()).toEqual({ a: REALITY_HINT })
  })

  it('a line without a known server still heals, but hints nobody', () => {
    const w = new RealityWatch()
    expect(w.note(undefined, 0).heal).toBe(true)
    w.healDone(1)
    expect(w.note(undefined, GRACE + 2)).toEqual({ heal: false, hintsChanged: false })
    expect(w.hints()).toEqual({})
  })

  it('a new config clears the hints, the cooldown stays', () => {
    const w = new RealityWatch()
    w.note('a', 0)
    w.healDone(0)
    w.note('a', GRACE)
    expect(w.resetServers()).toBe(true)
    expect(w.hints()).toEqual({})
    expect(w.resetServers()).toBe(false)
    expect(w.note('a', GRACE + 1).heal).toBe(false)
  })

  it('a server that went quiet loses its hint', () => {
    const w = new RealityWatch()
    w.note('a', 0)
    w.healDone(0)
    w.note('a', GRACE)
    expect(w.prune(GRACE + TTL - 1)).toBe(false)
    expect(w.prune(GRACE + TTL)).toBe(true)
    expect(w.hints()).toEqual({})
  })
})
