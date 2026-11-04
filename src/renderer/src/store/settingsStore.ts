import { create } from 'zustand'
import type { AppSettings, RoutingMode } from '@shared/types'

interface SettingsStore {
  settings: AppSettings | null
  load: () => Promise<void>
  apply: (s: AppSettings) => void
  update: (patch: Partial<AppSettings>) => Promise<void>
  /** Правила / Весь трафик / Напрямую — applied to the running core at once */
  setRoutingMode: (mode: RoutingMode) => Promise<void>
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: null,
  load: async () => set({ settings: await window.api.settings.get() }),
  apply: (s) => set({ settings: s }),
  update: async (patch) => set({ settings: await window.api.settings.set(patch) }),
  setRoutingMode: async (mode) => {
    const prev = get().settings
    if (prev) set({ settings: { ...prev, routingMode: mode } }) // optimistic
    set({ settings: await window.api.vpn.setRoutingMode(mode) })
  }
}))
