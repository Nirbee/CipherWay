import {
  isSameOrigin,
  normalizeBase,
  subscriptionToken,
  type SupportContext
} from '../support/client'

// ---------------------------------------------------------------------------
// DevVersion — client of the bot API (contract: .claude/plans/devversion.md):
//   GET    /api/app/v1/telemetry/config → {enabled, consent_version, upload_interval_s,
//                                          max_report_bytes, flags:{}}
//   POST   /api/app/v1/telemetry        JSON (Content-Encoding: gzip) → 202 {ok:true}
//          ≤ max_report_bytes (512 KB) both gzipped and raw · 413 too large · 429 rate (6/h, 60/day, 20 MB/day) ·
//          403 inactive / {detail:"trial_not_allowed"} / {detail:"not_allowed"} · 503 retry ·
//          404 {detail:"telemetry_disabled"} collection off · 422 contract broken
//          (detail = the field) · 415 bad Content-Type / -Encoding · 400 bad JSON / gzip
//   DELETE /api/app/v1/telemetry        → {deleted:N}
// Same auth as «LAN» / the support chat: X-Subscription-Token + the device
// headers, the token goes to the API origin only (redirects by hand).
//
// Direct, never through the VPN (the server tells the provider by the IP the
// request came from): Node's own fetch (undici) in the main process ignores
// the WinInet system proxy, so in «Системный прокси» it leaves directly; in
// TUN the bot's host is in the core's direct rules (configGen directHosts) —
// the service checks that before sending (DevVersionService.directReady).
// fetch is injected — unit tested in api.test.ts.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 20_000
const UPLOAD_TIMEOUT_MS = 60_000
const BASE = '/api/app/v1/telemetry'

export interface TelemetryConfig {
  enabled: boolean
  consentVersion: string | null
  uploadIntervalS: number
  maxReportBytes: number
  flags: Record<string, unknown>
  /** Why `enabled` is false: 'disabled' | 'trial_not_allowed' | 'not_allowed' (or null). */
  reason: string | null
}

export const DEFAULT_CONFIG: TelemetryConfig = {
  reason: null,
  enabled: true,
  consentVersion: null,
  uploadIntervalS: 3600,
  maxReportBytes: 512 * 1024,
  flags: {}
}

const clampInt = (v: unknown, min: number, max: number, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : def

export function normalizeConfig(json: unknown): TelemetryConfig {
  const r = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const cv = r.consent_version
  return {
    enabled: r.enabled !== false,
    consentVersion: typeof cv === 'string' ? cv : typeof cv === 'number' ? String(cv) : null,
    // the server limits to 6 / hour anyway; less often than daily makes no sense
    uploadIntervalS: clampInt(r.upload_interval_s, 600, 86_400, DEFAULT_CONFIG.uploadIntervalS),
    maxReportBytes: clampInt(
      r.max_report_bytes,
      64 * 1024,
      1024 * 1024,
      DEFAULT_CONFIG.maxReportBytes
    ),
    flags: normalizeFlags(r.flags),
    reason: typeof r.reason === 'string' ? r.reason.slice(0, 32) : null
  }
}

const FLAG_KEY_RE = /^[a-z0-9_]{1,32}$/
const FLAG_STRING_MAX = 64

/** Flat flags only: key ^[a-z0-9_]{1,32}$, value bool / integer / short string. */
export function normalizeFlags(v: unknown): Record<string, boolean | number | string> {
  const out: Record<string, boolean | number | string> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!FLAG_KEY_RE.test(k)) continue
    if (
      typeof x === 'boolean' ||
      (typeof x === 'number' && Number.isInteger(x)) ||
      (typeof x === 'string' && x.length <= FLAG_STRING_MAX)
    ) {
      out[k] = x
    }
  }
  return out
}

export type TelemetryErrorKind =
  | 'nosub'
  | 'network'
  | 'too_large'
  | 'rate'
  | 'inactive'
  | 'forbidden'
  | 'auth'
  | 'not_found'
  | 'disabled'
  | 'trial'
  | 'not_allowed'
  | 'rejected'
  | 'unsupported'
  | 'server'

export class TelemetryError extends Error {
  constructor(
    public readonly kind: TelemetryErrorKind,
    public readonly status?: number,
    /** Retry-After, ms */
    public readonly retryAfterMs?: number,
    /** the server's `detail` (422: which part of the contract) */
    public readonly detail?: string
  ) {
    super(`telemetry: ${kind}${status ? ` (${status})` : ''}`)
    this.name = 'TelemetryError'
  }
}

function detailOf(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const d = (body as Record<string, unknown>).detail ?? (body as Record<string, unknown>).error
  return typeof d === 'string' ? d.trim().toLowerCase() : ''
}

/** Retry-After: seconds or an HTTP date → ms (undefined = none / unreadable). */
export function retryAfterMs(h: string | null, now = Date.now()): number | undefined {
  if (!h) return undefined
  const s = Number(h)
  if (Number.isFinite(s) && s >= 0) return Math.min(24 * 3600_000, s * 1000)
  const at = Date.parse(h)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

export function telemetryError(
  status: number,
  detail: string,
  retryAfter?: number
): TelemetryError {
  if (status === 413) return new TelemetryError('too_large', status)
  if (status === 429) return new TelemetryError('rate', status, retryAfter)
  if (status === 403 && detail === 'trial_not_allowed') return new TelemetryError('trial', status)
  if (status === 403 && detail === 'not_allowed') return new TelemetryError('not_allowed', status)
  // any other 403 of the bot: the subscription is not active
  if (status === 403) return new TelemetryError('inactive', status)
  if (status === 401) return new TelemetryError('auth', status)
  if (status === 404 && detail === 'telemetry_disabled')
    return new TelemetryError('disabled', status)
  if (status === 404) return new TelemetryError('not_found', status)
  if (status === 400 || status === 422) {
    return new TelemetryError('rejected', status, undefined, detail || undefined)
  }
  if (status === 415) return new TelemetryError('unsupported', status)
  return new TelemetryError('server', status, retryAfter)
}

type FetchFn = typeof fetch

export class TelemetryApi {
  constructor(
    private ctx: () => SupportContext | Promise<SupportContext>,
    private fetchFn: FetchFn = (...a) => fetch(...a)
  ) {}

  /** host of the API (for the core's direct rules) */
  static host(apiBase: string): string | null {
    try {
      return new URL(normalizeBase(apiBase)).hostname.toLowerCase() || null
    } catch {
      return null
    }
  }

  private async request(
    path: string,
    init: RequestInit & { headers?: Record<string, string> },
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<{ status: number; body: unknown }> {
    const c = await this.ctx()
    const token = subscriptionToken(c.subscriptionUrl)
    if (!token) throw new TelemetryError('nosub')
    let target = `${normalizeBase(c.apiBase)}${BASE}${path}`
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
            ...(init.headers ?? {})
          },
          signal: AbortSignal.timeout(timeoutMs)
        })
        const loc = res.headers.get('location')
        if (![301, 302, 303, 307, 308].includes(res.status) || !loc) break
        const next = new URL(loc, target).toString()
        if (!isSameOrigin(next, c.apiBase)) throw new TelemetryError('server', res.status)
        target = next
        res = null
      }
    } catch (e) {
      if (e instanceof TelemetryError) throw e
      throw new TelemetryError('network')
    }
    if (!res) throw new TelemetryError('server')
    const text = await res.text().catch(() => '')
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!res.ok) {
      throw telemetryError(res.status, detailOf(body), retryAfterMs(res.headers.get('retry-after')))
    }
    return { status: res.status, body }
  }

  async config(): Promise<TelemetryConfig> {
    return normalizeConfig((await this.request('/config', { method: 'GET' })).body)
  }

  /** One gzip-compressed JSON report; resolves with the server's id (or null). */
  async upload(gz: Uint8Array): Promise<string | null> {
    const { body } = await this.request(
      '',
      {
        method: 'POST',
        // undici sends a byte array as it is
        body: gz as unknown as BodyInit,
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }
      },
      UPLOAD_TIMEOUT_MS
    )
    const id = (body as Record<string, unknown> | null)?.id
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null
  }

  async deleteAll(): Promise<number> {
    const { body } = await this.request('', { method: 'DELETE' })
    const n = (body as Record<string, unknown> | null)?.deleted
    return typeof n === 'number' ? n : 0
  }
}
