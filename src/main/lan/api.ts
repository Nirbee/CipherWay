import type { LanDevice, LanErrorKind, LanLimits, LanRoom } from '@shared/types'
import {
  isSameOrigin,
  normalizeBase,
  subscriptionToken,
  type SupportContext
} from '../support/client'

// ---------------------------------------------------------------------------
// «LAN» — client of the bot API (contract: .claude/plans/lan-play.md):
//   GET    /api/app/v1/lan/status                 {enabled, login_server, max_*}
//   POST   /api/app/v1/lan/device {hostname}      {login_server, auth_key, expires_at}
//   GET    /api/app/v1/lan/devices                [{node_id, name, ip, online, last_seen}]
//   DELETE /api/app/v1/lan/device/{node_id}
//   GET    /api/app/v1/lan/rooms                  [{id, code, name, is_owner, members[]}]
//   POST   /api/app/v1/lan/rooms {name}           room
//   POST   /api/app/v1/lan/rooms/join {code}      room (404 unknown code, 409 room_full)
//   POST   /api/app/v1/lan/rooms/{id}/leave | /kick {member_id} | /regenerate-code
// Errors: 403 {detail:"subscription_inactive"}, 409 {detail:"device_limit"},
// 404 / {enabled:false} = LAN switched off on the server.
// Same auth as the support chat: X-Subscription-Token + the device headers;
// the token goes to the API origin only (redirects are followed by hand).
// The auth key is returned to the caller and never logged. fetch is injected
// — unit tested with mocks in api.test.ts.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000
/** a LAN host name as the CLI takes it (the bot sends «cw-xxxxxx») */
export const LAN_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const BASE = '/api/app/v1/lan'

export type LanApiErrorKind =
  | Extract<
      LanErrorKind,
      'nosub' | 'inactive' | 'disabled' | 'device_limit' | 'auth' | 'rate' | 'network' | 'server'
    >
  | 'room_full'
  | 'unknown_code'
  | 'room_limit'
  | 'forbidden'
  | 'not_found'
  | 'input'
  | 'unavailable'
  | 'member_not_found'
  | 'device_not_found'
  | 'cannot_kick_self'
  | 'banned'
  | 'membership_limit'

export const LAN_API_ERRORS: Record<LanApiErrorKind, string> = {
  nosub: 'Сначала добавьте подписку на странице «Подписка».',
  inactive:
    'Подписка не активна — LAN работает только с действующей подпиской. Продлите её и включите LAN снова.',
  disabled: 'LAN сейчас выключен на сервере CipherWay. Попробуйте позже.',
  device_limit:
    'Достигнут лимит устройств LAN. Удалите старое устройство из списка ниже — и это подключится.',
  room_full: 'Комната заполнена: в ней уже максимум участников.',
  unknown_code: 'Комнаты с таким кодом нет. Проверьте код — 6 букв и цифр.',
  room_limit: 'Больше комнат создать нельзя. Удалите или покиньте одну из своих.',
  forbidden: 'Это может сделать только создатель комнаты.',
  not_found: 'Комната не найдена — возможно, её уже удалили.',
  input: 'Проверьте введённые данные.',
  unavailable: 'LAN-сервер CipherWay сейчас недоступен или занят — попробуйте через минуту.',
  member_not_found: 'Этого участника уже нет в комнате.',
  device_not_found: 'Это устройство уже удалено.',
  cannot_kick_self: 'Себя исключить нельзя — чтобы уйти, нажмите «Выйти» или «Удалить».',
  banned: 'Создатель исключил вас из этой комнаты — войти в неё снова нельзя.',
  membership_limit: 'Вы уже состоите в 10 комнатах — выйдите из какой-нибудь, чтобы войти в новую.',
  auth: 'Не удалось войти — обновите подписку на странице «Подписка».',
  rate: 'Слишком много попыток — подождите минуту.',
  network: 'Нет связи с сервером CipherWay. Проверьте интернет.',
  server: 'Сервер CipherWay ответил ошибкой.'
}

export class LanApiError extends Error {
  constructor(
    public readonly kind: LanApiErrorKind,
    message: string = LAN_API_ERRORS[kind],
    public readonly status?: number
  ) {
    super(message)
    this.name = 'LanApiError'
  }
}

export interface LanServerStatus extends LanLimits {
  enabled: boolean
  /** https://… of Headscale; null when the server didn't send a usable one */
  loginServer: string | null
}

export interface LanAuthKey {
  loginServer: string
  /** single-use pre-auth key — never log it */
  authKey: string
  expiresAt: string | null
  /** the LAN host name the bot chose (cw-xxxxxx) — passed to `up --hostname` as is */
  hostname: string
}

type FetchFn = typeof fetch
type Op = 'status' | 'device' | 'devices' | 'deleteDevice' | 'rooms' | 'create' | 'join' | 'room'

/** `detail` of a FastAPI error body: a string or {code|error|detail}. */
export function errorDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const d = (body as Record<string, unknown>).detail ?? (body as Record<string, unknown>).error
  if (typeof d === 'string') return d.trim().toLowerCase()
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>
    const v = o.code ?? o.error ?? o.detail
    return typeof v === 'string' ? v.trim().toLowerCase() : ''
  }
  return ''
}

/** HTTP status + `detail` → what went wrong, for the operation that failed. */
export function lanError(status: number, detail: string, op: Op): LanApiError {
  if (detail === 'subscription_inactive') return new LanApiError('inactive', undefined, status)
  if (detail === 'device_limit') return new LanApiError('device_limit', undefined, status)
  if (detail === 'room_full') return new LanApiError('room_full', undefined, status)
  if (/^(room_limit|rooms_limit|max_rooms|too_many_rooms)/.test(detail)) {
    return new LanApiError('room_limit', undefined, status)
  }
  if (detail === 'not_owner') return new LanApiError('forbidden', undefined, status)
  if (detail === 'banned') return new LanApiError('banned', undefined, status)
  if (detail === 'membership_limit') return new LanApiError('membership_limit', undefined, status)
  if (detail === 'member_not_found') return new LanApiError('member_not_found', undefined, status)
  if (detail === 'device_not_found') return new LanApiError('device_not_found', undefined, status)
  if (detail === 'cannot_kick_self') return new LanApiError('cannot_kick_self', undefined, status)
  if (detail === 'room_not_found') {
    return new LanApiError(op === 'join' ? 'unknown_code' : 'not_found', undefined, status)
  }
  if (status === 503 || detail === 'lan_unavailable' || detail === 'lan_busy') {
    return new LanApiError('unavailable', undefined, status)
  }
  if (status === 422 && op === 'create') {
    return new LanApiError('input', 'Назовите комнату — от 1 до 40 символов.', status)
  }
  if (/^(lan_disabled|disabled|lan_off)$/.test(detail)) {
    return new LanApiError('disabled', undefined, status)
  }
  if (status === 401) return new LanApiError('auth', undefined, status)
  if (status === 429) return new LanApiError('rate', undefined, status)
  if (status === 404) {
    if (op === 'join') return new LanApiError('unknown_code', undefined, status)
    if (op === 'status' || op === 'device') return new LanApiError('disabled', undefined, status)
    if (op === 'room') return new LanApiError('not_found', undefined, status)
  }
  if (status === 403) {
    // any other 403 on a room = owner-only action; elsewhere the token is no good
    return op === 'room'
      ? new LanApiError('forbidden', undefined, status)
      : new LanApiError('auth', undefined, status)
  }
  if (status === 409 && op === 'create') return new LanApiError('room_limit', undefined, status)
  if (status === 409 && op === 'join') return new LanApiError('room_full', undefined, status)
  if (status === 400 || status === 422) return new LanApiError('input', undefined, status)
  return new LanApiError('server', `${LAN_API_ERRORS.server} (код ${status})`, status)
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
const bool = (v: unknown): boolean => v === true
const int = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : def
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const ip = (v: unknown): string | null => {
  const s = str(v).trim()
  return IPV4_RE.test(s) || /^[0-9a-f:]+$/i.test(s) ? s : null
}

/** https:// URL of Headscale (nothing else: it goes to the daemon as --login-server). */
export function safeLoginServer(v: unknown): string | null {
  const s = str(v).trim()
  if (!s) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null
    if (!/^[a-z0-9.-]+$/i.test(u.hostname)) return null
    return `${u.origin}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

export function normalizeStatus(json: unknown): LanServerStatus {
  const r = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  return {
    enabled: r.enabled !== false,
    loginServer: safeLoginServer(r.login_server),
    maxRoomMembers: int(r.max_room_members, 8),
    maxRoomsOwned: int(r.max_rooms_owned, 3),
    maxRoomsJoined: int(r.max_rooms_joined, 10),
    maxDevices: int(r.max_devices, 5)
  }
}

export function normalizeDevices(json: unknown): LanDevice[] {
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as { devices?: unknown } | null)?.devices)
      ? (json as { devices: unknown[] }).devices
      : []
  const out: LanDevice[] = []
  for (const d of list) {
    if (!d || typeof d !== 'object') continue
    const r = d as Record<string, unknown>
    const nodeId = str(r.node_id ?? r.id)
    if (!nodeId) continue
    out.push({
      nodeId,
      name: str(r.name) || str(r.hostname) || `устройство ${nodeId}`,
      ip: ip(r.ip),
      online: bool(r.online),
      lastSeen: str(r.last_seen) || null,
      expired: r.expired === true
    })
  }
  return out
}

export function normalizeRoom(json: unknown): LanRoom | null {
  if (!json || typeof json !== 'object') return null
  const r = json as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  const members = Array.isArray(r.members) ? r.members : []
  return {
    id,
    // only the owner gets the code
    code: str(r.code).toUpperCase() || null,
    name: str(r.name) || 'Комната',
    isOwner: bool(r.is_owner),
    members: members
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .map((m) => ({
        memberId: str(m.member_id ?? m.id),
        label: str(m.label) || 'Участник',
        isSelf: bool(m.is_self),
        devices: (Array.isArray(m.devices) ? m.devices : [])
          .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
          .map((d) => ({ name: str(d.name) || 'устройство', ip: ip(d.ip), online: bool(d.online) }))
      }))
      .filter((m) => m.memberId)
  }
}

export function normalizeRooms(json: unknown): LanRoom[] {
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as { rooms?: unknown } | null)?.rooms)
      ? (json as { rooms: unknown[] }).rooms
      : []
  return list.map(normalizeRoom).filter((r): r is LanRoom => r !== null)
}

/** «ab3 4xy» / «ab3-4xy» → «AB34XY»; null if it can't be a room code. */
export function normalizeCode(raw: string): string | null {
  const c = raw.replace(/[\s-]/g, '').toUpperCase()
  return /^[A-Z0-9]{6}$/.test(c) ? c : null
}

export class LanApi {
  constructor(
    private ctx: () => SupportContext | Promise<SupportContext>,
    private fetchFn: FetchFn = (...a) => fetch(...a)
  ) {}

  private async request(op: Op, path: string, init: RequestInit = {}): Promise<unknown> {
    const c = await this.ctx()
    const token = subscriptionToken(c.subscriptionUrl)
    if (!token) throw new LanApiError('nosub')
    const base = normalizeBase(c.apiBase)
    let target = `${base}${BASE}${path}`
    let res: Response | null = null
    try {
      for (let hop = 0; hop < 4; hop++) {
        res = await this.fetchFn(target, {
          ...init,
          redirect: 'manual',
          headers: {
            ...c.deviceHeaders,
            Accept: 'application/json',
            'X-Subscription-Token': token,
            ...(init.body ? { 'Content-Type': 'application/json' } : {})
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
        const loc = res.headers.get('location')
        if (![301, 302, 303, 307, 308].includes(res.status) || !loc) break
        const next = new URL(loc, target).toString()
        if (!isSameOrigin(next, c.apiBase)) {
          throw new LanApiError('server', 'Сервер CipherWay перенаправил на чужой адрес')
        }
        target = next
        res = null
      }
    } catch (e) {
      if (e instanceof LanApiError) throw e
      throw new LanApiError('network')
    }
    if (!res) throw new LanApiError('server', 'Сервер CipherWay перенаправляет по кругу')
    const text = await res.text().catch(() => '')
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!res.ok) throw lanError(res.status, errorDetail(body), op)
    return body
  }

  private post(op: Op, path: string, body?: unknown): Promise<unknown> {
    return this.request(op, path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  }

  async status(): Promise<LanServerStatus> {
    return normalizeStatus(await this.request('status', '/status'))
  }

  /**
   * A single-use key for this computer. `hostname` = the name the bot gave this
   * device before (never the PC name); the bot answers with the one to use.
   */
  async registerDevice(hostname?: string | null): Promise<LanAuthKey> {
    const body = hostname && LAN_HOSTNAME_RE.test(hostname) ? { hostname } : {}
    const r = ((await this.post('device', '/device', body)) ?? {}) as Record<string, unknown>
    if ((r as { enabled?: unknown }).enabled === false) throw new LanApiError('disabled')
    const loginServer = safeLoginServer(r.login_server)
    const authKey = str(r.auth_key).trim()
    // printable ASCII only: it goes to the daemon's CLI (through a file)
    const name = str(r.hostname).trim().toLowerCase()
    if (!loginServer || !/^[\x21-\x7e]{8,512}$/.test(authKey) || !LAN_HOSTNAME_RE.test(name)) {
      throw new LanApiError('server', 'Сервер CipherWay вернул непонятный ответ')
    }
    return { loginServer, authKey, expiresAt: str(r.expires_at) || null, hostname: name }
  }

  async devices(): Promise<LanDevice[]> {
    return normalizeDevices(await this.request('devices', '/devices'))
  }

  async deleteDevice(nodeId: string): Promise<void> {
    await this.request('deleteDevice', `/device/${encodeURIComponent(nodeId)}`, {
      method: 'DELETE'
    })
  }

  async rooms(): Promise<LanRoom[]> {
    return normalizeRooms(await this.request('rooms', '/rooms'))
  }

  private room(json: unknown): LanRoom {
    const room = normalizeRoom(json)
    if (!room) throw new LanApiError('server', 'Сервер CipherWay вернул непонятный ответ')
    return room
  }

  async createRoom(name: string): Promise<LanRoom> {
    return this.room(await this.post('create', '/rooms', { name }))
  }

  async joinRoom(code: string): Promise<LanRoom> {
    const c = normalizeCode(code)
    if (!c) throw new LanApiError('unknown_code')
    return this.room(await this.post('join', '/rooms/join', { code: c }))
  }

  async leaveRoom(id: string): Promise<void> {
    await this.post('room', `/rooms/${encodeURIComponent(id)}/leave`)
  }

  /** the room without that member (null if the answer had none) */
  async kick(id: string, memberId: string): Promise<LanRoom | null> {
    // ids of the bot are integers; a non-numeric one is passed as it is
    const member = /^\d{1,15}$/.test(memberId) ? Number(memberId) : memberId
    return normalizeRoom(
      await this.post('room', `/rooms/${encodeURIComponent(id)}/kick`, { member_id: member })
    )
  }

  async regenerateCode(id: string): Promise<LanRoom | null> {
    return normalizeRoom(
      await this.post('room', `/rooms/${encodeURIComponent(id)}/regenerate-code`)
    )
  }
}
