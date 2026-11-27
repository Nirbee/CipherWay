import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { newYearAsset, SNOW_STRIPS, type SnowStrip } from './assets'
import { seededRandom, snowCap, type SnowCapSize } from './snowShape'
import { useNewYear } from './useNewYear'

/** picture px → css px */
const SCALE: Record<SnowCapSize, number> = { md: 0.32, sm: 0.2 }
/** css px the ends overlap the middle (cross-faded) */
const OVERLAP: Record<SnowCapSize, number> = { md: 12, sm: 8 }

function stripPictures(strip: SnowStrip): { left: string; mid: string; right: string } | null {
  const left = newYearAsset(`snow-${strip}-left`)
  const mid = newYearAsset(`snow-${strip}-mid`)
  const right = newYearAsset(`snow-${strip}-right`)
  return left && mid && right ? { left, mid, right } : null
}

/**
 * Snow lying on the top edge of the parent (it must be `relative`). Purely
 * decorative: no clicks, no layout change — it's drawn over the edge.
 * Painted strips (assets/newyear/snow-*.webp) when present, else a vector cap.
 */
export function SnowCap({
  seed,
  size = 'md',
  icicles = false,
  inset = -3
}: {
  /** a stable name: the same card keeps the same snow */
  seed: string
  size?: SnowCapSize
  icicles?: boolean
  /** px past the parent's left / right edges */
  inset?: number
}) {
  const level = useNewYear()
  const ref = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(0)
  const uid = useId().replace(/:/g, '')

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [level])

  // the small cap is the card strip, just smaller: a long tile doesn't repeat visibly
  const strip: SnowStrip = icicles && size === 'md' ? 'a' : 'b'
  const pics = stripPictures(strip)
  const geo = useMemo(
    () => (pics ? null : snowCap(width || 200, { seed, size, icicles })),
    [pics, width, seed, size, icicles]
  )
  // the same card keeps the same look: tile phase and which way the strip faces
  const look = useMemo(() => {
    const rnd = seededRandom(seed)
    return { phase: rnd(), flip: rnd() < 0.5 }
  }, [seed])
  if (level === 'off') return null

  if (pics) {
    const spec = SNOW_STRIPS[strip]
    const k = SCALE[size]
    const h = spec.h * k
    const half = width > 0 ? width / 2 : Infinity
    const lw = Math.min(spec.left * k, half)
    const rw = Math.min(spec.right * k, half)
    const tile = spec.mid * k
    const ov = OVERLAP[size]
    const fade = (dir: 'right' | 'left'): CSSProperties => {
      const m = `linear-gradient(to ${dir}, #000 calc(100% - ${ov}px), transparent)`
      return { maskImage: m, WebkitMaskImage: m }
    }
    return (
      <span
        ref={ref}
        aria-hidden
        className="ny-snowcap pointer-events-none absolute z-[6] block"
        style={{
          left: inset,
          right: inset,
          top: -spec.edge * k,
          height: h,
          transform: look.flip ? 'scaleX(-1)' : undefined
        }}
      >
        {width > 0 && (
          <>
            <span
              className="absolute inset-y-0 block"
              style={{
                left: Math.max(0, lw - ov),
                right: Math.max(0, rw - ov),
                backgroundImage: `url(${pics.mid})`,
                backgroundRepeat: 'repeat-x',
                backgroundSize: `${tile}px ${h}px`,
                backgroundPosition: `${-Math.round(look.phase * tile)}px 0`
              }}
            />
            <img
              src={pics.left}
              alt=""
              draggable={false}
              className="absolute left-0 top-0 block select-none"
              style={{ width: lw, height: h, objectFit: 'cover', objectPosition: 'left', ...fade('right') }}
            />
            <img
              src={pics.right}
              alt=""
              draggable={false}
              className="absolute right-0 top-0 block select-none"
              style={{ width: rw, height: h, objectFit: 'cover', objectPosition: 'right', ...fade('left') }}
            />
          </>
        )}
      </span>
    )
  }

  const g = geo ?? snowCap(200, { seed, size, icicles })
  return (
    <span
      ref={ref}
      aria-hidden
      className="ny-snowcap pointer-events-none absolute z-[6] block"
      style={{ left: inset, right: inset, top: -g.above, height: g.height }}
    >
      {width > 0 && (
        <svg width={width} height={g.height} className="block overflow-visible">
          <defs>
            <linearGradient id={`ny-snow-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="55%" stopColor="#f3f7ff" />
              <stop offset="100%" stopColor="#c5d8f2" />
            </linearGradient>
            <linearGradient id={`ny-ice-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#eef6ff" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#9cc4ee" stopOpacity="0.35" />
            </linearGradient>
          </defs>
          {/* blue shade under the snow */}
          <path d={g.body} fill="#7d9fcc" opacity="0.5" transform="translate(0 1.6)" />
          <path d={g.body} fill={`url(#ny-snow-${uid})`} />
          {g.icicles && <path d={g.icicles} fill={`url(#ny-ice-${uid})`} />}
        </svg>
      )}
    </span>
  )
}
