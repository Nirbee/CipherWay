import { describe, expect, it } from 'vitest'
import { LanApi, LanApiError, normalizeCode, normalizeRooms, safeLoginServer } from './api'

const SUB = 'https://sub.example.com/api/sub/tok123'
const ctx = () => ({
  apiBase: 'https://cabinet.example.com',
  subscriptionUrl: SUB,
  deviceHeaders: { 'x-hwid': 'hw1', 'User-Agent': 'CipherWay/1.0' }
})

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** fetch mock: answers by "METHOD path" */
function mock(routes: Record<string, { status?: number; body?: unknown; location?: string }>) {
  const calls: Call[] = []
  const fn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    calls.push({
      url,
      method,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined
    })
    const r = routes[`${method} ${u.pathname}`] ?? { status: 404, body: { detail: 'Not Found' } }
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: r.location ? { location: r.location } : {}
    })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const P = '/api/app/v1/lan'

describe('LAN API client (contract of the bot)', () => {
  it('auth: X-Subscription-Token + the device headers', async () => {
    const { fn, calls } = mock({
      [`GET ${P}/status`]: {
        body: {
          enabled: true,
          login_server: 'https://lan.cipherway.ru',
          max_room_members: 8,
          max_rooms_owned: 3,
          max_rooms_joined: 10,
          max_devices: 5
        }
      }
    })
    const s = await new LanApi(ctx, fn).status()
    expect(s).toEqual({
      enabled: true,
      loginServer: 'https://lan.cipherway.ru',
      maxRoomMembers: 8,
      maxRoomsOwned: 3,
      maxRoomsJoined: 10,
      maxDevices: 5
    })
    expect(calls[0].headers['X-Subscription-Token']).toBe('tok123')
    expect(calls[0].headers['x-hwid']).toBe('hw1')
  })

  it('LAN off on the server: {enabled:false, login_server:null}', async () => {
    const { fn } = mock({
      [`GET ${P}/status`]: { body: { enabled: false, login_server: null, max_devices: 5 } }
    })
    expect(await new LanApi(ctx, fn).status()).toMatchObject({ enabled: false, loginServer: null })
  })

  it('device: the key, the login server and the bot-chosen host name; the stored name is sent back', async () => {
    const { fn, calls } = mock({
      [`POST ${P}/device`]: {
        body: {
          login_server: 'https://lan.cipherway.ru',
          auth_key: 'hskey-auth-abcdefgh_123',
          expires_at: '2026-11-18T20:10:00Z',
          hostname: 'cw-1a2b3c'
        }
      }
    })
    const api = new LanApi(ctx, fn)
    expect(await api.registerDevice(null)).toEqual({
      loginServer: 'https://lan.cipherway.ru',
      authKey: 'hskey-auth-abcdefgh_123',
      expiresAt: '2026-11-18T20:10:00Z',
      hostname: 'cw-1a2b3c'
    })
    expect(calls[0].body).toEqual({})
    await api.registerDevice('cw-1a2b3c')
    expect(calls[1].body).toEqual({ hostname: 'cw-1a2b3c' })
  })

  it('device: a weird answer (no host name, http login server) is refused', async () => {
    const { fn } = mock({
      [`POST ${P}/device`]: {
        body: { login_server: 'http://evil.example', auth_key: 'k'.repeat(20), hostname: 'cw-1' }
      }
    })
    await expect(new LanApi(ctx, fn).registerDevice(null)).rejects.toMatchObject({ kind: 'server' })
  })

  const errors: [string, string, unknown, string, string][] = [
    ['GET', '/status', { detail: 'subscription_inactive' }, 'inactive', 'Подписка не активна'],
    ['POST', '/device', { detail: 'device_limit' }, 'device_limit', 'лимит устройств'],
    ['POST', '/device', { detail: 'lan_unavailable' }, 'unavailable', 'недоступен'],
    ['GET', '/rooms', { detail: 'lan_disabled' }, 'disabled', 'выключен на сервере'],
    ['POST', '/rooms/join', { detail: 'room_full' }, 'room_full', 'заполнена'],
    ['POST', '/rooms/join', { detail: 'room_not_found' }, 'unknown_code', 'таким кодом'],
    ['POST', '/rooms/join', { detail: 'banned' }, 'banned', 'исключил вас'],
    ['POST', '/rooms/join', { detail: 'membership_limit' }, 'membership_limit', '10 комнатах'],
    ['POST', '/rooms', { detail: 'room_limit' }, 'room_limit', 'Больше комнат'],
    ['POST', '/rooms/5/kick', { detail: 'not_owner' }, 'forbidden', 'создатель'],
    ['POST', '/rooms/5/kick', { detail: 'cannot_kick_self' }, 'cannot_kick_self', 'Себя'],
    ['POST', '/rooms/5/kick', { detail: 'member_not_found' }, 'member_not_found', 'участника'],
    ['DELETE', '/device/9', { detail: 'device_not_found' }, 'device_not_found', 'уже удалено'],
    ['POST', '/rooms/5/leave', { detail: 'room_not_found' }, 'not_found', 'не найдена'],
    ['POST', '/rooms/join', { detail: 'Too Many Requests' }, 'rate', 'подождите']
  ]
  const statusOf: Record<string, number> = {
    subscription_inactive: 403,
    device_limit: 409,
    lan_unavailable: 503,
    lan_disabled: 404,
    room_full: 409,
    room_not_found: 404,
    banned: 403,
    membership_limit: 409,
    room_limit: 409,
    not_owner: 403,
    cannot_kick_self: 400,
    member_not_found: 404,
    device_not_found: 404,
    'Too Many Requests': 429
  }
  for (const [method, path, body, kind, text] of errors) {
    const detail = (body as { detail: string }).detail
    it(`${statusOf[detail]} ${detail} on ${method} ${path} → ${kind}`, async () => {
      const { fn } = mock({ [`${method} ${P}${path}`]: { status: statusOf[detail], body } })
      const api = new LanApi(ctx, fn)
      const call = {
        '/status': () => api.status(),
        '/device': () => api.registerDevice(null),
        '/rooms': () => (method === 'GET' ? api.rooms() : api.createRoom('x')),
        '/rooms/join': () => api.joinRoom('ABC234'),
        '/rooms/5/kick': () => api.kick('5', '7'),
        '/rooms/5/leave': () => api.leaveRoom('5'),
        '/device/9': () => api.deleteDevice('9')
      }[path]!
      const err = await call().then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(LanApiError)
      expect((err as LanApiError).kind).toBe(kind)
      expect((err as LanApiError).message).toContain(text)
    })
  }

  it('an empty room name (422) and a 404 on join without detail', async () => {
    const { fn } = mock({
      [`POST ${P}/rooms`]: { status: 422, body: { detail: [{ msg: 'too short' }] } },
      [`POST ${P}/rooms/join`]: { status: 404, body: {} }
    })
    const api = new LanApi(ctx, fn)
    await expect(api.createRoom('')).rejects.toThrow('Назовите комнату')
    await expect(api.joinRoom('ABC234')).rejects.toMatchObject({ kind: 'unknown_code' })
  })

  it('rooms: only the owner gets the code; ids become strings; kick sends a number', async () => {
    const room = {
      id: 5,
      code: 'abc234',
      name: 'Майнкрафт <b>',
      is_owner: true,
      members: [
        {
          member_id: 7,
          label: 'Игрок 1',
          is_self: true,
          devices: [{ name: 'cw-1a2b3c', ip: '100.64.0.2', online: true }]
        },
        { member_id: 8, label: 'Игрок 2', is_self: false, devices: [] }
      ]
    }
    const { fn, calls } = mock({
      [`GET ${P}/rooms`]: { body: [room, { ...room, id: 6, code: null, is_owner: false }] },
      [`POST ${P}/rooms/5/kick`]: { body: { ...room, code: 'XYZ789', members: [room.members[0]] } },
      [`POST ${P}/rooms/5/leave`]: { body: { room_deleted: true } }
    })
    const api = new LanApi(ctx, fn)
    const rooms = await api.rooms()
    expect(rooms[0]).toMatchObject({
      id: '5',
      code: 'ABC234',
      name: 'Майнкрафт <b>',
      isOwner: true
    })
    expect(rooms[0].members[0]).toEqual({
      memberId: '7',
      label: 'Игрок 1',
      isSelf: true,
      devices: [{ name: 'cw-1a2b3c', ip: '100.64.0.2', online: true }]
    })
    expect(rooms[1].code).toBeNull()
    const after = await api.kick('5', '8')
    expect(after?.code).toBe('XYZ789')
    expect(calls.at(-1)?.body).toEqual({ member_id: 8 })
    await api.leaveRoom('5')
  })

  it('devices: expired flag kept', async () => {
    const { fn } = mock({
      [`GET ${P}/devices`]: {
        body: [
          {
            node_id: 3,
            name: 'cw-1a2b3c',
            ip: '100.64.0.2',
            online: false,
            last_seen: null,
            expired: true
          }
        ]
      }
    })
    expect(await new LanApi(ctx, fn).devices()).toEqual([
      {
        nodeId: '3',
        name: 'cw-1a2b3c',
        ip: '100.64.0.2',
        online: false,
        lastSeen: null,
        expired: true
      }
    ])
  })

  it('the token never follows a redirect to another host; no subscription = no request', async () => {
    const { fn, calls } = mock({
      [`GET ${P}/rooms`]: { status: 302, location: 'https://evil.example/steal' }
    })
    await expect(new LanApi(ctx, fn).rooms()).rejects.toThrow('чужой адрес')
    expect(calls).toHaveLength(1)
    const none = mock({})
    await expect(
      new LanApi(() => ({ ...ctx(), subscriptionUrl: null }), none.fn).rooms()
    ).rejects.toMatchObject({ kind: 'nosub' })
    expect(none.calls).toHaveLength(0)
  })

  it('network failure → readable error', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(new LanApi(ctx, fn).status()).rejects.toMatchObject({ kind: 'network' })
  })

  it('helpers', () => {
    expect(normalizeCode(' ab3-4xy ')).toBe('AB34XY')
    expect(normalizeCode('abc')).toBeNull()
    expect(safeLoginServer('https://lan.cipherway.ru/')).toBe('https://lan.cipherway.ru')
    expect(safeLoginServer('https://u:p@lan.cipherway.ru')).toBeNull()
    expect(safeLoginServer('javascript:alert(1)')).toBeNull()
    expect(normalizeRooms({ rooms: [{ id: 'r1', members: 'x' }] })[0].members).toEqual([])
  })
})
