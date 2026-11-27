import { useLayoutEffect, useRef, useState } from 'react'
import { GARLAND_ASPECT, GARLAND_LIGHTS, newYearAsset } from './assets'
import { BowStandIn, GarlandStandIn } from './standins'
import { useNewYear } from './useNewYear'
import { seededRandom } from './snowShape'

/** px: the garland's height; copies overlap a little so no gap shows */
const HEIGHT = 40
const OVERLAP = 10

/**
 * The pine garland along the top edge of the window with the red bow in the
 * middle. One picture repeated (every other copy mirrored, so the ends meet the
 * same way) + soft twinkling lights over the picture's own bulbs. No clicks.
 */
export function Garland() {
  const level = useNewYear()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [garland, setGarland] = useState(() => newYearAsset('garland'))
  const [bow, setBow] = useState(() => newYearAsset('bow'))

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [level])

  if (level === 'off') return null

  const copyW = Math.round(HEIGHT * GARLAND_ASPECT)
  const step = copyW - OVERLAP
  const copies = width ? Math.ceil(width / step) + 1 : 0
  // the copies are laid out from the middle so the bow sits on a joint-free spot
  const start = Math.round(width / 2 - copyW / 2 - Math.ceil(copies / 2) * step)
  const rnd = seededRandom('garland')

  return (
    <div
      ref={ref}
      aria-hidden
      className="ny-garland pointer-events-none absolute inset-x-0 top-0 z-[3] overflow-hidden"
      style={{ height: HEIGHT + 14 }}
    >
      {Array.from({ length: copies + 1 }, (_, i) => {
        const left = start + i * step
        const mirror = i % 2 === 1
        return (
          <div key={i} className="absolute" style={{ left, top: -3, width: copyW, height: HEIGHT }}>
            {garland ? (
              <img
                src={garland}
                alt=""
                draggable={false}
                onError={() => setGarland(null)}
                className="h-full w-full"
                style={{ transform: mirror ? 'scaleX(-1)' : undefined }}
              />
            ) : (
              <GarlandStandIn mirror={mirror} />
            )}
            {GARLAND_LIGHTS.map(([fx, fy], j) => (
              <span
                key={j}
                className="ny-light"
                style={{
                  left: `${(mirror ? 1 - fx : fx) * 100}%`,
                  top: `${fy * 100}%`,
                  animationDelay: `${(-rnd() * 3).toFixed(2)}s`,
                  animationDuration: `${(2.2 + rnd() * 1.8).toFixed(2)}s`
                }}
              />
            ))}
          </div>
        )
      })}
      <div className="absolute left-1/2 top-[1px] h-[46px] w-[46px] -translate-x-1/2">
        {bow ? (
          <img
            src={bow}
            alt=""
            draggable={false}
            onError={() => setBow(null)}
            className="h-full w-full object-contain drop-shadow-[0_2px_3px_rgba(0,0,0,0.45)]"
          />
        ) : (
          <BowStandIn />
        )}
      </div>
    </div>
  )
}
