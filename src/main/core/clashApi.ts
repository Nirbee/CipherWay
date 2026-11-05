import { LATENCY_TIMEOUT_MS, LATENCY_URL } from './sbTypes'
import type { RawConnections } from './connections'

/**
 * Minimal client for sing-box's Clash-compatible API (experimental.clash_api),
 * which only ever listens on 127.0.0.1:<random port>. Endpoints used —
 * checked against sing-box 1.13.14:
 *   GET    /configs                     → { mode, mode-list }
 *   PATCH  /configs   { mode }          → 204 (mode name case-insensitive)
 *   GET    /proxies/<tag>               → { type, now, all }
 *   PUT    /proxies/<selector> { name } → 204 / 400 for an unknown member
 *   GET    /proxies/<tag>/delay?url&timeout → { delay } / 503 «An error occurred…»
 *   GET    /proxies                    → { proxies: { <tag>: { now?, history: [{delay}] } } }
 *          (a group's history is the one of its current `now`; a member
 *           whose last test failed has an empty history)
 *   GET    /group/<tag>/delay?url&timeout → { <member>: delay } of the members
 *          it actually tested (a no-op `{}` while a check is already running)
 *   GET    /connections · DELETE /connections[/<id>]
 * Note (1.13.x): a urltest group checks its members right after start; until
 * that finishes `now` is "" and traffic uses the first member.
 */

export interface ProxyState {
  now?: string
  /** last successful test, undefined = none (failed / not tested yet) */
  delay?: number
}

interface RawProxy {
  now?: string
  history?: { delay?: number }[]
}

function toState(p: RawProxy | undefined): ProxyState {
  const last = p?.history?.at(-1)?.delay
  return {
    ...(p?.now ? { now: p.now } : {}),
    ...(typeof last === 'number' && last > 0 ? { delay: last } : {})
  }
}
export class ClashApi {
  /**
   * @param secret clash_api.secret of the core: without it any local process
   *   (other Windows users too) could steer the — possibly elevated — core
   */
  constructor(
    private port: number,
    private secret?: string
  ) {}

  private url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`
  }

  private async req(path: string, init: RequestInit = {}, timeoutMs = 2000): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.secret) headers.set('Authorization', `Bearer ${this.secret}`)
    return fetch(this.url(path), { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
  }

  /** true once the controller answers (core is up). */
  async ping(): Promise<boolean> {
    try {
      const res = await this.req('/configs', {}, 700)
      return res.ok
    } catch {
      return false
    }
  }

  async setMode(mode: string): Promise<boolean> {
    const res = await this.req('/configs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    })
    return res.ok
  }

  async getMode(): Promise<string | null> {
    const res = await this.req('/configs')
    if (!res.ok) return null
    const json = (await res.json()) as { mode?: string }
    return json.mode ?? null
  }

  async select(group: string, name: string): Promise<boolean> {
    const res = await this.req(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    })
    return res.ok
  }

  /** `now` of a group (selector/urltest), null if unknown. */
  async groupNow(group: string): Promise<string | null> {
    try {
      const res = await this.req(`/proxies/${encodeURIComponent(group)}`, {}, 1000)
      if (!res.ok) return null
      const json = (await res.json()) as { now?: string }
      return json.now ?? null
    } catch {
      return null
    }
  }

  /** `now` + latest delay of one proxy / group; null = API unreachable. */
  async proxyState(tag: string): Promise<ProxyState | null> {
    try {
      const res = await this.req(`/proxies/${encodeURIComponent(tag)}`, {}, 1000)
      if (!res.ok) return null
      return toState((await res.json()) as RawProxy)
    } catch {
      return null
    }
  }

  /** Every proxy's `now` + latest delay; null = API unreachable. */
  async proxies(): Promise<Record<string, ProxyState> | null> {
    try {
      const res = await this.req('/proxies', {}, 1500)
      if (!res.ok) return null
      const json = (await res.json()) as { proxies?: Record<string, RawProxy> }
      const out: Record<string, ProxyState> = {}
      for (const [tag, p] of Object.entries(json.proxies ?? {})) out[tag] = toState(p)
      return out
    } catch {
      return null
    }
  }

  /**
   * Forces a check of a urltest group; returns member → delay of the answered
   * ones. sing-box answers only after its slowest member (a silent node: its
   * own 15 s TCP timeout), so `waitMs` may need to be longer than `timeoutMs`.
   */
  async groupDelay(
    group: string,
    timeoutMs = LATENCY_TIMEOUT_MS,
    waitMs = timeoutMs + 3000
  ): Promise<Record<string, number> | null> {
    const q = new URLSearchParams({ url: LATENCY_URL, timeout: String(timeoutMs) })
    try {
      const res = await this.req(
        `/group/${encodeURIComponent(group)}/delay?${q.toString()}`,
        {},
        waitMs
      )
      if (!res.ok) return null
      return (await res.json()) as Record<string, number>
    } catch {
      return null
    }
  }

  /** Real HTTP round trip through the outbound; null = no response. */
  async delay(tag: string, timeoutMs = LATENCY_TIMEOUT_MS): Promise<number | null> {
    const q = new URLSearchParams({ url: LATENCY_URL, timeout: String(timeoutMs) })
    try {
      const res = await this.req(
        `/proxies/${encodeURIComponent(tag)}/delay?${q.toString()}`,
        {},
        timeoutMs + 1500
      )
      if (!res.ok) return null
      const json = (await res.json()) as { delay?: number }
      return typeof json.delay === 'number' && json.delay > 0 ? json.delay : null
    } catch {
      return null
    }
  }

  async connections(): Promise<RawConnections | null> {
    try {
      const res = await this.req('/connections', {}, 900)
      if (!res.ok) return null
      return (await res.json()) as RawConnections
    } catch {
      return null
    }
  }

  async closeConnection(id: string): Promise<void> {
    await this.req(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
      () => undefined
    )
  }

  async closeAll(): Promise<void> {
    await this.req('/connections', { method: 'DELETE' }).catch(() => undefined)
  }
}
