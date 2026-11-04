import type { SubscriptionData, SubscriptionView } from '@shared/types'
import { maskUrl } from '../mask'

/**
 * The renderer only ever gets this view: server names and protocols, never
 * addresses, ports, keys or the full subscription link.
 */
export function toSubscriptionView(
  data: SubscriptionData | null,
  subscriptionUrl: string | null
): SubscriptionView | null {
  if (!data) return null
  return {
    fetchedAt: data.fetchedAt,
    servers: data.outbounds.map((o) => ({ id: o.id, name: o.name, protocol: o.protocol })),
    userInfo: data.userInfo,
    title: data.rawTitle,
    supportUrl: data.supportUrl,
    webPageUrl: data.webPageUrl,
    announce: data.announce,
    urlMasked: subscriptionUrl ? maskUrl(subscriptionUrl) : ''
  }
}
