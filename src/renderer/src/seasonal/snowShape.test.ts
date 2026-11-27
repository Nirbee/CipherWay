import { describe, expect, it } from 'vitest'
import { seededRandom, snowCap } from './snowShape'

const numbers = (d: string): number[] => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)

describe('снежные шапки', () => {
  it('the same card draws the same cap (no jumping on re-render)', () => {
    expect(snowCap(700, { seed: 'profile' })).toEqual(snowCap(700, { seed: 'profile' }))
    expect(snowCap(700, { seed: 'profile' }).body).not.toBe(snowCap(700, { seed: 'picker' }).body)
    const a = seededRandom('x')
    const b = seededRandom('x')
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('stays inside the card width and its own height, closed outline', () => {
    for (const w of [40, 180, 704, 1600]) {
      for (const size of ['md', 'sm'] as const) {
        const g = snowCap(w, { seed: 's', size, icicles: true })
        expect(g.body.startsWith('M')).toBe(true)
        expect(g.body.endsWith('Z')).toBe(true)
        const xs = numbers(g.body).filter((_, i) => i % 2 === 0)
        const ys = numbers(g.body).filter((_, i) => i % 2 === 1)
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
        expect(Math.max(...xs)).toBeLessThanOrEqual(Math.max(24, w) + 0.01)
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
        expect(Math.max(...ys)).toBeLessThanOrEqual(g.height)
        for (const y of numbers(g.icicles).filter((_, i) => i % 2 === 1)) {
          expect(y).toBeLessThanOrEqual(g.height)
        }
      }
    }
  })

  it('icicles only when asked', () => {
    expect(snowCap(500, { seed: 'a' }).icicles).toBe('')
    expect(snowCap(500, { seed: 'a', icicles: true }).icicles).toMatch(/^M/)
  })
})
