import { create } from 'zustand'
import type { ConnectionState, StatusUpdate, TrafficStats } from '@shared/types'

interface ConnectionStore {
  state: ConnectionState
  activeOutboundId?: string
  message?: string
  traffic: TrafficStats
  globalMode: boolean // true = global, false = split-tunnel
  connectedAt: number | null // ms timestamp when the tunnel came up
  setStatus: (s: StatusUpdate) => void
  setTraffic: (t: TrafficStats) => void
  setGlobalMode: (v: boolean) => void
  connect: (outboundId?: string) => Promise<void>
  disconnect: () => Promise<void>
}

const ZERO_TRAFFIC: TrafficStats = {
  uploadSpeed: 0,
  downloadSpeed: 0,
  totalUpload: 0,
  totalDownload: 0
}

export const useConnection = create<ConnectionStore>((set, get) => ({
  state: 'disconnected',
  traffic: ZERO_TRAFFIC,
  globalMode: false,
  connectedAt: null,
  setStatus: (s) =>
    set((prev) => ({
      state: s.state,
      activeOutboundId: s.activeOutboundId,
      message: s.message,
      connectedAt:
        s.state === 'connected'
          ? (prev.connectedAt ?? Date.now())
          : s.state === 'connecting'
            ? prev.connectedAt
            : null
    })),
  setTraffic: (t) => set({ traffic: t }),
  setGlobalMode: (v) => set({ globalMode: v }),
  connect: async (outboundId) => {
    set({ state: 'connecting' })
    const s = await window.api.vpn.connect(outboundId ?? get().activeOutboundId)
    get().setStatus(s)
  },
  disconnect: async () => {
    const s = await window.api.vpn.disconnect()
    get().setStatus(s)
    set({ traffic: ZERO_TRAFFIC })
  }
}))
