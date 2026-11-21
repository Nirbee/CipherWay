// ---------------------------------------------------------------------------
// What never leaves the LAN daemon's log for «Логи» (and the diagnostics the
// user may send to support): pre-auth keys (Tailscale tskey-…, Headscale
// hskey-… and the older 48-hex keys), private keys, and the public internet
// addresses of the user and their friends (magicsock prints every endpoint).
// LAN addresses (100.64.0.0/10), loopback and private ranges stay readable.
// Pure — unit tested in redact.test.ts.
// ---------------------------------------------------------------------------

const KEY_PATTERNS: RegExp[] = [
  /\btskey-[A-Za-z0-9_-]+/g,
  /\bhskey-[A-Za-z0-9_-]+/g,
  /\b(?:privkey|nodekey-priv|nlpriv|mkey-priv|discokey-priv):[0-9a-f]+/gi,
  // --auth-key=<x> / auth_key: <x> / authkey <x> (never the file: form — that is a path)
  /(\bauth[-_]?key["']?\s*[=:]\s*["']?)(?!file:)[^\s"',}]+/gi,
  // legacy Headscale pre-auth keys: 48 hex digits
  /\b[0-9a-f]{48}\b/gi
]

const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g

function isPrivate4(a: number, b: number): boolean {
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

export function redactLan(line: string): string {
  let out = line
  for (const re of KEY_PATTERNS) {
    out = out.replace(re, (m, prefix?: string) =>
      typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}[скрыто]` : '[скрыто]'
    )
  }
  out = out.replace(IPV4_RE, (m, a: string, b: string, c: string, d: string) => {
    const n = [a, b, c, d].map(Number)
    if (n.some((x) => x > 255)) return m
    return isPrivate4(n[0], n[1]) ? m : 'x.x.x.x'
  })
  // global IPv6 (2000::/3) — peers' endpoints; fd7a:… (LAN) and link-local stay
  out = out.replace(/\[?\b[23][0-9a-f]{3}:[0-9a-f:]{2,}\b\]?/gi, '[ipv6]')
  return out
}
