import { create } from 'zustand'

export type PageKey =
  | 'home'
  | 'servers'
  | 'connections'
  | 'lan'
  | 'rules'
  | 'subscription'
  | 'support'
  | 'logs'
  | 'settings'
  /** «Статистика» — only while DevVersion is on */
  | 'stats'

export const PAGE_KEYS: readonly PageKey[] = [
  'home',
  'servers',
  'connections',
  'lan',
  'rules',
  'subscription',
  'support',
  'logs',
  'settings',
  'stats'
]

interface NavState {
  page: PageKey
  setPage: (p: PageKey) => void
}

export const useNav = create<NavState>((set) => ({
  page: 'home',
  setPage: (page) => set({ page })
}))
