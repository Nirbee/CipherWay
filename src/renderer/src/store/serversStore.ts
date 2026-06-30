import { create } from 'zustand'

interface ServersStore {
  pings: Record<string, number | null>
  pinging: boolean
  activeId: string | null
  setActive: (id: string) => Promise<void>
  ping: () => Promise<void>
  loadActive: () => Promise<void>
}

export const useServers = create<ServersStore>((set) => ({
  pings: {},
  pinging: false,
  activeId: null,
  setActive: async (id) => {
    await window.api.servers.select(id)
    set({ activeId: id })
  },
  ping: async () => {
    set({ pinging: true })
    const results = await window.api.servers.ping()
    const pings: Record<string, number | null> = {}
    for (const r of results) pings[r.outboundId] = r.latencyMs
    set({ pings, pinging: false })
  },
  loadActive: async () => {
    const status = await window.api.vpn.getStatus()
    if (status.activeOutboundId) set({ activeId: status.activeOutboundId })
  }
}))
