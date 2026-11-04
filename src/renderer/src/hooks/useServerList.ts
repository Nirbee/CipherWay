import { useMemo } from 'react'
import { AUTO_OUTBOUND_ID, type Protocol } from '@shared/types'
import { parseServerName } from '@shared/flags'
import { useSubscription } from '../store/subscriptionStore'
import { useServers } from '../store/serversStore'
import { useConnection } from '../store/connectionStore'

export interface ServerEntry {
  id: string
  label: string
  code?: string
  auto?: boolean
  protocol?: Protocol
  /** undefined = not tested */
  latency: number | null | undefined
}

/**
 * «⚡ Лучший сервер (авто)» + subscription servers, with flags and latency.
 * The auto entry shows the latency of the node it currently uses (connected)
 * or of the best measured one (disconnected).
 */
export function useServerList(): {
  entries: ServerEntry[]
  active: ServerEntry | undefined
  autoPick: ServerEntry | undefined
} {
  const servers = useSubscription((s) => s.data?.servers)
  const pings = useServers((s) => s.pings)
  const activeId = useServers((s) => s.activeId)
  const autoSelectedId = useConnection((s) => s.autoSelectedId)

  return useMemo(() => {
    const list: ServerEntry[] = (servers ?? []).map((s) => {
      const { code, label } = parseServerName(s.name)
      return { id: s.id, label, code, protocol: s.protocol, latency: pings[s.id] }
    })
    let autoPick = list.find((e) => e.id === autoSelectedId)
    if (!autoPick) {
      const measured = list.filter((e) => typeof e.latency === 'number')
      autoPick = measured.sort((a, b) => (a.latency as number) - (b.latency as number))[0]
    }
    const tested = list.some((e) => e.latency !== undefined)
    const auto: ServerEntry = {
      id: AUTO_OUTBOUND_ID,
      label: 'Лучший сервер (авто)',
      auto: true,
      latency: autoPick ? autoPick.latency : tested ? null : undefined
    }
    const entries = list.length ? [auto, ...list] : []
    const active = entries.find((e) => e.id === activeId) ?? (list.length ? auto : undefined)
    return { entries, active, autoPick }
  }, [servers, pings, activeId, autoSelectedId])
}
