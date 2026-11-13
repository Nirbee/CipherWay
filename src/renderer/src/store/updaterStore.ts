import { create } from 'zustand'
import { INITIAL_UPDATER_STATE, type UpdaterState } from '@shared/updater'
import { toast } from './toastStore'

// Mirror of the main-process update state (src/main/updater/AppUpdater.ts).
// Main checks by itself; this store only shows the result and forwards clicks.

interface UpdaterStore {
  state: UpdaterState
  /** a whole state from main (event or reply) */
  set: (s: UpdaterState) => void
  load: () => Promise<void>
  check: () => void
  download: () => void
  install: () => void
}

export const useUpdater = create<UpdaterStore>((set, get) => ({
  state: INITIAL_UPDATER_STATE,
  set: (next) => {
    const prev = get().state
    set({ state: next })
    // one short toast per failed user action (background failures never get here)
    if (next.errorSeq > prev.errorSeq && next.error) toast(next.error, 'error')
  },
  load: async () => {
    const s = await window.api.updater.getState()
    // don't toast an error that happened before the window opened
    set({ state: s })
  },
  // the outcome arrives as evtUpdater (wired in App.tsx), never from the reply:
  // one source, no reordering
  check: () => {
    void window.api.updater.check()
  },
  download: () => {
    void window.api.updater.download()
  },
  install: () => window.api.updater.install()
}))
