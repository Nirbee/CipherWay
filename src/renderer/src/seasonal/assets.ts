// Pictures of «Новогоднее оформление»: src/renderer/src/assets/newyear/<name>.webp.
// Looked up with import.meta.glob, so a missing file is not a build error — the
// layer then draws its simple vector stand-in instead.

export type SnowStrip = 'a' | 'b'
export type NewYearAsset =
  | 'bg'
  | 'left'
  | 'right'
  | 'garland'
  | 'bow'
  | 'hat'
  | `snow-${SnowStrip}-${'left' | 'mid' | 'right'}`

const FILES = import.meta.glob('../assets/newyear/*.webp', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

export function newYearAsset(name: NewYearAsset): string | null {
  return FILES[`../assets/newyear/${name}.webp`] ?? null
}

/**
 * Lights of garland.webp (x, y as fractions of the picture), found in the picture
 * when it was cut from the sheet: the soft twinkle is drawn right over them.
 */
export const GARLAND_LIGHTS: readonly [number, number][] = [
  [0.077, 0.291],
  [0.156, 0.518],
  [0.223, 0.568],
  [0.303, 0.483],
  [0.394, 0.555],
  [0.467, 0.475],
  [0.535, 0.45],
  [0.626, 0.58],
  [0.7, 0.451],
  [0.801, 0.566],
  [0.874, 0.484],
  [0.909, 0.318]
]
/**
 * Snow strips snow-<strip>-{left,mid,right}.webp, cut from one painted sheet:
 * the ends as drawn, the middle a seamless tile (repeated across any width).
 * Picture px: h — height of all three pieces, left / mid / right — widths,
 * edge — the card's top edge from the picture's top.
 * a — long strip with icicles (banner, server panel), b — cards (and, smaller, the menu).
 */
export const SNOW_STRIPS: Record<
  SnowStrip,
  { h: number; left: number; mid: number; right: number; edge: number }
> = {
  a: { h: 121, left: 230, mid: 510, right: 237, edge: 66 },
  b: { h: 123, left: 224, mid: 510, right: 222, edge: 55 }
}

/** garland.webp is 560×101 */
export const GARLAND_ASPECT = 560 / 101

/**
 * hat.webp was cut from a picture of the hat worn on a ring: where that ring was,
 * in hat.webp px (center x, y and outer radius) — the hat is laid onto our ring
 * by matching the two.
 */
export const HAT_RING = { w: 624, h: 577, cx: 94.5, cy: 445.5, r: 294.5 }
