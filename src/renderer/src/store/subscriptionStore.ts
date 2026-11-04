import { create } from 'zustand'
import type { SubscriptionView } from '@shared/types'
import { errorText } from '../lib/format'

interface SubscriptionStore {
  data: SubscriptionView | null
  loaded: boolean
  loading: boolean
  error: string | null
  load: () => Promise<void>
  set: (data: SubscriptionView | null) => void
  fetch: (url: string) => Promise<boolean>
  refresh: () => Promise<void>
}

export const useSubscription = create<SubscriptionStore>((set) => ({
  data: null,
  loaded: false,
  loading: false,
  error: null,
  load: async () => {
    const data = await window.api.subscription.get()
    set({ data, loaded: true })
  },
  set: (data) => set({ data, loaded: true }),
  fetch: async (url) => {
    set({ loading: true, error: null })
    try {
      const data = await window.api.subscription.fetch(url)
      set({ data, loading: false, loaded: true })
      return true
    } catch (e) {
      set({ loading: false, error: errorText(e) })
      return false
    }
  },
  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const data = await window.api.subscription.refresh()
      set({ data, loading: false })
    } catch (e) {
      set({ loading: false, error: errorText(e) })
    }
  }
}))
