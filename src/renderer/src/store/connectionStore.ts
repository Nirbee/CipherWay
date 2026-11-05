import { create } from 'zustand'
import type { ConnectionState, StatusUpdate, TrafficStats } from '@shared/types'

interface ConnectionStore {
  state: ConnectionState
  activeOutboundId?: string
  /** node picked by «Лучший сервер (авто)» while connected */
  autoSelectedId?: string
  /** its latency from the core's own check; null = no answer */
  autoDelayMs?: number | null
  /** first check after connecting still running → «проверяем…» */
  autoChecking?: boolean
  /** no server answered the check */
  autoDead?: boolean
  message?: string
  /** node id → hint for its row in the server list */
  serverHints: Record<string, string>
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
  serverHints: {},
  traffic: ZERO_TRAFFIC,
  connectedAt: null,
  setStatus: (s) =>
    set((prev) => ({
      state: s.state,
      activeOutboundId: s.activeOutboundId,
      autoSelectedId: s.autoSelectedId,
      autoDelayMs: s.autoDelayMs,
      autoChecking: s.autoChecking,
      autoDead: s.autoDead,
      message: s.message,
      serverHints: s.serverHints ?? {},
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
