import { useSubscription } from '../store/subscriptionStore'
import { useSettings } from '../store/settingsStore'
import { toast } from '../store/toastStore'
import { errorText } from '../lib/format'

/**
 * «Поддержка»: the subscription's `support-url` header, otherwise the link
 * from Настройки → Поддержка. «Продлить»: `profile-web-page-url`.
 */
export function useLinks(): { supportUrl?: string; renewUrl?: string } {
  const sub = useSubscription((s) => s.data)
  const fallback = useSettings((s) => s.settings?.supportUrl)
  return {
    supportUrl: sub?.supportUrl || fallback || undefined,
    renewUrl: sub?.webPageUrl || undefined
  }
}

export function openLink(url: string | undefined): void {
  if (!url) return
  window.api.app.openExternal(url).catch((e) => toast(`Не удалось открыть ссылку: ${errorText(e)}`, 'error'))
}
