import { create } from 'zustand'

export type PageKey =
  'home' | 'servers' | 'connections' | 'rules' | 'subscription' | 'support' | 'logs' | 'settings'

export const PAGE_KEYS: readonly PageKey[] = [
  'home',
  'servers',
  'connections',
  'rules',
  'subscription',
  'support',
  'logs',
  'settings'
]

interface NavState {
  page: PageKey
  setPage: (p: PageKey) => void
}

export const useNav = create<NavState>((set) => ({
  page: 'home',
  setPage: (page) => set({ page })
}))
