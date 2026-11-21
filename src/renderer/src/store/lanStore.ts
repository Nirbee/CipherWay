import { create } from 'zustand'
import type { LanView } from '@shared/types'
import { errorText } from '../lib/format'
import { toast } from './toastStore'

/** Mirrors the main process's LanService; every request is made there. */
interface LanStore {
  view: LanView | null
  /** a switch / room operation is running */
  busy: boolean
  apply: (v: LanView) => void
  load: () => Promise<void>
  /** runs a main-process operation; errors become a toast, the new view is applied */
  run: (op: () => Promise<LanView>, ok?: string) => Promise<boolean>
}

export const useLan = create<LanStore>((set, get) => ({
  view: null,
  busy: false,
  apply: (view) => set({ view }),
  load: async () => set({ view: await window.api.lan.get() }),
  run: async (op, ok) => {
    if (get().busy) return false
    set({ busy: true })
    try {
      set({ view: await op() })
      if (ok) toast(ok, 'success')
      return true
    } catch (e) {
      toast(errorText(e), 'error')
      return false
    } finally {
      set({ busy: false })
    }
  }
}))
