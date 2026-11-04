import { create } from 'zustand'
import type { LogEntry } from '@shared/types'
import { appendCapped, UI_LOG_LIMIT } from '@shared/logBuffer'

interface LogsStore {
  entries: LogEntry[]
  /** a batch from main (see LogBatcher); only the newest UI_LOG_LIMIT are kept */
  addBatch: (batch: LogEntry[]) => void
  clear: () => void
}

export const useLogs = create<LogsStore>((set) => ({
  entries: [],
  addBatch: (batch) =>
    set((s) => (batch.length ? { entries: appendCapped(s.entries, batch, UI_LOG_LIMIT) } : s)),
  clear: () => set({ entries: [] })
}))
