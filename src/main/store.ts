import Store from 'electron-store'
import type { AppSettings, RulesConfig, SubscriptionData } from '@shared/types'

interface Schema {
  settings: AppSettings
  rules: RulesConfig
  subscriptionCache: SubscriptionData | null
  activeOutboundId: string | null
  // subscription URL is stored separately, encrypted via safeStorage (see secrets.ts)
  subscriptionUrlEnc: string | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  proxyMode: 'system',
  autoLaunch: false,
  autoConnect: false,
  language: 'ru',
  socksPort: 10808,
  httpPort: 10809,
  subscriptionRefreshHours: 12
}

export const DEFAULT_RULES: RulesConfig = {
  defaultBehavior: 'auto',
  rules: [
    { id: 'r1', enabled: true, conditionType: 'GeoSite', value: 'category-ads-all', action: 'REJECT' },
    { id: 'r2', enabled: true, conditionType: 'GeoIP', value: 'ru', action: 'DIRECT' },
    { id: 'r3', enabled: true, conditionType: 'GeoSite', value: 'yandex', action: 'DIRECT' },
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
    subscriptionUrlEnc: null
  }
})
