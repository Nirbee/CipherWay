import { create } from 'zustand'
import type { SubscriptionView } from '@shared/types'
import { errorText } from '../lib/format'
import { toast } from './toastStore'

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
      const { view, changed } = await window.api.subscription.refresh()
      set({ data: view, loading: false })
      toast(changed ? 'Обновлено' : 'Новых изменений нет', changed ? 'success' : 'info')
    } catch (e) {
      const text = errorText(e)
      set({ loading: false, error: text })
      toast(`Подписка не обновилась: ${text}`, 'error')
    }
  }
}))
