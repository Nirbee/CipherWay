import type { OutboundConfig } from '@shared/types'

// ---------------------------------------------------------------------------
// Recognises Remnawave answers that are not a real server list:
//  - HWID response headers (panel v2.7.5+): x-hwid-max-devices-reached,
//    x-hwid-limit, x-hwid-not-supported
//  - placeholder "servers" (0.0.0.0:1 etc.) whose name carries the reason,
//    e.g. «Вы достигли лимита устройств!» or «App not supported»
// Pure functions — unit tested in subscriptionGuard.test.ts.
// ---------------------------------------------------------------------------

export const MSG_DEVICE_LIMIT =
  'Достигнут лимит устройств для этой подписки. Удалите старое устройство в боте CipherWay и обновите подписку.'
export const MSG_HWID_NOT_SUPPORTED =
  'Сервер подписки не принял идентификатор этого компьютера. Обновите приложение или напишите в поддержку.'
export const MSG_STUB_PREFIX = 'Сервер подписки вернул заглушку вместо списка серверов'
export const MSG_NOT_FOUND =
  'Подписка не найдена (404). Проверьте ссылку — скопируйте её заново в боте CipherWay.'

type HeaderGetter = (name: string) => string | null

const isTrue = (v: string | null): boolean => (v ?? '').trim().toLowerCase() === 'true'

/** Error text implied by the panel's HWID response headers, or null. */
export function hwidHeaderError(get: HeaderGetter): string | null {
  if (isTrue(get('x-hwid-max-devices-reached')) || isTrue(get('x-hwid-limit'))) {
    return MSG_DEVICE_LIMIT
  }
  if (isTrue(get('x-hwid-not-supported'))) return MSG_HWID_NOT_SUPPORTED
  return null
}

/** Human-readable error for a non-2xx subscription response. */
export function httpStatusError(status: number, statusText: string): string {
  if (status === 404) return MSG_NOT_FOUND
  return `Подписка недоступна: ${status} ${statusText}`.trim()
}

const PLACEHOLDER_HOSTS = new Set(['0.0.0.0', '::', '[::]', '127.0.0.1', 'localhost', ''])

/** A fake "server" the panel uses to show a message instead of a node. */
export function isPlaceholderOutbound(o: OutboundConfig): boolean {
  const host = o.server.trim().toLowerCase()
  return PLACEHOLDER_HOSTS.has(host) || host.startsWith('127.') || o.port <= 1
}

/**
 * «⚡ Автовыбор»: for Happ the panel builds an Xray JSON with a balancer under
 * this name; the plain link list we get has one ordinary address there. Showing
 * it next to our own «Лучший сервер (авто)» only misleads — hidden from the list
 * and from the urltest group (found by the name, case and emoji don't matter).
 */
export function isAutoSelectPseudo(o: Pick<OutboundConfig, 'name'>): boolean {
  return o.name.toLowerCase().includes('автовыбор')
}

const LIMIT_RE = /лимит|limit|устройств|devices?/i
const UNSUPPORTED_RE = /not supported|unsupported|не поддерж/i

export interface GuardResult {
  outbounds: OutboundConfig[]
  /** set when nothing usable is left; human-readable, Russian */
  error?: string
}

/** Drops placeholder entries; explains the problem if nothing real remains. */
export function filterSubscription(outbounds: OutboundConfig[]): GuardResult {
  const real = outbounds.filter((o) => !isPlaceholderOutbound(o))
  if (real.length > 0) {
    const visible = real.filter((o) => !isAutoSelectPseudo(o))
    // a subscription of nothing else: better a working entry than none at all
    return { outbounds: visible.length > 0 ? visible : real }
  }

  const stubs = outbounds.filter(isPlaceholderOutbound)
  if (stubs.length === 0) {
    return { outbounds: [], error: 'В подписке не найдено ни одного сервера (VLESS/Hysteria2)' }
  }
  const names = stubs.map((s) => s.name).join(' · ')
  if (UNSUPPORTED_RE.test(names)) return { outbounds: [], error: MSG_HWID_NOT_SUPPORTED }
  if (LIMIT_RE.test(names)) return { outbounds: [], error: MSG_DEVICE_LIMIT }
  return { outbounds: [], error: `${MSG_STUB_PREFIX}: «${names.slice(0, 200)}»` }
}
