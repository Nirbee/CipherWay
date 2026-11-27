import { useState } from 'react'
import { HAT_RING, newYearAsset } from './assets'
import { HatStandIn } from './standins'
import { useNewYear } from './useNewYear'

/** the connect button's ring: center and outer radius in its 196×196 box */
const RING = { cx: 98, cy: 98, r: 92.5 }

/**
 * Santa's hat worn on the ring of the big connect button: the fur brim lies over
 * the ring's top-right arc. A sibling of the button inside a `relative` wrapper:
 * it doesn't fade with the disabled button and never takes a click.
 */
export function SantaHat() {
  const level = useNewYear()
  const [src, setSrc] = useState(() => newYearAsset('hat'))
  if (level === 'off') return null
  if (!src) {
    return (
      <span
        aria-hidden
        className="ny-hat pointer-events-none absolute z-10 block"
        style={{
          width: 132,
          height: 102,
          left: '50%',
          top: -50,
          transform: 'translateX(-38%) rotate(13deg)',
          transformOrigin: '30% 85%'
        }}
      >
        <HatStandIn />
      </span>
    )
  }
  // lay the picture's ring onto ours
  const k = RING.r / HAT_RING.r
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setSrc(null)}
      className="ny-hat pointer-events-none absolute z-10 block max-w-none select-none drop-shadow-[0_4px_6px_rgba(0,0,0,0.45)]"
      style={{
        width: HAT_RING.w * k,
        height: HAT_RING.h * k,
        left: RING.cx - HAT_RING.cx * k,
        top: RING.cy - HAT_RING.cy * k
      }}
    />
  )
}
