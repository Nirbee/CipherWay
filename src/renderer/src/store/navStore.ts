import { create } from 'zustand'

export type PageKey =
  | 'home'
  | 'servers'
  | 'connections'
  | 'rules'
  | 'subscription'
  | 'logs'
  | 'settings'

interface NavState {
  page: PageKey
  setPage: (p: PageKey) => void
}

export const useNav = create<NavState>((set) => ({
  page: 'home',
  setPage: (page) => set({ page })
}))
