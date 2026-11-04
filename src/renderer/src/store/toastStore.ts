import { create } from 'zustand'

export type ToastTone = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  text: string
  tone: ToastTone
}

interface ToastStore {
  toasts: Toast[]
  push: (text: string, tone?: ToastTone) => void
  dismiss: (id: number) => void
}

let seq = 0

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (text, tone = 'info') => {
    const id = ++seq
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }))
    setTimeout(() => get().dismiss(id), tone === 'error' ? 6000 : 3200)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/** shorthand outside React components */
export const toast = (text: string, tone?: ToastTone): void => useToasts.getState().push(text, tone)
