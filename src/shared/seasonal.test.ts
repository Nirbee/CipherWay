import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NEW_YEAR_MODE,
  NEW_YEAR_MODES,
  isNewYearSeason,
  resolveNewYear,
  sanitizeNewYearMode
} from './seasonal'

// local dates (month is 0-based): the season follows the user's calendar, not UTC
const d = (y: number, m: number, day: number, h = 12, min = 0): Date =>
  new Date(y, m - 1, day, h, min)

describe('новогодний сезон', () => {
  it('starts on 1 December at midnight', () => {
    expect(isNewYearSeason(d(2026, 11, 30, 23, 59))).toBe(false)
    expect(isNewYearSeason(d(2026, 12, 1, 0, 0))).toBe(true)
  })

  it('goes on through the new year', () => {
    expect(isNewYearSeason(d(2026, 12, 15))).toBe(true)
    expect(isNewYearSeason(d(2026, 12, 31, 23, 59))).toBe(true)
    expect(isNewYearSeason(d(2027, 1, 1, 0, 0))).toBe(true)
    expect(isNewYearSeason(d(2027, 1, 7))).toBe(true)
  })

  it('ends after 14 January', () => {
    expect(isNewYearSeason(d(2027, 1, 14, 23, 59))).toBe(true)
    expect(isNewYearSeason(d(2027, 1, 15, 0, 0))).toBe(false)
  })

  it('is off the rest of the year (leap day included)', () => {
    for (const date of [d(2027, 2, 1), d(2028, 2, 29), d(2027, 6, 1), d(2027, 11, 1)]) {
      expect(isNewYearSeason(date)).toBe(false)
    }
  })
})

describe('«Новогоднее оформление»', () => {
  it('«Авто» = «Полное» in the season, «Выкл» outside it', () => {
    expect(resolveNewYear('auto', d(2026, 12, 1))).toBe('full')
    expect(resolveNewYear('auto', d(2027, 1, 14))).toBe('full')
    expect(resolveNewYear('auto', d(2027, 1, 15))).toBe('off')
    expect(resolveNewYear('auto', d(2026, 11, 27))).toBe('off')
  })

  it('a chosen level does not depend on the date', () => {
    for (const date of [d(2026, 7, 1), d(2026, 12, 31)]) {
      expect(resolveNewYear('light', date)).toBe('light')
      expect(resolveNewYear('full', date)).toBe('full')
      expect(resolveNewYear('off', date)).toBe('off')
    }
  })

  it('«Авто» by default; a broken stored value falls back to it', () => {
    expect(DEFAULT_NEW_YEAR_MODE).toBe('auto')
    expect(NEW_YEAR_MODES).toEqual(['auto', 'light', 'full', 'off'])
    for (const m of NEW_YEAR_MODES) expect(sanitizeNewYearMode(m)).toBe(m)
    for (const bad of [undefined, null, '', 'FULL', 1, {}]) {
      expect(sanitizeNewYearMode(bad)).toBe('auto')
    }
    expect(resolveNewYear(undefined, d(2026, 12, 25))).toBe('full')
    expect(resolveNewYear('oops', d(2026, 6, 1))).toBe('off')
  })
})
