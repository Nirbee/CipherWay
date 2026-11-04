import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportThread, SupportView } from '@shared/types'
import { SupportError, SUPPORT_ERRORS, type SupportClient } from './client'
import { POLL_ACTIVE_MS, POLL_BACKGROUND_MS, POLL_IDLE_MS, SupportService } from './SupportService'

const msg = (from: 'you' | 'support', text: string, at: string) => ({
  key: `${at}`,
  from,
  text,
  at
})

function setup(threads: (SupportThread | Error)[]) {
  const getThread = vi.fn(async () => {
    const t = threads.length > 1 ? threads.shift()! : threads[0]
    if (t instanceof Error) throw t
    return t
  })
  const client = {
    getThread,
    me: vi.fn(async () => ({ username: 'ivan', hasTelegram: true })),
    sendText: vi.fn(async () => ({ ticketId: 1, aiOutcome: null, aiReply: null })),
    sendPhoto: vi.fn(),
    image: vi.fn()
  } as unknown as SupportClient
  const state = { readAt: null as string | null, notifiedAt: null as string | null, focused: false }
  const notify = vi.fn()
  const views: SupportView[] = []
  const svc = new SupportService({
    client,
    hasSubscription: () => true,
    getReadAt: () => state.readAt,
    setReadAt: (v) => (state.readAt = v),
    getNotifiedAt: () => state.notifiedAt,
    setNotifiedAt: (v) => (state.notifiedAt = v),
    publish: (v) => views.push(v),
    notify,
    isWindowFocused: () => state.focused
  })
  return { svc, getThread, notify, views, state }
}

const T1: SupportThread = {
  ticketId: 5,
  status: 'open',
  messages: [
    msg('you', 'help', '2026-11-04T10:00:00Z'),
    msg('support', 'old reply', '2026-11-04T10:01:00Z')
  ]
}
const T2: SupportThread = {
  ...T1,
  messages: [...T1.messages, msg('support', 'Попробуйте другой сервер', '2026-11-04T10:30:00Z')]
}

describe('SupportService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('first fetch ever: old history is neither a notification nor unread', async () => {
    const { svc, notify } = setup([T1])
    const v = await svc.refresh()
    expect(notify).not.toHaveBeenCalled()
    expect(v.unread).toBe(0)
    expect(v.me?.username).toBe('ivan')
  })

  it('a new reply in the background → one Windows notification + badge', async () => {
    const { svc, notify } = setup([T1, T2])
    await svc.refresh()
    const v = await svc.refresh()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('Попробуйте другой сервер')
    expect(v.unread).toBe(1)
    await svc.refresh() // same thread again: no repeat
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('page open and window focused: no notification, reply counts as read', async () => {
    const { svc, notify, state } = setup([T1, T2])
    await svc.refresh()
    state.focused = true
    svc.setActive(true)
    await vi.advanceTimersByTimeAsync(0)
    const v = await svc.refresh()
    expect(notify).not.toHaveBeenCalled()
    expect(v.unread).toBe(0)
  })

  it('polls every 10 s on the page, 60 s with an open ticket, 10 min without one', async () => {
    const { svc, getThread } = setup([T1])
    svc.start(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(getThread).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_BACKGROUND_MS)
    expect(getThread).toHaveBeenCalledTimes(2)

    svc.setActive(true)
    await vi.advanceTimersByTimeAsync(0)
    const n = getThread.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_ACTIVE_MS)
    expect(getThread.mock.calls.length).toBe(n + 1)
    svc.stop()

    const idle = setup([{ ticketId: null, status: null, messages: [] }])
    idle.svc.start(0)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(POLL_BACKGROUND_MS)
    expect(idle.getThread).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_IDLE_MS)
    expect(idle.getThread).toHaveBeenCalledTimes(2)
    idle.svc.stop()
  })

  it('401: the error is shown, background polling stops until reset()', async () => {
    const { svc, getThread } = setup([new SupportError(SUPPORT_ERRORS.auth, 'auth', 401)])
    svc.start(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.view().error).toBe('Не удалось войти в поддержку — обновите подписку')
    await vi.advanceTimersByTimeAsync(POLL_IDLE_MS * 2)
    expect(getThread).toHaveBeenCalledTimes(1)
    svc.stop()
  })
})
