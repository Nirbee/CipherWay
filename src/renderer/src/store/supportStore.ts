import { create } from 'zustand'
import type { SupportImageMime, SupportView } from '@shared/types'
import { errorText } from '../lib/format'

/** Mirrors the main process's SupportService; all requests are made there. */
interface SupportStore {
  view: SupportView | null
  loading: boolean
  sending: boolean
  /** error of the last send (the view carries the polling error) */
  sendError: string | null
  apply: (v: SupportView) => void
  refresh: () => Promise<void>
  sendText: (text: string) => Promise<boolean>
  sendPhoto: (data: Uint8Array, mime: SupportImageMime, caption: string) => Promise<boolean>
  clearSendError: () => void
}

export const useSupport = create<SupportStore>((set, get) => ({
  view: null,
  loading: false,
  sending: false,
  sendError: null,
  apply: (view) => set({ view }),
  refresh: async () => {
    set({ loading: true })
    try {
      set({ view: await window.api.support.refresh() })
    } finally {
      set({ loading: false })
    }
  },
  sendText: async (text) => {
    if (get().sending) return false
    set({ sending: true, sendError: null })
    try {
      await window.api.support.send(text)
      return true
    } catch (e) {
      set({ sendError: errorText(e) })
      return false
    } finally {
      set({ sending: false })
    }
  },
  sendPhoto: async (data, mime, caption) => {
    if (get().sending) return false
    set({ sending: true, sendError: null })
    try {
      await window.api.support.sendPhoto({ data, mime, caption })
      return true
    } catch (e) {
      set({ sendError: errorText(e) })
      return false
    } finally {
      set({ sending: false })
    }
  },
  clearSendError: () => set({ sendError: null })
}))
