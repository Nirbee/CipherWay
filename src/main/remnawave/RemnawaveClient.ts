import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { SubscriptionData } from '@shared/types'
import { store } from '../store'
import { setSubscriptionUrl } from '../secrets'
import { parseOutbounds } from './parsers'
import { buildSubscriptionHeaders, getDeviceInfo } from './device'
import { filterSubscription, httpStatusError, hwidHeaderError } from './subscriptionGuard'
import { parseSubscriptionHeaders } from './headers'

/** Persistent random id, used for x-hwid only if MachineGuid is unreadable. */
function fallbackDeviceId(): string {
  let id = store.get('deviceIdFallback')
  if (!id) {
    id = randomUUID()
    store.set('deviceIdFallback', id)
  }
  return id
}

/** a request nobody is waiting for must not hang forever either */
const DEFAULT_TIMEOUT_MS = 30_000

/** `fetch failed` / `The operation was aborted` → readable Russian. */
function networkError(err: unknown): Error {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Error('Сервер подписки не ответил вовремя')
  }
  return new Error('Не удалось связаться с сервером подписки')
}

export class RemnawaveClient {
  private listeners = new Set<(d: SubscriptionData) => void>()

  /** Called after every successful fetch (manual or background). */
  onUpdate(cb: (d: SubscriptionData) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(d: SubscriptionData): void {
    for (const cb of this.listeners) cb(d)
  }

  /** Fetch a subscription by URL, parse outbounds, persist URL + cache. */
  async fetchSubscription(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SubscriptionData> {
    const device = await getDeviceInfo(fallbackDeviceId)
    const signal = AbortSignal.timeout(timeoutMs)
    const res = await fetch(url, {
      // "CipherWay/<ver> (Windows)" doesn't match the panel's clash/mihomo UA
      // rules, so Remnawave answers with the plain link list (XRAY_BASE64).
      headers: buildSubscriptionHeaders(device, app.getVersion()),
      redirect: 'follow',
      signal
    }).catch((err: unknown) => {
      throw networkError(err)
    })
    // HWID verdict first: on a device-limit hit the body is only a stub
    const hwidError = hwidHeaderError((n) => res.headers.get(n))
    if (hwidError) throw new Error(hwidError)
    if (!res.ok) throw new Error(httpStatusError(res.status, res.statusText))

    const raw = await res.text().catch((err: unknown) => {
      throw networkError(err)
    })
    const guarded = filterSubscription(parseOutbounds(raw))
    if (guarded.error) throw new Error(guarded.error)
    const outbounds = guarded.outbounds

    const data: SubscriptionData = {
      // the link itself lives encrypted in secrets.ts, never in the plain cache
      url: '',
      fetchedAt: Date.now(),
      outbounds,
      ...parseSubscriptionHeaders((n) => res.headers.get(n))
    }

    setSubscriptionUrl(url)
    store.set('subscriptionCache', data)
    this.notify(data)
    return data
  }

  /** The headers a subscription request carries (UA, x-hwid, x-device-*) — reused by support. */
  async deviceHeaders(): Promise<Record<string, string>> {
    const device = await getDeviceInfo(fallbackDeviceId)
    return buildSubscriptionHeaders(device, app.getVersion())
  }

  /** Warm the device-info cache (WMI query takes ~1–3 s on first call). */
  prefetchDevice(): void {
    void getDeviceInfo(fallbackDeviceId).catch(() => undefined)
  }

  /** Cached subscription (may be stale / offline). */
  getCached(): SubscriptionData | null {
    const data = store.get('subscriptionCache')
    if (!data) return null
    // caches written by ≤0.2.x may still hold panel placeholders (0.0.0.0:1)
    return { ...data, url: '', outbounds: filterSubscription(data.outbounds).outbounds }
  }
}

export const remnawave = new RemnawaveClient()
