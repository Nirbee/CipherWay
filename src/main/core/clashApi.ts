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
 *   GET    /connections · DELETE /connections[/<id>]
 */
export class ClashApi {
  constructor(private port: number) {}

  private url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`
  }

  private async req(path: string, init: RequestInit = {}, timeoutMs = 2000): Promise<Response> {
    return fetch(this.url(path), { ...init, signal: AbortSignal.timeout(timeoutMs) })
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
