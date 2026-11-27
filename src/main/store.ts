import Store from 'electron-store'
import {
  DEFAULT_API_BASE,
  DEFAULT_PING_MODE,
  DEFAULT_PING_TIMEOUT_S,
  type AppSettings,
  type RulesConfig,
  type SubscriptionData
} from '@shared/types'
import { DEFAULT_NEW_YEAR_MODE, sanitizeNewYearMode } from '@shared/seasonal'
import type { DevLastUpload, DevVersionConsent } from '@shared/devversion'
import { DEFAULT_ZAPRET, sanitizeZapretSettings, type ZapretSettings } from '@shared/zapret'

interface Schema {
  settings: AppSettings
  rules: RulesConfig
  subscriptionCache: SubscriptionData | null
  activeOutboundId: string | null
  // subscription URL is stored separately, encrypted via safeStorage (see secrets.ts)
  subscriptionUrlEnc: string | null
  /** random fallback for x-hwid when the Windows MachineGuid can't be read */
  deviceIdFallback: string | null
  /** «CipherWay работает в трее» notification already shown once */
  trayHintShown: boolean
  /** last measured latency per node id (orders «Лучший сервер (авто)») */
  latencyCache: Record<string, number | null>
  /** ISO time of the newest support reply the user has seen on «Поддержка» */
  supportReadAt: string | null
  /** ISO time of the newest support reply a Windows notification was shown for */
  supportNotifiedAt: string | null
  /** the app version a «Доступна версия …» notification was shown for */
  updateNotifiedVersion: string | null
  /** «LAN» switch (on again after a restart) */
  lanEnabled: boolean
  /** Headscale URL the bot gave last (its host stays direct in the VPN config) */
  lanLoginServer: string | null
  /** LAN host name the bot gave this computer («cw-xxxxxx»; room members see it) */
  lanHostname: string | null
  /** «Что нового»: the app version whose changes the user has seen (null = never) */
  whatsNewSeenVersion: string | null
  /** «DevVersion»: the accepted consent while the mode is on (null = off) */
  devVersion: DevVersionConsent | null
  /** «DevVersion»: the result of the last upload (shown on «Статистика») */
  devVersionLastUpload: DevLastUpload | null
  /** «Ускорение без VPN (zapret)»: off by default (0.7.0) */
  zapret: ZapretSettings
  /** zapret: the strategy that worked, per network (hashed gateway id → {id, at}) */
  zapretStrategies: Record<string, { id: string | null; at: number }>
}

export const DEFAULT_SETTINGS: AppSettings = {
  proxyMode: 'system',
  routingMode: 'rule',
  supportUrl: '',
  autoLaunch: false,
  autoConnect: false,
  language: 'ru',
  socksPort: 10808,
  httpPort: 10809,
  subscriptionRefreshHours: 12,
  verboseLog: false,
  apiBase: DEFAULT_API_BASE,
  tunService: true,
  pingMode: DEFAULT_PING_MODE,
  pingTimeoutSec: DEFAULT_PING_TIMEOUT_S,
  newYearDecor: DEFAULT_NEW_YEAR_MODE
}

export const DEFAULT_RULES: RulesConfig = {
  defaultBehavior: 'auto',
  rules: [
    {
      id: 'r1',
      enabled: true,
      conditionType: 'GeoSite',
      value: 'category-ads-all',
      action: 'REJECT'
    },
    { id: 'r2', enabled: true, conditionType: 'GeoIP', value: 'ru', action: 'DIRECT' },
    { id: 'r3', enabled: true, conditionType: 'GeoSite', value: 'yandex', action: 'DIRECT' },
    // Telegram connects to its IPs without DNS, so a domain rule misses them;
    // directly they time out in Russia (0.4.2)
    { id: 'r5', enabled: true, conditionType: 'GeoIP', value: 'telegram', action: 'PROXY' },
    { id: 'r4', enabled: true, conditionType: 'ProcessName', value: 'firefox.exe', action: 'PROXY' }
  ]
}

export const store = new Store<Schema>({
  name: 'cipherway',
  defaults: {
    settings: DEFAULT_SETTINGS,
    rules: DEFAULT_RULES,
    subscriptionCache: null,
    activeOutboundId: null,
    subscriptionUrlEnc: null,
    deviceIdFallback: null,
    trayHintShown: false,
    latencyCache: {},
    supportReadAt: null,
    supportNotifiedAt: null,
    updateNotifiedVersion: null,
    lanEnabled: false,
    lanLoginServer: null,
    lanHostname: null,
    whatsNewSeenVersion: null,
    devVersion: null,
    devVersionLastUpload: null,
    zapret: DEFAULT_ZAPRET,
    zapretStrategies: {}
  }
})

/** Settings merged over the defaults (stores written by older versions lack new keys). */
export function getSettings(): AppSettings {
  const s = { ...DEFAULT_SETTINGS, ...store.get('settings') }
  return { ...s, newYearDecor: sanitizeNewYearMode(s.newYearDecor) }
}

/** «Ускорение без VPN» settings, cleaned up (an older / edited store can't break it). */
export function getZapretSettings(): ZapretSettings {
  return sanitizeZapretSettings(store.get('zapret'))
}
