import { create } from 'zustand'
import type { DefaultBehavior, RoutingRule, RulesConfig } from '@shared/types'

interface RulesStore {
  rules: RoutingRule[]
  defaultBehavior: DefaultBehavior
  loaded: boolean
  /** outbound profile names available as rule actions (from subscription) */
  outboundNames: string[]

  load: () => Promise<void>
  loadOutbounds: () => Promise<void>
  persist: () => Promise<void>

  addRule: (rule: Omit<RoutingRule, 'id'>) => Promise<void>
  updateRule: (id: string, patch: Partial<RoutingRule>) => Promise<void>
  removeRule: (id: string) => Promise<void>
  toggleRule: (id: string) => Promise<void>
  reorder: (from: number, to: number) => Promise<void>
  setDefaultBehavior: (b: DefaultBehavior) => Promise<void>

  exportRules: () => Promise<string | null>
  importRules: () => Promise<boolean>
}

function newId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export const useRules = create<RulesStore>((set, get) => ({
  rules: [],
  defaultBehavior: 'auto',
  loaded: false,
  outboundNames: [],

  load: async () => {
    const cfg = await window.api.rules.get()
    set({ rules: cfg.rules, defaultBehavior: cfg.defaultBehavior, loaded: true })
  },

  loadOutbounds: async () => {
    const sub = await window.api.subscription.get()
    set({ outboundNames: sub?.outbounds.map((o) => o.name) ?? [] })
  },

  persist: async () => {
    const { rules, defaultBehavior } = get()
    const cfg: RulesConfig = { rules, defaultBehavior }
    await window.api.rules.set(cfg)
  },

  addRule: async (rule) => {
    set((s) => ({ rules: [...s.rules, { ...rule, id: newId() }] }))
    await get().persist()
  },

  updateRule: async (id, patch) => {
    set((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }))
    await get().persist()
  },

  removeRule: async (id) => {
    set((s) => ({ rules: s.rules.filter((r) => r.id !== id) }))
    await get().persist()
  },

  toggleRule: async (id) => {
    set((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) }))
    await get().persist()
  },

  reorder: async (from, to) => {
    set((s) => {
      const next = s.rules.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { rules: next }
    })
    await get().persist()
  },

  setDefaultBehavior: async (b) => {
    set({ defaultBehavior: b })
    await get().persist()
  },

  exportRules: () => window.api.rules.export(),

  importRules: async () => {
    const cfg = await window.api.rules.import()
    if (!cfg) return false
    set({ rules: cfg.rules, defaultBehavior: cfg.defaultBehavior })
    return true
  }
}))
