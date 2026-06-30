import { create } from 'zustand'
import type { UpdaterEvent } from '@shared/ipc'

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

interface UpdaterStore {
  phase: UpdaterPhase
  version: string | null
  percent: number
  error: string | null
  apply: (e: UpdaterEvent) => void
  check: () => void
  download: () => void
  install: () => void
}

export const useUpdater = create<UpdaterStore>((set) => ({
  phase: 'idle',
  version: null,
  percent: 0,
  error: null,
  apply: (e) =>
    set((s) => {
      switch (e.type) {
        case 'checking':
          return { phase: 'checking', error: null }
        case 'available':
          return { phase: 'available', version: e.version ?? s.version }
        case 'not-available':
          return { phase: 'not-available' }
        case 'progress':
          return { phase: 'downloading', percent: e.percent ?? s.percent }
        case 'downloaded':
          return { phase: 'downloaded', version: e.version ?? s.version, percent: 100 }
        case 'error':
          return { phase: 'error', error: e.message ?? 'Ошибка обновления' }
        default:
          return s
      }
    }),
  check: () => {
    set({ phase: 'checking', error: null })
    void window.api.updater.check()
  },
  download: () => {
    set({ phase: 'downloading', percent: 0 })
    void window.api.updater.download()
  },
  install: () => window.api.updater.install()
}))
