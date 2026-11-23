import { create } from 'zustand'
import { DEV_STATUS_OFF, type DevStatus } from '@shared/devversion'

// «DevVersion» status for the theme, the sidebar and Settings. Only the
// renderer turns the mode on / off, so it is loaded once and set after each
// change — no events from main.
interface DevStore {
  status: DevStatus
  load: () => Promise<void>
  set: (s: DevStatus) => void
}

export const useDev = create<DevStore>((set) => ({
  status: DEV_STATUS_OFF,
  load: async () => set({ status: await window.api.dev.get() }),
  set: (status) => set({ status })
}))
