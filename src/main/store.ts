import Store from 'electron-store'
import {
  DEFAULT_API_BASE,
  type AppSettings,
  type RulesConfig,
  type SubscriptionData
} from '@shared/types'

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
  tunService: true
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
    supportNotifiedAt: null
  }
})

/** Settings merged over the defaults (stores written by older versions lack new keys). */
export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...store.get('settings') }
}
