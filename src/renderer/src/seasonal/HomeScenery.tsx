import { useState } from 'react'
import { newYearAsset } from './assets'
import { TreeStandIn } from './standins'
import { useNewYear } from './useNewYear'

/**
 * Px: the width of the home page's content (760 max − 2 × 28 padding). The
 * pictures at the edges live only in the space beside it: on a narrow window
 * they get smaller, then slide out past the window edge — they never go over
 * the connect button or the panels.
 */
const CONTENT = 704
const FREE = `((100% - ${CONTENT}px) / 2)`
const EDGE_W = `clamp(120px, calc(${FREE} + 20px), 250px)`
const EDGE_SHIFT = `min(0px, calc(${FREE} - ${EDGE_W}))`

/** «Полное» on the home page: the night background (dimmed) + the tree and the cat. */
export function HomeScenery() {
  const level = useNewYear()
  const [bg, setBg] = useState(() => newYearAsset('bg'))
  const [left, setLeft] = useState(() => newYearAsset('left'))
  const [right, setRight] = useState(() => newYearAsset('right'))
  if (level !== 'full') return null

  return (
    <div aria-hidden className="ny-scenery pointer-events-none absolute inset-0 overflow-hidden">
      {bg ? (
        <img
          src={bg}
          alt=""
          draggable={false}
          onError={() => setBg(null)}
          className="absolute inset-0 h-full w-full object-cover object-bottom"
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(1px 1px at 20% 18%, #fff8, transparent), radial-gradient(1px 1px at 63% 9%, #fff7, transparent), radial-gradient(1.5px 1.5px at 82% 26%, #fff6, transparent), linear-gradient(#0b1430, #101c3c 60%, #1b2a4e)'
          }}
        />
      )}
      {/* dimmed: the interface stays readable */}
      <div className="absolute inset-0 bg-[rgba(6,10,22,0.32)]" />
      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[rgba(6,10,22,0.45)] to-transparent" />

      <div className="absolute bottom-0" style={{ left: EDGE_SHIFT, width: EDGE_W }}>
        {left ? (
          <img
            src={left}
            alt=""
            draggable={false}
            onError={() => setLeft(null)}
            className="block h-auto max-h-[calc(100vh-80px)] w-full object-contain object-left-bottom"
          />
        ) : (
          <div className="aspect-[1/2] w-full">
            <TreeStandIn />
          </div>
        )}
      </div>
      {right && (
        <div className="absolute bottom-0" style={{ right: EDGE_SHIFT, width: EDGE_W }}>
          <img
            src={right}
            alt=""
            draggable={false}
            onError={() => setRight(null)}
            className="block h-auto max-h-[calc(100vh-80px)] w-full object-contain object-right-bottom"
          />
        </div>
      )}
    </div>
  )
}
