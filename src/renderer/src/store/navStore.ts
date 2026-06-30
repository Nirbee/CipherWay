import { create } from 'zustand'

export type PageKey =
  | 'home'
  | 'servers'
  | 'subscription'
  | 'connectors'
  | 'rules'
  | 'logs'
  | 'settings'

interface NavState {
  page: PageKey
  setPage: (p: PageKey) => void
}

export const useNav = create<NavState>((set) => ({
  page: 'rules', // matches the active screen in the reference mockup
  setPage: (page) => set({ page })
}))
