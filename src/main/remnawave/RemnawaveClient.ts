import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { SubscriptionData } from '@shared/types'
import { store } from '../store'
import { getSubscriptionUrl, setSubscriptionUrl } from '../secrets'
import { parseOutbounds } from './parsers'
import { buildSubscriptionHeaders, getDeviceInfo } from './device'
import { filterSubscription, httpStatusError, hwidHeaderError } from './subscriptionGuard'

/** Persistent random id, used for x-hwid only if MachineGuid is unreadable. */
function fallbackDeviceId(): string {
  let id = store.get('deviceIdFallback')
  if (!id) {
    id = randomUUID()
    store.set('deviceIdFallback', id)
  }
  return id
}

/**
 * Parses the standard `subscription-userinfo` header that most panels
 * (Remnawave included) expose, e.g.:
 *   upload=12345; download=67890; total=10737418240; expire=1735689600
 */
export function parseUserInfoHeader(header: string | null): SubscriptionData['userInfo'] {
  if (!header) return undefined
  const out: NonNullable<SubscriptionData['userInfo']> = {}
  for (const part of header.split(';')) {
    const [k, v] = part.split('=').map((s) => s.trim())
    const n = Number(v)
    if (Number.isNaN(n)) continue
    if (k === 'upload') out.upload = n
    else if (k === 'download') out.download = n
    else if (k === 'total') out.total = n
    else if (k === 'expire') out.expire = n
  }
  return Object.keys(out).length ? out : undefined
}

function decodeTitle(header: string | null): string | undefined {
  if (!header) return undefined
  // panels sometimes base64-encode the title in `profile-title: base64:...`
  if (header.startsWith('base64:')) {
    try {
      return Buffer.from(header.slice(7), 'base64').toString('utf8')
    } catch {
      return header
    }
  }
  return header
}

export class RemnawaveClient {
  private timer: NodeJS.Timeout | null = null

  /** Fetch a subscription by URL, parse outbounds, persist URL + cache. */
  async fetchSubscription(url: string): Promise<SubscriptionData> {
    const device = await getDeviceInfo(fallbackDeviceId)
    const res = await fetch(url, {
      // "CipherWay/<ver> (Windows)" doesn't match the panel's clash/mihomo UA
      // rules, so Remnawave answers with the plain link list (XRAY_BASE64).
      headers: buildSubscriptionHeaders(device, app.getVersion()),
      redirect: 'follow'
    })
    // HWID verdict first: on a device-limit hit the body is only a stub
    const hwidError = hwidHeaderError((n) => res.headers.get(n))
    if (hwidError) throw new Error(hwidError)
    if (!res.ok) throw new Error(httpStatusError(res.status, res.statusText))

    const raw = await res.text()
    const guarded = filterSubscription(parseOutbounds(raw))
    if (guarded.error) throw new Error(guarded.error)
    const outbounds = guarded.outbounds

    const data: SubscriptionData = {
      url,
      fetchedAt: Date.now(),
      outbounds,
      userInfo: parseUserInfoHeader(res.headers.get('subscription-userinfo')),
      rawTitle: decodeTitle(res.headers.get('profile-title'))
    }

    setSubscriptionUrl(url)
    store.set('subscriptionCache', data)
    return data
  }

  /** Warm the device-info cache (WMI query takes ~1–3 s on first call). */
  prefetchDevice(): void {
    void getDeviceInfo(fallbackDeviceId).catch(() => undefined)
  }

  /** Refresh using the stored URL. Throws if no subscription configured. */
  async refreshSubscription(): Promise<SubscriptionData> {
    const url = getSubscriptionUrl()
    if (!url) throw new Error('Подписка не настроена')
    return this.fetchSubscription(url)
  }

  /** Cached subscription (may be stale / offline). */
  getCached(): SubscriptionData | null {
    const data = store.get('subscriptionCache')
    if (!data) return null
    // caches written by ≤0.2.x may still hold panel placeholders (0.0.0.0:1)
    return { ...data, outbounds: filterSubscription(data.outbounds).outbounds }
  }

  /** Start periodic background refresh every N hours. */
  startAutoRefresh(hours: number, onUpdate?: (d: SubscriptionData) => void): void {
    this.stopAutoRefresh()
    if (!getSubscriptionUrl()) return
    const ms = Math.max(1, hours) * 60 * 60 * 1000
    this.timer = setInterval(() => {
      this.refreshSubscription()
        .then((d) => onUpdate?.(d))
        .catch(() => {
          /* offline — keep cache, retry next interval */
        })
    }, ms)
  }

  stopAutoRefresh(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export const remnawave = new RemnawaveClient()
