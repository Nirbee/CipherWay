import type { DefaultBehavior, RuleConditionType } from '@shared/types'

interface CondMeta {
  label: string
  /** Clash type, shown as a hint for people coming from Koala / Clash */
  clash: string
  placeholder: string
  tone: 'blue' | 'green' | 'amber' | 'neutral'
  mono?: boolean
  hint?: string
}

export const CONDITION_META: Record<RuleConditionType, CondMeta> = {
  ProcessName: {
    label: 'Программа',
    clash: 'PROCESS-NAME',
    placeholder: 'Telegram.exe',
    tone: 'blue',
    mono: true
  },
  ProcessPath: {
    label: 'Путь к программе',
    clash: 'PROCESS-PATH',
    placeholder: 'C:\\Games\\game.exe',
    tone: 'blue',
    mono: true
  },
  Domain: { label: 'Домен', clash: 'DOMAIN', placeholder: 'api.example.com', tone: 'green' },
  DomainSuffix: {
    label: 'Домен и поддомены',
    clash: 'DOMAIN-SUFFIX',
    placeholder: 'youtube.com',
    tone: 'green'
  },
  DomainKeyword: {
    label: 'Слово в домене',
    clash: 'DOMAIN-KEYWORD',
    placeholder: 'google',
    tone: 'green'
  },
  DomainRegex: {
    label: 'Шаблон домена',
    clash: 'DOMAIN-REGEX',
    placeholder: '^(.+\\.)?ads\\.',
    tone: 'green',
    mono: true,
    hint: 'Регулярное выражение'
  },
  GeoSite: { label: 'Набор сайтов', clash: 'GEOSITE', placeholder: 'youtube', tone: 'amber', mono: true },
  GeoIP: { label: 'Страна по IP', clash: 'GEOIP', placeholder: 'ru', tone: 'amber', mono: true },
  IPCIDR: {
    label: 'IP-подсеть',
    clash: 'IP-CIDR',
    placeholder: '10.0.0.0/8',
    tone: 'neutral',
    mono: true
  },
  DstPort: {
    label: 'Порт',
    clash: 'DST-PORT',
    placeholder: '443 или 6881-6889',
    tone: 'neutral',
    mono: true
  }
}

export const CONDITION_TYPES = Object.keys(CONDITION_META) as RuleConditionType[]

// A practical subset of sing-geosite categories for autocomplete.
export const GEOSITE_CATEGORIES = [
  'category-ads-all',
  'google',
  'youtube',
  'telegram',
  'discord',
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
  'steam',
  'yandex',
  'vk',
  'mailru',
  'category-ru',
  'category-gov-ru',
  'private'
]

// ISO country codes commonly used with geoip:<cc>.
export const GEOIP_CATEGORIES = ['ru', 'private', 'by', 'kz', 'ua', 'cn', 'us', 'de', 'nl', 'fi']

export type ActionTone = 'blue' | 'green' | 'red' | 'neutral'

export function actionTone(action: string): ActionTone {
  if (action === 'DIRECT') return 'green'
  if (action === 'REJECT' || action === 'BLOCK') return 'red'
  return 'blue'
}

export function actionLabel(action: string): string {
  if (action === 'PROXY') return 'Через VPN'
  if (action === 'DIRECT') return 'Напрямую'
  if (action === 'REJECT' || action === 'BLOCK') return 'Блокировать'
  return `VPN · ${action}`
}

export const DEFAULT_BEHAVIOR_LABEL: Record<DefaultBehavior, string> = {
  proxy: 'Через VPN',
  direct: 'Напрямую',
  auto: 'Авто: Россия напрямую'
}
