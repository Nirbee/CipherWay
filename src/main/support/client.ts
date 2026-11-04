import type {
  SupportImageMime,
  SupportMe,
  SupportMessage,
  SupportPhoto,
  SupportSendResult,
  SupportThread
} from '@shared/types'

// ---------------------------------------------------------------------------
// In-app support chat — client of the cabinet API (CipherWay bot):
//   GET  /api/app/v1/support        → { ticket_id, status, messages[] }
//   POST /api/app/v1/support        { text }            → { ok, ticket_id, ai_outcome, ai_reply }
//   POST /api/app/v1/support/photo  multipart file+text → same as above
//   GET  /api/app/v1/me             → { ok, username, has_telegram }
// Auth: `X-Subscription-Token: <last path segment of the subscription link>`
// plus the same device headers as the subscription request (x-hwid, UA, …).
// Runs in the main process only — the token never reaches the renderer.
// fetch is injected so the client is unit tested with mocks (client.test.ts).
// ---------------------------------------------------------------------------

export const SUPPORT_TEXT_MAX = 4096
export const SUPPORT_CAPTION_MAX = 1000
export const SUPPORT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const SUPPORT_IMAGE_MIMES: readonly SupportImageMime[] = [
  'image/jpeg',
  'image/png',
  'image/webp'
]

const REQUEST_TIMEOUT_MS = 15_000
const UPLOAD_TIMEOUT_MS = 60_000

export type SupportErrorKind = 'auth' | 'rate' | 'network' | 'server' | 'input' | 'nosub'

export const SUPPORT_ERRORS = {
  auth: 'Не удалось войти в поддержку — обновите подписку',
  rate: 'Слишком часто, подождите минуту',
  network: 'Нет связи с сервером поддержки',
  nosub: 'Чтобы писать в поддержку, сначала добавьте подписку'
} as const

export class SupportError extends Error {
  constructor(
    message: string,
    public readonly kind: SupportErrorKind,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'SupportError'
  }
}

export interface SupportContext {
  /** https://cabinet.example.com (no trailing slash needed) */
  apiBase: string
  subscriptionUrl: string | null
  /** device headers of the subscription request: User-Agent, x-hwid, x-device-os, … */
  deviceHeaders: Record<string, string>
}

type FetchFn = typeof fetch

/** The subscription token = last non-empty path segment of the link. */
export function subscriptionToken(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop()
    return seg && /^[\x21-\x7e]+$/.test(seg) ? seg : null
  } catch {
    return null
  }
}

export function normalizeBase(apiBase: string): string {
  return apiBase.trim().replace(/\/+$/, '')
}

/** Relative image paths are relative to apiBase; only http(s) survives. */
export function resolveImageUrl(image: unknown, apiBase: string): string | undefined {
  if (typeof image !== 'string' || !image.trim()) return undefined
  try {
    const base = `${normalizeBase(apiBase)}/`
    const u = new URL(image.trim(), base)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

/** Same scheme + host + port as apiBase (the token is never sent anywhere else). */
export function isSameOrigin(url: string, apiBase: string): boolean {
  try {
    return new URL(url).origin === new URL(normalizeBase(apiBase)).origin
  } catch {
    return false
  }
}

interface RawThread {
  ticket_id?: unknown
  status?: unknown
  messages?: unknown
}

export function normalizeThread(json: unknown, apiBase: string): SupportThread {
  const raw = (json && typeof json === 'object' ? json : {}) as RawThread
  const list = Array.isArray(raw.messages) ? raw.messages : []
  const messages: SupportMessage[] = []
  list.forEach((m, i) => {
    if (!m || typeof m !== 'object') return
    const r = m as Record<string, unknown>
    if (r.from !== 'you' && r.from !== 'support') return
    const text = typeof r.text === 'string' ? r.text : ''
    const image = resolveImageUrl(r.image, apiBase)
    if (!text && !image) return
    const at = typeof r.at === 'string' ? r.at : ''
    messages.push({ key: `${i}-${at}`, from: r.from, text, at, ...(image ? { image } : {}) })
  })
  return {
    ticketId: typeof raw.ticket_id === 'number' ? raw.ticket_id : null,
    status: typeof raw.status === 'string' ? raw.status : null,
    messages
  }
}

function normalizeSend(json: unknown): SupportSendResult {
  const r = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  if (r.ok !== true || typeof r.ticket_id !== 'number') {
    throw new SupportError('Сервер поддержки вернул непонятный ответ', 'server')
  }
  return {
    ticketId: r.ticket_id,
    aiOutcome: typeof r.ai_outcome === 'string' ? r.ai_outcome : null,
    aiReply: typeof r.ai_reply === 'string' ? r.ai_reply : null
  }
}

export function statusError(status: number): SupportError {
  if (status === 401 || status === 403) return new SupportError(SUPPORT_ERRORS.auth, 'auth', status)
  if (status === 429) return new SupportError(SUPPORT_ERRORS.rate, 'rate', status)
  if (status === 413) return new SupportError('Файл слишком большой — до 10 МБ', 'input', status)
  if (status === 415) {
    return new SupportError(
      'Этот формат не подходит — нужна картинка JPG, PNG или WebP',
      'input',
      status
    )
  }
  return new SupportError(`Сервер поддержки ответил ошибкой (код ${status})`, 'server', status)
}

/** Magic bytes of the formats the API accepts (the declared type must match). */
export function sniffImage(data: Uint8Array): SupportImageMime | null {
  const b = data
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png'
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' &&
    String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

const EXT: Record<SupportImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
}

export class SupportClient {
  constructor(
    private ctx: () => SupportContext | Promise<SupportContext>,
    private fetchFn: FetchFn = (...a) => fetch(...a)
  ) {}

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const c = await this.ctx()
    const token = subscriptionToken(c.subscriptionUrl)
    if (!token) throw new SupportError(SUPPORT_ERRORS.nosub, 'nosub')
    let res: Response
    try {
      res = await this.fetchSameOrigin(`${normalizeBase(c.apiBase)}${path}`, c.apiBase, {
        ...init,
        headers: {
          ...c.deviceHeaders,
          Accept: 'application/json',
          'X-Subscription-Token': token,
          ...(init.headers as Record<string, string> | undefined)
        },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      if (e instanceof SupportError) throw e
      throw new SupportError(SUPPORT_ERRORS.network, 'network')
    }
    if (!res.ok) throw statusError(res.status)
    try {
      return await res.json()
    } catch {
      throw new SupportError('Сервер поддержки вернул непонятный ответ', 'server', res.status)
    }
  }

  /**
   * Redirects are followed by hand and only within the support server's
   * origin: fetch would carry X-Subscription-Token to any other host too.
   */
  private async fetchSameOrigin(
    url: string,
    apiBase: string,
    init: RequestInit
  ): Promise<Response> {
    let target = url
    for (let hop = 0; hop < 4; hop++) {
      const res = await this.fetchFn(target, { ...init, redirect: 'manual' })
      const loc = res.headers.get('location')
      if (![301, 302, 303, 307, 308].includes(res.status) || !loc) return res
      const next = new URL(loc, target).toString()
      if (!isSameOrigin(next, apiBase)) {
        throw new SupportError('Сервер поддержки перенаправил на чужой адрес', 'server', res.status)
      }
      target = next
    }
    throw new SupportError('Сервер поддержки перенаправляет по кругу', 'server')
  }

  async getThread(): Promise<SupportThread> {
    const { apiBase } = await this.ctx()
    return normalizeThread(await this.request('/api/app/v1/support'), apiBase)
  }

  async me(): Promise<SupportMe> {
    const r = ((await this.request('/api/app/v1/me')) ?? {}) as Record<string, unknown>
    return {
      username: typeof r.username === 'string' && r.username ? r.username : null,
      hasTelegram: r.has_telegram === true
    }
  }

  async sendText(text: string): Promise<SupportSendResult> {
    const body = text.trim()
    if (!body) throw new SupportError('Напишите сообщение', 'input')
    if (body.length > SUPPORT_TEXT_MAX) {
      throw new SupportError(`Сообщение длиннее ${SUPPORT_TEXT_MAX} символов`, 'input')
    }
    return normalizeSend(
      await this.request('/api/app/v1/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body })
      })
    )
  }

  async sendPhoto(photo: SupportPhoto): Promise<SupportSendResult> {
    if (!SUPPORT_IMAGE_MIMES.includes(photo.mime) || sniffImage(photo.data) !== photo.mime) {
      throw new SupportError('Можно приложить только картинку JPG, PNG или WebP', 'input')
    }
    if (photo.data.byteLength > SUPPORT_IMAGE_MAX_BYTES) {
      throw new SupportError('Картинка больше 10 МБ', 'input')
    }
    const caption = photo.caption.trim()
    if (caption.length > SUPPORT_CAPTION_MAX) {
      throw new SupportError(`Подпись к картинке длиннее ${SUPPORT_CAPTION_MAX} символов`, 'input')
    }
    const form = new FormData()
    // copy into a plain ArrayBuffer (IPC may hand us a view over a shared one)
    const bytes = new Uint8Array(photo.data.byteLength)
    bytes.set(photo.data)
    form.append('file', new Blob([bytes], { type: photo.mime }), `screenshot.${EXT[photo.mime]}`)
    form.append('text', caption)
    // no Content-Type header: fetch sets multipart/form-data with the boundary
    return normalizeSend(
      await this.request(
        '/api/app/v1/support/photo',
        { method: 'POST', body: form },
        UPLOAD_TIMEOUT_MS
      )
    )
  }

  /**
   * An image of the thread as a data: URL (the renderer's CSP allows only
   * those). Only from the support server itself — the token goes nowhere else.
   */
  async image(url: string): Promise<string> {
    const c = await this.ctx()
    if (!isSameOrigin(url, c.apiBase)) throw new SupportError('Картинка с чужого адреса', 'input')
    const token = subscriptionToken(c.subscriptionUrl)
    if (!token) throw new SupportError(SUPPORT_ERRORS.nosub, 'nosub')
    let res: Response
    try {
      res = await this.fetchSameOrigin(url, c.apiBase, {
        headers: { ...c.deviceHeaders, 'X-Subscription-Token': token },
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
      })
    } catch (e) {
      if (e instanceof SupportError) throw e
      throw new SupportError(SUPPORT_ERRORS.network, 'network')
    }
    if (!res.ok) throw statusError(res.status)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > SUPPORT_IMAGE_MAX_BYTES)
      throw new SupportError('Картинка больше 10 МБ', 'input')
    const mime = sniffImage(buf)
    if (!mime) throw new SupportError('Это не картинка', 'input')
    return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`
  }
}

// --- unread / notifications (pure) -----------------------------------------

const time = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** ISO time of the newest support message, null if there is none. */
export function latestSupportAt(messages: SupportMessage[]): string | null {
  let best: SupportMessage | null = null
  for (const m of messages) {
    if (m.from !== 'support') continue
    if (!best || time(m.at) >= time(best.at)) best = m
  }
  return best ? best.at : null
}

/** Support messages newer than `sinceIso` (all of them when null). */
export function supportMessagesSince(
  messages: SupportMessage[],
  sinceIso: string | null
): SupportMessage[] {
  const since = sinceIso ? time(sinceIso) : -Infinity
  return messages.filter((m) => m.from === 'support' && time(m.at) > since)
}
