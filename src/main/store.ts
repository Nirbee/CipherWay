import Store from 'electron-store'
import type { AppSettings, RulesConfig, SubscriptionData } from '@shared/types'

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
    subscriptionUrlEnc: null,
    deviceIdFallback: null,
    trayHintShown: false
  }
})

/** Settings merged over the defaults (stores written by older versions lack new keys). */
export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...store.get('settings') }
}
