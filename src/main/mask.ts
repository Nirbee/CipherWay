import type { OutboundConfig } from '@shared/types'

// ---------------------------------------------------------------------------
// Hides node addresses, credentials and the subscription link in text that
// can leave the machine (the «Логи» screen, «Скопировать диагностику»).
// Values keep their first characters so support can still tell them apart:
//   nl.example.com:443  ->  nl.***
//   https://sub.example.com/api/sub/AbCd…  ->  https://sub***
// Pure — unit tested in mask.test.ts.
// ---------------------------------------------------------------------------

const KEEP = 3
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

export function maskValue(v: string, keep = KEEP): string {
  return `${v.slice(0, keep)}***`
}

/** `https://sub.example.com/api/sub/xyz` → `https://sub***`. */
export function maskUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)?(.*)$/i.exec(url.trim())
  const scheme = m?.[1] ?? ''
  return `${scheme}${maskValue(m?.[2] ?? '')}`
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface MaskSource {
  outbounds: OutboundConfig[]
  subscriptionUrl?: string | null
}

export type Masker = (text: string) => string

/** Builds a masker for the current subscription (rebuild when it changes). */
export function createMasker(src: MaskSource): Masker {
  const hosts = new Set<string>()
  const secrets = new Set<string>()
  const tagNames = new Map<string, string>()
  for (const o of src.outbounds) {
    const h = o.server.trim().replace(/^\[|\]$/g, '')
    if (h) hosts.add(h)
    for (const s of [o.uuid, o.password, o.obfsPassword]) if (s && s.length >= 4) secrets.add(s)
    tagNames.set(o.id, o.name)
  }

  const url = src.subscriptionUrl?.trim()
  // the token is the last path segment: catch it even without the host part
  let token: string | undefined
  if (url) {
    try {
      token = new URL(url).pathname.split('/').filter(Boolean).pop()
    } catch {
      token = undefined
    }
  }

  // host, optionally followed by :port — the whole thing is hidden
  const hostRes = [...hosts]
    .sort((a, b) => b.length - a.length)
    .map(
      (h) =>
        [
          new RegExp(`(?<![\\w.-])${escapeRe(h)}(?::\\d{1,5})?(?![\\w-]|\\.[\\w])`, 'gi'),
          maskValue(h)
        ] as const
    )
  const secretRes = [...secrets]
    .sort((a, b) => b.length - a.length)
    .map((s) => [new RegExp(escapeRe(s), 'g'), maskValue(s, 2)] as const)
  const tagRes = [...tagNames].map(
    ([id, name]) => [new RegExp(`\\b${escapeRe(id)}\\b`, 'g'), `«${name}»`] as const
  )

  return (text: string): string => {
    if (!text) return text
    let out = text
    if (url) out = out.split(url).join(maskUrl(url))
    if (token && token.length >= 8) out = out.split(token).join(maskValue(token, 2))
    out = out.replace(UUID_RE, (m) => maskValue(m, 4))
    for (const [re, rep] of secretRes) out = out.replace(re, rep)
    for (const [re, rep] of hostRes) out = out.replace(re, rep)
    for (const [re, rep] of tagRes) out = out.replace(re, rep)
    return out
  }
}
