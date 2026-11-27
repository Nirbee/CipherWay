// ---------------------------------------------------------------------------
// «Новогоднее оформление» (0.7.6): which decorations the window shows.
// Pure — unit tested in seasonal.test.ts.
// ---------------------------------------------------------------------------

/**
 * Settings → «Оформление»:
 *  - auto: «full» in the season (1 December … 14 January, local date), off otherwise
 *  - light: snow caps, the hat, the garland, falling snow — no pictures
 *  - full: light + the night background and the pictures at the window edges
 *  - off: nothing
 */
export type NewYearMode = 'auto' | 'light' | 'full' | 'off'
export const NEW_YEAR_MODES: readonly NewYearMode[] = ['auto', 'light', 'full', 'off']
export const DEFAULT_NEW_YEAR_MODE: NewYearMode = 'auto'

/** What is actually drawn right now. */
export type NewYearLevel = 'off' | 'light' | 'full'

/** The season by the local calendar date: 1 December … 14 January inclusive. */
export function isNewYearSeason(date: Date): boolean {
  const month = date.getMonth() // 0 = January
  const day = date.getDate()
  return month === 11 || (month === 0 && day <= 14)
}

/** A stored value of any shape → a valid mode (an older / edited store can't break it). */
export function sanitizeNewYearMode(value: unknown): NewYearMode {
  return (NEW_YEAR_MODES as readonly unknown[]).includes(value)
    ? (value as NewYearMode)
    : DEFAULT_NEW_YEAR_MODE
}

export function resolveNewYear(mode: unknown, date: Date): NewYearLevel {
  const m = sanitizeNewYearMode(mode)
  if (m === 'auto') return isNewYearSeason(date) ? 'full' : 'off'
  return m
}
