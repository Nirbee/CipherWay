import { create } from 'zustand'
import { AUTO_OUTBOUND_ID, type ServerPing } from '@shared/types'
import { errorText } from '../lib/format'
import { toast } from './toastStore'

/** automatic re-test (page open / picker open) at most once a minute */
const AUTO_TEST_MIN_INTERVAL_MS = 60_000

interface ServersStore {
  /** latency in ms per server id; null = no response; missing = not tested */
  pings: Record<string, number | null>
  testing: boolean
  testedAt: number | null
  activeId: string
  /** run the core-based latency test (force = ignore the 1/min limit) */
  test: (force?: boolean) => Promise<void>
  select: (id: string) => Promise<void>
  loadActive: () => Promise<void>
  setActiveLocal: (id: string | undefined) => void
  /** results of the running core's own check (pushed by main) */
  applyPings: (pings: ServerPing[]) => void
}

export const useServers = create<ServersStore>((set, get) => ({
  pings: {},
  testing: false,
  testedAt: null,
  activeId: AUTO_OUTBOUND_ID,
  test: async (force = false) => {
    const { testing, testedAt } = get()
    if (testing) return
    if (!force && testedAt && Date.now() - testedAt < AUTO_TEST_MIN_INTERVAL_MS) return
    set({ testing: true })
    try {
      const results = await window.api.servers.ping()
      const pings: Record<string, number | null> = {}
      for (const r of results) pings[r.outboundId] = r.latencyMs
      set({ pings, testedAt: Date.now() })
    } catch (e) {
      toast(`Проверка не удалась: ${errorText(e)}`, 'error')
    } finally {
      set({ testing: false })
    }
  },
  select: async (id) => {
    const prev = get().activeId
    set({ activeId: id })
    try {
      await window.api.servers.select(id)
    } catch (e) {
      set({ activeId: prev })
      toast(`Не удалось выбрать сервер: ${errorText(e)}`, 'error')
    }
  },
  loadActive: async () => {
    const status = await window.api.vpn.getStatus()
    set({ activeId: status.activeOutboundId ?? AUTO_OUTBOUND_ID })
  },
  setActiveLocal: (id) => set({ activeId: id ?? AUTO_OUTBOUND_ID }),
  applyPings: (results) => {
    const pings = { ...get().pings }
    for (const r of results) pings[r.outboundId] = r.latencyMs
    set({ pings, testedAt: Date.now() })
  }
}))
