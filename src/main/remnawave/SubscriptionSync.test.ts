import { describe, expect, it, vi } from 'vitest'
import type { OutboundConfig, SubscriptionData } from '@shared/types'
import { parseOutbounds } from './parsers'
import {
  describeDiff,
  diffOutbounds,
  reconcileActive,
  refreshIntervalMs,
  remapLatencies
} from './subscriptionDiff'
import { SubscriptionSync, RETRY_MS, type SyncDeps } from './SubscriptionSync'

const vless = (name: string, over: Record<string, string> = {}, host = 'a.example.com'): string => {
  const q = new URLSearchParams({
    security: 'reality',
    pbk: 'KEY',
    sid: 'ab',
    sni: 'www.example.org',
    fp: 'chrome',
    ...over
  })
  return `vless://11111111-2222-4333-8444-555555555555@${host}:443?${q}#${encodeURIComponent(name)}`
}
const list = (...links: string[]): OutboundConfig[] => parseOutbounds(links.join('\n'))

describe('diffOutbounds', () => {
  const base = list(vless('Германия'), vless('Нидерланды'), 'hysteria2://p@h.example.com:8443#HY2')

  it('the very same list', () => {
    const d = diffOutbounds(base, base)
    expect(d.restartNeeded).toBe(false)
    expect(describeDiff(d)).toBe('')
  })

  it('order alone is not a reason to restart', () => {
    expect(diffOutbounds(base, [...base].reverse()).restartNeeded).toBe(false)
  })

  it('a new key, a moved Hysteria2 and a removed host (the night of 05.11)', () => {
    const next = list(vless('Германия', { pbk: 'NEWKEY' }), 'hysteria2://p@new.example.com:8443#HY2')
    const d = diffOutbounds(base, next)
    expect(d.restartNeeded).toBe(true)
    expect(d.modified.sort()).toEqual(['Германия', 'HY2'].sort())
    expect(d.removed).toEqual(['Нидерланды'])
    expect(describeDiff(d)).toContain('удалены: Нидерланды')
  })

  it('shortId / fingerprint alone: remembered, no restart (the panel may vary them)', () => {
    const next = list(
      vless('Германия', { sid: 'cd', fp: 'firefox' }),
      vless('Нидерланды'),
      'hysteria2://p@h.example.com:8443#HY2'
    )
    const d = diffOutbounds(base, next)
    expect(d.restartNeeded).toBe(false)
    expect(d.softOnly).toEqual(['Германия'])
  })

  it('ids survive a key change: they come from the name', () => {
    const next = list(vless('Германия', { pbk: 'NEWKEY', sid: 'cd' }, 'b.example.com'))
    expect(next[0].id).toBe(base[0].id)
  })

  it('same name twice: both are kept apart', () => {
    const [a, b] = list(vless('X', { pbk: 'A' }), vless('X', { pbk: 'B' }))
    expect(a.id).not.toBe(b.id)
    const d = diffOutbounds([a, b], list(vless('X', { pbk: 'A' }), vless('X', { pbk: 'C' })))
    expect(d.modified).toEqual(['X#2'])
  })

  it('caches of ≤0.4.2 have ids from the whole link: restart once, by name', () => {
    const old = base.map((o) => ({ ...o, id: `ob_old_${o.name}` }))
    const d = diffOutbounds(old, base)
    expect(d.modified).toEqual([])
    expect(d.restartNeeded).toBe(true)
  })
})

describe('reconcileActive', () => {
  const prev = list(vless('Германия'), vless('Нидерланды'))
  it('auto stays auto', () => {
    expect(reconcileActive('auto', prev, prev)).toEqual({ id: 'auto', changed: false })
    expect(reconcileActive(null, prev, prev)).toEqual({ id: 'auto', changed: false })
  })
  it('an id still in the list stays', () => {
    expect(reconcileActive(prev[0].id, prev, list(vless('Германия', { pbk: 'N' }))).id).toBe(
      prev[0].id
    )
  })
  it('follows the name when the id changed (cache of ≤0.4.2)', () => {
    const old = prev.map((o) => ({ ...o, id: `ob_old_${o.name}` }))
    expect(reconcileActive('ob_old_Нидерланды', old, prev)).toEqual({
      id: prev[1].id,
      changed: true
    })
  })
  it('the selected server is gone → auto, its name is reported', () => {
    expect(reconcileActive(prev[1].id, prev, list(vless('Германия')))).toEqual({
      id: 'auto',
      changed: true,
      lost: 'Нидерланды'
    })
  })
  it('an unknown id (the hidden «Автовыбор») → auto', () => {
    expect(reconcileActive('ob_hidden', prev, prev)).toEqual({ id: 'auto', changed: true })
  })
})

describe('remapLatencies / refreshIntervalMs', () => {
  it('latency history moves with the name, gone servers are dropped', () => {
    const next = list(vless('Германия'))
    const old = list(vless('Германия'), vless('Нидерланды')).map((o) => ({
      ...o,
      id: `old_${o.name}`
    }))
    expect(remapLatencies({ old_Германия: 40, old_Нидерланды: 90, junk: 1 }, old, next)).toEqual({
      [next[0].id]: 40
    })
  })
  it('the panel header wins over the setting; sane limits', () => {
    const H = 3_600_000
    expect(refreshIntervalMs(6, 12)).toBe(6 * H)
    expect(refreshIntervalMs(undefined, 12)).toBe(12 * H)
    expect(refreshIntervalMs(0.01, 12)).toBe(H)
    expect(refreshIntervalMs(9999, 12)).toBe(168 * H)
  })
})

// ---------------------------------------------------------------------------

function setup(over: Partial<SyncDeps> = {}) {
  const state = {
    now: 1_000_000_000,
    url: 'https://sub.example.com/x' as string | null,
    active: 'auto' as string | null,
    cached: null as SubscriptionData | null,
    latencies: {} as Record<string, number | null>,
    apply: vi.fn(),
    changedTo: [] as string[],
    logs: [] as string[],
    notes: [] as string[]
  }
  const fetchImpl = vi.fn(async (_url: string, _t?: number): Promise<SubscriptionData> => {
    throw new Error('not set')
  })
  const sync = new SubscriptionSync({
    url: () => state.url,
    fetch: fetchImpl,
    cached: () => state.cached,
    getActive: () => state.active,
    setActive: (id) => {
      state.active = id
    },
    getLatencies: () => state.latencies,
    setLatencies: (v) => {
      state.latencies = v
    },
    settingHours: () => 12,
    applyToCore: state.apply,
    activeChanged: (id) => state.changedTo.push(id),
    log: (_l, m) => state.logs.push(m),
    notify: (t) => state.notes.push(t),
    now: () => state.now,
    ...over
  })
  const answer = (outbounds: OutboundConfig[], hours?: number): void => {
    fetchImpl.mockImplementation(async () => {
      const data: SubscriptionData = {
        url: '',
        fetchedAt: state.now,
        outbounds,
        updateIntervalHours: hours
      }
      state.cached = data
      return data
    })
  }
  return { sync, state, fetchImpl, answer }
}

const data = (outbounds: OutboundConfig[], fetchedAt = 0, hours?: number): SubscriptionData => ({
  url: '',
  fetchedAt,
  outbounds,
  updateIntervalHours: hours
})

describe('SubscriptionSync', () => {
  const nodes = list(vless('Германия'), vless('Нидерланды'))

  it('no changes: «нет изменений», the core is left alone', async () => {
    const { sync, state, answer } = setup()
    state.cached = data(nodes)
    answer(nodes)
    expect((await sync.refresh()).changed).toBe(false)
    expect(state.apply).not.toHaveBeenCalled()
  })

  it('a changed key: applied to the core, the selection survives', async () => {
    const { sync, state, answer } = setup()
    state.cached = data(nodes)
    state.active = nodes[0].id
    answer(list(vless('Германия', { pbk: 'NEW' }), vless('Нидерланды')))
    expect((await sync.refresh()).changed).toBe(true)
    expect(state.apply).toHaveBeenCalledTimes(1)
    expect(state.active).toBe(nodes[0].id)
    expect(state.changedTo).toEqual([])
  })

  it('the selected server disappeared → «Лучший сервер», told so', async () => {
    const { sync, state, answer } = setup()
    state.cached = data(nodes)
    state.active = nodes[1].id
    answer(list(vless('Германия')))
    await sync.refresh()
    expect(state.active).toBe('auto')
    expect(state.changedTo).toEqual(['auto'])
    expect(state.notes[0]).toContain('Нидерланды')
    expect(state.apply).toHaveBeenCalledTimes(1)
  })

  it('soft changes wait for the next start — unless a REALITY error asked for them', async () => {
    const soft = list(vless('Германия', { sid: 'cd' }), vless('Нидерланды'))
    const a = setup()
    a.state.cached = data(nodes)
    a.answer(soft)
    expect((await a.sync.refresh()).changed).toBe(false)
    expect(a.state.apply).not.toHaveBeenCalled()

    const b = setup()
    b.state.cached = data(nodes)
    b.answer(soft)
    await b.sync.heal()
    expect(b.state.apply).toHaveBeenCalledTimes(1)
  })

  it('a first subscription has nothing to restart', async () => {
    const { sync, state, answer } = setup()
    answer(nodes)
    expect((await sync.refresh()).changed).toBe(true)
    expect(state.apply).not.toHaveBeenCalled()
  })

  it('requests in flight are shared', async () => {
    const { sync, fetchImpl, answer } = setup()
    answer(nodes)
    await Promise.all([sync.refresh(), sync.refresh(), sync.beforeConnect()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('before a connect: short timeout, failure is not an error', async () => {
    const { sync, state, fetchImpl } = setup()
    state.cached = data(nodes)
    fetchImpl.mockRejectedValue(new Error('сеть недоступна'))
    await expect(sync.beforeConnect()).resolves.toBeUndefined()
    expect(fetchImpl.mock.calls[0][1]).toBe(5000)
    expect(state.logs.at(-1)).toContain('сохранённой копии')
    expect(state.logs.at(-1)).toContain('сеть недоступна')
    state.url = null
    fetchImpl.mockClear()
    await sync.beforeConnect()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a hanging request holds the connect for ~5 s at most; its answer still counts', async () => {
    vi.useFakeTimers()
    try {
      const { sync, state, fetchImpl } = setup()
      state.cached = data(nodes)
      let release!: (d: SubscriptionData) => void
      fetchImpl.mockImplementation(() => new Promise((r) => (release = r)))
      let done = false
      const p = sync.beforeConnect().then(() => (done = true))
      await vi.advanceTimersByTimeAsync(5100)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      await p
      expect(done).toBe(true)
      expect(state.logs.at(-1)).toContain('за 5 с')
      release(data(list(vless('Германия', { pbk: 'LATE' }))))
      await vi.advanceTimersByTimeAsync(0)
      expect(state.apply).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('timer: panel interval if present, else the setting; failures retried after a pause', async () => {
    const { sync, state, fetchImpl, answer } = setup()
    const HOUR = 3_600_000
    state.cached = data(nodes, state.now, 6)
    state.now += 5 * HOUR
    expect(sync.isDue()).toBe(false)
    state.now += HOUR
    expect(sync.isDue()).toBe(true)

    state.cached = data(nodes, state.now)
    state.now += 11 * HOUR
    expect(sync.isDue()).toBe(false)
    state.now += HOUR
    expect(sync.isDue()).toBe(true)

    fetchImpl.mockRejectedValue(new Error('нет сети'))
    sync.tick()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(state.logs.at(-1)).toContain('нет сети'))
    expect(sync.isDue()).toBe(false)
    state.now += RETRY_MS
    expect(sync.isDue()).toBe(true)
    answer(nodes)
    sync.tick()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
  })

  it('no link: nothing is due, refresh explains', async () => {
    const { sync, state } = setup()
    state.url = null
    expect(sync.isDue()).toBe(false)
    await expect(sync.refresh()).rejects.toThrow('Подписка не настроена')
  })

  it('at start: a choice that is no longer in the list goes to auto', () => {
    const { sync, state } = setup()
    state.cached = data(nodes)
    state.active = 'ob_hidden_autoselect'
    sync.migrateActive()
    expect(state.active).toBe('auto')
    expect(state.changedTo).toEqual(['auto'])
  })
})
