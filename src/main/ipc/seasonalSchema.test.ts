import { describe, expect, it } from 'vitest'
import { NEW_YEAR_MODES } from '@shared/seasonal'
import { newYearModeSchema } from './seasonalSchema'

describe('settings: «Новогоднее оформление»', () => {
  it('takes the four modes', () => {
    for (const m of NEW_YEAR_MODES) expect(newYearModeSchema.parse(m)).toBe(m)
  })

  it('rejects anything else from the renderer', () => {
    for (const bad of ['', 'Auto', 'on', 1, null, undefined, {}]) {
      expect(newYearModeSchema.safeParse(bad).success).toBe(false)
    }
  })
})
