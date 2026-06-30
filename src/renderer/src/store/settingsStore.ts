import { create } from 'zustand'
import type { AppSettings } from '@shared/types'

interface SettingsStore {
  settings: AppSettings | null
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
}

export const useSettings = create<SettingsStore>((set) => ({
  settings: null,
  load: async () => set({ settings: await window.api.settings.get() }),
  update: async (patch) => set({ settings: await window.api.settings.set(patch) })
}))
