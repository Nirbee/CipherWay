import { z } from 'zod'
import { NEW_YEAR_MODES, type NewYearMode } from '@shared/seasonal'

/** Settings → «Новогоднее оформление» (0.7.6): one of the four modes, nothing else. */
export const newYearModeSchema = z.enum(
  NEW_YEAR_MODES as unknown as [NewYearMode, ...NewYearMode[]]
)
