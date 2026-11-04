import type { SubscriptionData, SubscriptionUserInfo } from '@shared/types'

// ---------------------------------------------------------------------------
// Response headers of a Remnawave (and generally Clash/V2Ray-style)
// subscription. Pure functions — unit tested in headers.test.ts.
//
//   subscription-userinfo: upload=1; download=2; total=10737418240; expire=1735689600
//   profile-title:         base64:0JzQvtGPINC/0L7QtNC/0LjRgdC60LA=   (or plain text)
//   support-url:           https://t.me/...
//   profile-web-page-url:  https://...
//   announce:              base64:...                                (or plain text)
//   profile-update-interval: 12
// ---------------------------------------------------------------------------

type HeaderGetter = (name: string) => string | null

/** `upload=…; download=…; total=…; expire=…` → numbers (unknown keys ignored). */
export function parseUserInfoHeader(header: string | null): SubscriptionUserInfo | undefined {
  if (!header) return undefined
  const out: SubscriptionUserInfo = {}
  for (const part of header.split(';')) {
    const [k, v] = part.split('=').map((s) => s?.trim())
    if (!k || v === undefined || v === '') continue
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) continue
    if (k === 'upload') out.upload = n
    else if (k === 'download') out.download = n
    else if (k === 'total') out.total = n
    else if (k === 'expire') out.expire = n
  }
  return Object.keys(out).length ? out : undefined
}

/** Header text that may be `base64:`-prefixed; trimmed, empty → undefined. */
export function decodeHeaderText(header: string | null): string | undefined {
  if (header == null) return undefined
  let text = header.trim()
  if (/^base64:/i.test(text)) {
    try {
      text = Buffer.from(text.slice(7).trim(), 'base64').toString('utf8')
    } catch {
      /* keep the raw value */
    }
  }
  text = text.replace(/\0/g, '').trim()
  return text || undefined
}

/** Only links we are willing to open from a button: https and Telegram. */
export function safeLink(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const v = raw.trim()
  try {
    const u = new URL(v)
    if (u.protocol === 'https:' || u.protocol === 'tg:') return u.toString()
  } catch {
    /* not a URL */
  }
  // "t.me/xyz" / "@xyz" shorthands some panels put into support-url
  if (/^t\.me\/[\w/?=&-]+$/i.test(v)) return `https://${v}`
  if (/^@[A-Za-z0-9_]{4,32}$/.test(v)) return `https://t.me/${v.slice(1)}`
  return undefined
}

export type SubscriptionMeta = Pick<
  SubscriptionData,
  'userInfo' | 'rawTitle' | 'supportUrl' | 'webPageUrl' | 'announce' | 'updateIntervalHours'
>

export function parseSubscriptionHeaders(get: HeaderGetter): SubscriptionMeta {
  const interval = Number(get('profile-update-interval'))
  return {
    userInfo: parseUserInfoHeader(get('subscription-userinfo')),
    rawTitle: decodeHeaderText(get('profile-title')),
    supportUrl: safeLink(decodeHeaderText(get('support-url'))),
    webPageUrl: safeLink(decodeHeaderText(get('profile-web-page-url'))),
    announce: decodeHeaderText(get('announce'))?.slice(0, 600),
    updateIntervalHours: Number.isFinite(interval) && interval > 0 ? interval : undefined
  }
}
