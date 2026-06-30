import { create } from 'zustand'
import type { SubscriptionData } from '@shared/types'

interface SubscriptionStore {
  data: SubscriptionData | null
  loading: boolean
  error: string | null
  load: () => Promise<void>
  fetch: (url: string) => Promise<boolean>
  refresh: () => Promise<void>
}

export const useSubscription = create<SubscriptionStore>((set) => ({
  data: null,
  loading: false,
  error: null,
  load: async () => {
    const data = await window.api.subscription.get()
    set({ data })
  },
  fetch: async (url) => {
    set({ loading: true, error: null })
    try {
      const data = await window.api.subscription.fetch(url)
      set({ data, loading: false })
      return true
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) })
      return false
    }
  },
  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const data = await window.api.subscription.refresh()
      set({ data, loading: false })
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
}))
