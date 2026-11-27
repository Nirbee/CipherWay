// Snow caps (0.7.6): the outline of the snow lying on the top edge of a card,
// generated for the card's real width — fluffy bumps on top, rounded lobes hanging
// over the edge, both ends falling over the rounded corners; optional icicles.
// Pure (seeded random) — unit tested in snowShape.test.ts.

export type SnowCapSize = 'md' | 'sm'

interface SizeSpec {
  /** px of snow above the card's top edge */
  above: number
  /** the deepest lobe below the edge */
  hang: number
  /** bump width range */
  bump: [number, number]
  /** bump height range */
  bumpH: [number, number]
  /** icicle length range */
  icicle: [number, number]
}

const SIZES: Record<SnowCapSize, SizeSpec> = {
  md: { above: 15, hang: 8, bump: [9, 20], bumpH: [1.6, 4], icicle: [4, 10] },
  sm: { above: 9, hang: 5, bump: [6, 13], bumpH: [1, 2.6], icicle: [3, 6] }
}

export interface SnowCapGeometry {
  /** svg height; the card's top edge is at y = above */
  height: number
  above: number
  /** snow body */
  body: string
  /** icicles ('' = none) */
  icicles: string
}

/** mulberry32 over a string hash: the same seed and width draw the same cap. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const f = (n: number): string => (Math.round(n * 10) / 10).toString()

export function snowCap(
  width: number,
  opts: { seed: string; size?: SnowCapSize; icicles?: boolean }
): SnowCapGeometry {
  const s = SIZES[opts.size ?? 'md']
  const rnd = seededRandom(`${opts.seed}:${Math.round(width)}`)
  const between = (a: number, b: number): number => a + (b - a) * rnd()
  const W = Math.max(24, width)
  const base = s.above + 1.2 // the snow's lower edge, just over the card's border
  const top = 1 + 2 * s.bumpH[1] // the bumps' line: their control points stay at y ≥ 0
  const end = Math.min(14, W / 6) // the ends round over the card corners
  const endDrop = base + s.hang * 0.75

  // top edge, left → right: fluffy bumps
  let d = `M0,${f(endDrop)} C0,${f(top + 3)} ${f(end * 0.3)},${f(top)} ${f(end)},${f(top + 0.5)}`
  let x = end
  while (x < W - end - 4) {
    const w = Math.min(between(s.bump[0], s.bump[1]), W - end - x)
    const y = top + between(-0.8, 1.2)
    d += ` Q${f(x + w / 2)},${f(y - between(s.bumpH[0], s.bumpH[1]) * 2)} ${f(x + w)},${f(y)}`
    x += w
  }
  d += ` C${f(W - end * 0.3)},${f(top)} ${f(W)},${f(top + 3)} ${f(W)},${f(endDrop)}`

  // lower edge, right → left: rounded lobes hanging over the edge
  const lobes: { x: number; w: number }[] = []
  let icicles = ''
  x = W - end
  d += ` Q${f(W - end * 0.4)},${f(base)} ${f(x)},${f(base)}`
  while (x > end + 8) {
    const gap = between(10, 42)
    x -= gap
    if (x < end + 8) break
    const w = Math.min(between(8, 24), x - end)
    const depth = between(s.hang * 0.35, s.hang)
    d += ` L${f(x)},${f(base)} C${f(x)},${f(base + depth * 1.3)} ${f(x - w)},${f(base + depth * 1.3)} ${f(x - w)},${f(base)}`
    lobes.push({ x: x - w / 2, w })
    x -= w
  }
  d += ` L${f(end)},${f(base)} Q${f(end * 0.4)},${f(base)} 0,${f(endDrop)} Z`

  if (opts.icicles) {
    // a few thin icicles: under some lobes and between them
    const spots = lobes.filter(() => rnd() < 0.6).map((l) => l.x)
    for (let i = 0; i < Math.floor(W / 90); i++) spots.push(between(end + 6, W - end - 6))
    for (const cx of spots) {
      const len = between(s.icicle[0], s.icicle[1])
      const hw = between(1.2, 2.2)
      const y0 = base + 0.5
      icicles += `M${f(cx - hw)},${f(y0)} L${f(cx - 0.5)},${f(y0 + len)} Q${f(cx)},${f(y0 + len + 1)} ${f(cx + 0.5)},${f(y0 + len)} L${f(cx + hw)},${f(y0)} Z `
    }
  }

  return {
    height: s.above + s.hang * 1.3 + (opts.icicles ? s.icicle[1] + 2 : 2),
    above: s.above,
    body: d,
    icicles: icicles.trim()
  }
}
