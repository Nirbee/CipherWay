// ---------------------------------------------------------------------------
// cipherway:// deep links (subscription import from the bot / website).
//
//   cipherway://import?url=<urlencoded https subscription URL>
//   cipherway://install-config?url=<...>     (Clash / Koala Clash style alias)
//
// Only https subscription URLs are accepted. The link never connects by
// itself — the renderer asks «Добавить подписку с <домен>?» first.
// Pure functions — unit tested in deeplink.test.ts.
// ---------------------------------------------------------------------------

export const PROTOCOL = 'cipherway'

const ACTIONS = new Set(['import', 'install-config'])
const MAX_LINK_LEN = 4096
const MAX_URL_LEN = 2048

export interface ImportRequest {
  /** https subscription URL to add */
  url: string
  /** its host name, shown in the confirmation dialog */
  host: string
}

function decodeMaybeTwice(v: string): string {
  // some sites/bots double-encode the parameter (https%253A%252F%252F...)
  if (/^https?%3a/i.test(v)) {
    try {
      return decodeURIComponent(v)
    } catch {
      return v
    }
  }
  return v
}

/** Parses a cipherway:// link; returns null for anything not acceptable. */
export function parseDeepLink(raw: unknown): ImportRequest | null {
  if (typeof raw !== 'string') return null
  const link = raw.trim()
  if (!link || link.length > MAX_LINK_LEN) return null

  let u: URL
  try {
    u = new URL(link)
  } catch {
    return null
  }
  if (u.protocol !== `${PROTOCOL}:`) return null

  // cipherway://import?url=…   -> hostname "import", pathname "" or "/"
  // cipherway:import?url=…     -> hostname "",       pathname "import"
  const path = u.pathname.replace(/^\/+|\/+$/g, '')
  const action = (u.hostname || path).toLowerCase()
  if (u.hostname && path) return null
  if (!ACTIONS.has(action)) return null

  const param = u.searchParams.get('url')
  if (!param) return null
  const target = decodeMaybeTwice(param.trim())
  if (target.length > MAX_URL_LEN) return null

  let t: URL
  try {
    t = new URL(target)
  } catch {
    return null
  }
  if (t.protocol !== 'https:' || !t.hostname) return null
  if (t.username || t.password) return null

  return { url: target, host: t.hostname }
}

/** First cipherway:// argument in a process argv (Windows passes the link as an arg). */
export function findDeepLinkArg(argv: readonly string[]): string | null {
  const prefix = `${PROTOCOL}:`
  return argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(prefix)) ?? null
}
