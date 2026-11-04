import { describe, expect, it, vi } from 'vitest'
import {
  isSameOrigin,
  latestSupportAt,
  normalizeThread,
  resolveImageUrl,
  sniffImage,
  SupportClient,
  SupportError,
  supportMessagesSince,
  subscriptionToken,
  type SupportContext
} from './client'

// Contract of the cabinet API (made in the bot in parallel) — every request
// here goes to a mocked fetch, nothing leaves the machine.
const BASE = 'https://cabinet.example.com'
const SUB = 'https://sub.example.com/api/sub/AbCdEf123456'
const DEVICE = {
  'User-Agent': 'CipherWay/0.4.1 (Windows)',
  Accept: '*/*',
  'x-hwid': '0123456789abcdef0123456789abcdef',
  'x-device-os': 'Windows',
  'x-ver-os': '10.0.19045',
  'x-device-model': 'PC'
}
const ctx = (over: Partial<SupportContext> = {}): SupportContext => ({
  apiBase: BASE,
  subscriptionUrl: SUB,
  deviceHeaders: DEVICE,
  ...over
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function mockFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected request')
    if (next instanceof Error) throw next
    return next
  })
  return fn
}

const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>

describe('subscription token & URLs', () => {
  it('token = last path segment of the subscription link', () => {
    expect(subscriptionToken(SUB)).toBe('AbCdEf123456')
    expect(subscriptionToken('https://sub.example.com/AbCd/?x=1')).toBe('AbCd')
    expect(subscriptionToken('https://sub.example.com/')).toBeNull()
    expect(subscriptionToken('not a url')).toBeNull()
    expect(subscriptionToken(null)).toBeNull()
  })

  it('relative image paths resolve against apiBase; only http(s)', () => {
    expect(resolveImageUrl('/media/support/1.jpg', BASE)).toBe(`${BASE}/media/support/1.jpg`)
    expect(resolveImageUrl('media/2.png', `${BASE}/`)).toBe(`${BASE}/media/2.png`)
    expect(resolveImageUrl('https://cdn.example.net/3.webp', BASE)).toBe(
      'https://cdn.example.net/3.webp'
    )
    expect(resolveImageUrl('javascript:alert(1)', BASE)).toBeUndefined()
    expect(resolveImageUrl(null, BASE)).toBeUndefined()
  })

  it('same-origin check guards the token', () => {
    expect(isSameOrigin(`${BASE}/x.png`, BASE)).toBe(true)
    expect(isSameOrigin('https://cabinet.example.com.evil.net/x.png', BASE)).toBe(false)
    expect(isSameOrigin('http://cabinet.example.com/x.png', BASE)).toBe(false)
  })
})

describe('GET /api/app/v1/support', () => {
  it('sends the token + the subscription device headers, parses the thread', async () => {
    const fetchFn = mockFetch(
      json({
        ticket_id: 77,
        status: 'open',
        messages: [
          { from: 'you', text: 'Не грузит YouTube', image: null, at: '2026-11-04T10:00:00Z' },
          {
            from: 'support',
            text: 'Пришлите скриншот',
            image: '/m/1.jpg',
            at: '2026-11-04T10:05:00Z'
          },
          { from: 'bot', text: 'junk', at: '2026-11-04T10:06:00Z' },
          { from: 'support', text: '', image: null, at: '2026-11-04T10:07:00Z' }
        ]
      })
    )
    const client = new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch)
    const thread = await client.getThread()

    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(`${BASE}/api/app/v1/support`)
    const h = headersOf(init)
    expect(h['X-Subscription-Token']).toBe('AbCdEf123456')
    expect(h['x-hwid']).toBe(DEVICE['x-hwid'])
    expect(h['x-device-os']).toBe('Windows')
    expect(h['User-Agent']).toBe('CipherWay/0.4.1 (Windows)')
    expect(init?.redirect).toBe('manual')

    expect(thread.ticketId).toBe(77)
    expect(thread.status).toBe('open')
    expect(thread.messages.map((m) => [m.from, m.text, m.image])).toEqual([
      ['you', 'Не грузит YouTube', undefined],
      ['support', 'Пришлите скриншот', `${BASE}/m/1.jpg`]
    ])
  })

  it('no ticket yet: nulls and an empty list', async () => {
    const fetchFn = mockFetch(json({ ticket_id: null, status: null, messages: [] }))
    const thread = await new SupportClient(
      () => ctx(),
      fetchFn as unknown as typeof fetch
    ).getThread()
    expect(thread).toEqual({ ticketId: null, status: null, messages: [] })
  })

  it('apiBase with a trailing slash / path prefix', async () => {
    const fetchFn = mockFetch(json({ messages: [] }))
    await new SupportClient(
      () => ctx({ apiBase: `${BASE}/cab/` }),
      fetchFn as unknown as typeof fetch
    ).getThread()
    expect(fetchFn.mock.calls[0][0]).toBe(`${BASE}/cab/api/app/v1/support`)
  })
})

describe('errors', () => {
  const run = async (...r: (Response | Error)[]) => {
    const client = new SupportClient(() => ctx(), mockFetch(...r) as unknown as typeof fetch)
    try {
      await client.getThread()
    } catch (e) {
      return e as SupportError
    }
    throw new Error('no error')
  }

  it('401 → «обновите подписку»', async () => {
    const e = await run(json({ detail: 'bad token' }, 401))
    expect(e).toBeInstanceOf(SupportError)
    expect(e.kind).toBe('auth')
    expect(e.message).toBe('Не удалось войти в поддержку — обновите подписку')
  })

  it('429 → «Слишком часто, подождите минуту»', async () => {
    const e = await run(json({}, 429))
    expect([e.kind, e.message]).toEqual(['rate', 'Слишком часто, подождите минуту'])
  })

  it('network failure → «Нет связи с сервером поддержки»', async () => {
    const e = await run(new TypeError('fetch failed'))
    expect([e.kind, e.message]).toEqual(['network', 'Нет связи с сервером поддержки'])
  })

  it('other statuses / bad JSON → readable server error', async () => {
    expect((await run(json({}, 500))).message).toBe('Сервер поддержки ответил ошибкой (код 500)')
    const bad = await run(new Response('<html>', { status: 200 }))
    expect(bad.kind).toBe('server')
  })

  it('no subscription → no request at all', async () => {
    const fetchFn = mockFetch()
    const client = new SupportClient(
      () => ctx({ subscriptionUrl: null }),
      fetchFn as unknown as typeof fetch
    )
    await expect(client.getThread()).rejects.toMatchObject({ kind: 'nosub' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('redirects: followed within the support origin, refused to any other host', async () => {
    const ok = mockFetch(
      new Response(null, { status: 307, headers: { location: '/api/app/v1/support/' } }),
      json({ messages: [] })
    )
    await new SupportClient(() => ctx(), ok as unknown as typeof fetch).getThread()
    expect(ok.mock.calls[1][0]).toBe(`${BASE}/api/app/v1/support/`)
    expect(headersOf(ok.mock.calls[1][1])['X-Subscription-Token']).toBe('AbCdEf123456')

    const evil = mockFetch(
      new Response(null, { status: 302, headers: { location: 'https://evil.example.net/' } })
    )
    const e = await new SupportClient(() => ctx(), evil as unknown as typeof fetch)
      .getThread()
      .catch((x: SupportError) => x)
    expect((e as SupportError).kind).toBe('server')
    expect(evil).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/app/v1/support', () => {
  it('JSON {text}, trimmed; parses ok/ticket/ai fields', async () => {
    const fetchFn = mockFetch(
      json({ ok: true, ticket_id: 78, ai_outcome: 'answered', ai_reply: 'Попробуйте TUN' })
    )
    const res = await new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch).sendText(
      '  Привет  '
    )
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(`${BASE}/api/app/v1/support`)
    expect(init?.method).toBe('POST')
    expect(headersOf(init)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Привет' })
    expect(res).toEqual({ ticketId: 78, aiOutcome: 'answered', aiReply: 'Попробуйте TUN' })
  })

  it('validates 1..4096 before sending', async () => {
    const fetchFn = mockFetch()
    const client = new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch)
    await expect(client.sendText('   ')).rejects.toMatchObject({ kind: 'input' })
    await expect(client.sendText('x'.repeat(4097))).rejects.toMatchObject({ kind: 'input' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('ok:false → error', async () => {
    const fetchFn = mockFetch(json({ ok: false }))
    await expect(
      new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch).sendText('a')
    ).rejects.toMatchObject({ kind: 'server' })
  })
})

describe('POST /api/app/v1/support/photo', () => {
  it('multipart: file (with its type) + text caption', async () => {
    const fetchFn = mockFetch(json({ ok: true, ticket_id: 79, ai_outcome: null, ai_reply: null }))
    const res = await new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch).sendPhoto({
      data: PNG,
      mime: 'image/png',
      caption: ' вот скрин '
    })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(`${BASE}/api/app/v1/support/photo`)
    const form = init?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const file = form.get('file') as File
    expect(file.type).toBe('image/png')
    expect(file.name).toBe('screenshot.png')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG)
    expect(form.get('text')).toBe('вот скрин')
    // fetch must set the multipart boundary itself
    expect(headersOf(init)['Content-Type']).toBeUndefined()
    expect(headersOf(init)['X-Subscription-Token']).toBe('AbCdEf123456')
    expect(res.ticketId).toBe(79)
  })

  it('rejects wrong type / mismatching bytes / > 10 MB / long caption without a request', async () => {
    const fetchFn = mockFetch()
    const c = new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch)
    await expect(c.sendPhoto({ data: JPG, mime: 'image/png', caption: '' })).rejects.toMatchObject({
      kind: 'input'
    })
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    big.set(PNG)
    await expect(c.sendPhoto({ data: big, mime: 'image/png', caption: '' })).rejects.toMatchObject({
      kind: 'input'
    })
    await expect(
      c.sendPhoto({ data: PNG, mime: 'image/png', caption: 'x'.repeat(1001) })
    ).rejects.toMatchObject({
      kind: 'input'
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('413 from the server → «до 10 МБ»', async () => {
    const fetchFn = mockFetch(json({}, 413))
    await expect(
      new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch).sendPhoto({
        data: PNG,
        mime: 'image/png',
        caption: ''
      })
    ).rejects.toThrow('10 МБ')
  })
})

describe('GET /api/app/v1/me', () => {
  it('username + has_telegram', async () => {
    const fetchFn = mockFetch(json({ ok: true, username: 'ivan', has_telegram: true }))
    const me = await new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch).me()
    expect(fetchFn.mock.calls[0][0]).toBe(`${BASE}/api/app/v1/me`)
    expect(me).toEqual({ username: 'ivan', hasTelegram: true })
  })

  it('no username', async () => {
    const fetchFn = mockFetch(json({ ok: true, username: null, has_telegram: false }))
    expect(await new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch).me()).toEqual({
      username: null,
      hasTelegram: false
    })
  })
})

describe('thread images → data: URL', () => {
  it('only from the support origin, sniffed type', async () => {
    const fetchFn = mockFetch(
      new Response(JPG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    )
    const c = new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch)
    expect(await c.image(`${BASE}/m/1.jpg`)).toBe(
      `data:image/jpeg;base64,${Buffer.from(JPG).toString('base64')}`
    )
    expect(headersOf(fetchFn.mock.calls[0][1])['X-Subscription-Token']).toBe('AbCdEf123456')
    await expect(c.image('https://cdn.example.net/1.jpg')).rejects.toMatchObject({ kind: 'input' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('non-image body is refused', async () => {
    const fetchFn = mockFetch(new Response('<html>', { status: 200 }))
    await expect(
      new SupportClient(() => ctx(), fetchFn as unknown as typeof fetch).image(`${BASE}/m/x`)
    ).rejects.toMatchObject({ kind: 'input' })
  })
})

describe('unread helpers', () => {
  const thread = normalizeThread(
    {
      messages: [
        { from: 'support', text: 'a', at: '2026-11-04T10:00:00Z' },
        { from: 'you', text: 'b', at: '2026-11-04T11:00:00Z' },
        { from: 'support', text: 'c', at: '2026-11-04T12:00:00Z' }
      ]
    },
    BASE
  )

  it('latest support time and messages since a point', () => {
    expect(latestSupportAt(thread.messages)).toBe('2026-11-04T12:00:00Z')
    expect(
      supportMessagesSince(thread.messages, '2026-11-04T10:00:00Z').map((m) => m.text)
    ).toEqual(['c'])
    expect(supportMessagesSince(thread.messages, null)).toHaveLength(2)
    expect(latestSupportAt([])).toBeNull()
  })

  it('sniffImage', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPG)).toBe('image/jpeg')
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
