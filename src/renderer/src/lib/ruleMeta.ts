import type { RuleConditionType } from '@shared/types'

interface CondMeta {
  label: string
  placeholder: string
  tone: 'blue' | 'green' | 'amber' | 'neutral'
  mono?: boolean
}

export const CONDITION_META: Record<RuleConditionType, CondMeta> = {
  ProcessName: { label: 'ProcessName', placeholder: 'firefox.exe', tone: 'blue', mono: true },
  ProcessPath: {
    label: 'ProcessPath',
    placeholder: 'C:\\Users\\...\\Cursor.exe',
    tone: 'blue',
    mono: true
  },
  Domain: { label: 'Domain', placeholder: 'example.com', tone: 'green' },
  DomainSuffix: { label: 'DomainSuffix', placeholder: 'google.com', tone: 'green' },
  DomainKeyword: { label: 'DomainKeyword', placeholder: 'google', tone: 'green' },
  GeoSite: { label: 'GeoSite', placeholder: 'yandex', tone: 'amber', mono: true },
  GeoIP: { label: 'GeoIP', placeholder: 'ru', tone: 'amber', mono: true },
  IPCIDR: { label: 'IPCIDR', placeholder: '10.0.0.0/8', tone: 'neutral', mono: true }
}

export const CONDITION_TYPES = Object.keys(CONDITION_META) as RuleConditionType[]

// A practical subset of geosite categories shipped with the v2fly/loyalsoldier
// datasets, for autocomplete. Not exhaustive — users can type any value.
export const GEOSITE_CATEGORIES = [
  'category-ads-all',
  'category-ads',
  'google',
  'youtube',
  'telegram',
  'twitter',
  'facebook',
  'instagram',
  'netflix',
  'spotify',
  'github',
  'openai',
  'cloudflare',
  'microsoft',
  'apple',
  'yandex',
  'vk',
  'mailru',
  'sberbank',
  'category-ru',
  'category-gov-ru',
  'private'
]

// ISO country codes commonly used with geoip:<cc>.
export const GEOIP_CATEGORIES = [
  'ru',
  'cn',
  'us',
  'ir',
  'by',
  'ua',
  'kz',
  'de',
  'nl',
  'private',
  'telegram'
]

export function actionTone(action: string): 'blue' | 'green' | 'red' | 'neutral' {
  if (action === 'DIRECT') return 'green'
  if (action === 'REJECT' || action === 'BLOCK') return 'red'
  if (action === 'PROXY') return 'blue'
  return 'blue' // named outbound profile
}

export function actionLabel(action: string): string {
  return action
}
