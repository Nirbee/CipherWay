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
  /** «auto» right after connecting: the core is checking the servers */
  checking?: boolean
  /** «auto»: no server answered */
  dead?: boolean
  /** why this server does not work (REALITY keeps failing) */
  hint?: string
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
  const autoDelayMs = useConnection((s) => s.autoDelayMs)
  const autoChecking = useConnection((s) => s.autoChecking)
  const autoDead = useConnection((s) => s.autoDead)
  const serverHints = useConnection((s) => s.serverHints)

  return useMemo(() => {
    const list: ServerEntry[] = (servers ?? []).map((s) => {
      const { code, label } = parseServerName(s.name)
      return {
        id: s.id,
        label,
        code,
        protocol: s.protocol,
        latency: pings[s.id],
        hint: serverHints[s.id]
      }
    })
    // connected: the node the core uses right now, with *its* latency
    let autoPick = list.find((e) => e.id === autoSelectedId)
    if (autoPick && autoDelayMs !== undefined) autoPick = { ...autoPick, latency: autoDelayMs }
    if (!autoPick && !autoChecking && !autoDead) {
      const measured = list.filter((e) => typeof e.latency === 'number')
      autoPick = measured.sort((a, b) => (a.latency as number) - (b.latency as number))[0]
    }
    const tested = list.some((e) => e.latency !== undefined)
    const latency = autoChecking
      ? undefined
      : autoDead
        ? null
        : autoPick
          ? autoPick.latency
          : tested
            ? null
            : undefined
    const auto: ServerEntry = {
      id: AUTO_OUTBOUND_ID,
      label: 'Лучший сервер (авто)',
      auto: true,
      latency,
      checking: !!autoChecking,
      dead: !!autoDead
    }
    const entries = list.length ? [auto, ...list] : []
    const active = entries.find((e) => e.id === activeId) ?? (list.length ? auto : undefined)
    return { entries, active, autoPick: autoChecking || autoDead ? undefined : autoPick }
  }, [servers, pings, activeId, autoSelectedId, autoDelayMs, autoChecking, autoDead, serverHints])
}
