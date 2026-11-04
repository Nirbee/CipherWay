import { create } from 'zustand'
import type { ConnectionState, StatusUpdate, TrafficStats } from '@shared/types'

interface ConnectionStore {
  state: ConnectionState
  activeOutboundId?: string
  /** node picked by «Лучший сервер (авто)» while connected */
  autoSelectedId?: string
  message?: string
  traffic: TrafficStats
  connectedAt: number | null // ms timestamp when the tunnel came up
  setStatus: (s: StatusUpdate) => void
  setTraffic: (t: TrafficStats) => void
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
  connectedAt: null,
  setStatus: (s) =>
    set((prev) => ({
      state: s.state,
      activeOutboundId: s.activeOutboundId,
      autoSelectedId: s.autoSelectedId,
      message: s.message,
      traffic: s.state === 'connected' ? prev.traffic : ZERO_TRAFFIC,
      connectedAt:
        s.state === 'connected'
          ? (prev.connectedAt ?? Date.now())
          : s.state === 'connecting'
            ? prev.connectedAt
            : null
    })),
  setTraffic: (t) => set({ traffic: t }),
  connect: async (outboundId) => {
    set({ state: 'connecting', message: undefined })
    const s = await window.api.vpn.connect(outboundId)
    get().setStatus(s)
  },
  disconnect: async () => {
    const s = await window.api.vpn.disconnect()
    get().setStatus(s)
  }
}))
