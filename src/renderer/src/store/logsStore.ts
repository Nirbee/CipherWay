import { create } from 'zustand'
import type { LogEntry } from '@shared/types'

const MAX = 1000

interface LogsStore {
  entries: LogEntry[]
  add: (e: LogEntry) => void
  clear: () => void
}

export const useLogs = create<LogsStore>((set) => ({
  entries: [],
  add: (e) =>
    set((s) => {
      const next = s.entries.length >= MAX ? s.entries.slice(-MAX + 1) : s.entries.slice()
      next.push(e)
      return { entries: next }
    }),
  clear: () => set({ entries: [] })
}))
