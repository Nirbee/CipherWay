import { z } from 'zod'
import { DEV_CONSENT_VERSION } from '@shared/devversion'

// IPC payloads of «DevVersion» (handlers.ts). Turning it on needs exactly
// {accepted: true, consentVersion: <the current text>} — the dialog sends that
// only with its box ticked (canEnableDev); anything else is refused here.

export const devAcceptSchema = z
  .object({
    accepted: z.literal(true),
    consentVersion: z.literal(DEV_CONSENT_VERSION)
  })
  .strict()

/** a process name from the «Тест игры» list: a file name, no path */
export const devProcessSchema = z
  .string()
  .min(1)
  .max(260)
  .regex(/^[^\\/:*?"<>|]+$/, 'bad process name')
