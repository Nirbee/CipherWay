import type { SubscriptionData } from '@shared/types'
import { store } from '../store'
import { getSubscriptionUrl, setSubscriptionUrl } from '../secrets'
import { parseOutbounds } from './parsers'

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
    const res = await fetch(url, {
      headers: {
        // request the raw link list; Remnawave honours common UAs
        'User-Agent': 'CipherWay/1.0 (clash; xray)',
        Accept: '*/*'
      },
      redirect: 'follow'
    })
    if (!res.ok) {
      throw new Error(`Подписка недоступна: ${res.status} ${res.statusText}`)
    }
    const raw = await res.text()
    const outbounds = parseOutbounds(raw)
    if (outbounds.length === 0) {
      throw new Error('В подписке не найдено ни одного профиля (VLESS/Hysteria2)')
    }

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

  /** Refresh using the stored URL. Throws if no subscription configured. */
  async refreshSubscription(): Promise<SubscriptionData> {
    const url = getSubscriptionUrl()
    if (!url) throw new Error('Подписка не настроена')
    return this.fetchSubscription(url)
  }

  /** Cached subscription (may be stale / offline). */
  getCached(): SubscriptionData | null {
    return store.get('subscriptionCache')
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
