// Test fixtures: a made-up mixed Remnawave subscription (2 VLESS REALITY + 1
// Hysteria2). Hosts are *.example.com, UUIDs/keys are random — nothing real.
import type { AppSettings, RulesConfig } from '@shared/types'

export const VLESS_A =
  'vless://11111111-2222-4333-8444-555555555555@nl.example.com:443' +
  '?security=reality&encryption=none&flow=xtls-rprx-vision&type=tcp' +
  '&pbk=4hqL4-CvFAFMKy-sTIDBSJ5O19YzUFGMfGJYw8GWKCU&sid=ab12cd34' +
  '&sni=www.example.org&fp=firefox&spx=%2F#%F0%9F%87%B3%F0%9F%87%B1%20Netherlands'

export const VLESS_B =
  'vless://66666666-7777-4888-9999-000000000000@203.0.113.10:8443' +
  '?security=reality&encryption=none&flow=xtls-rprx-vision&type=tcp' +
  '&pbk=bjL2u-PMsORhTJrpnjfmUqNY1ncz9m1vcQBeI-JbBjk&sid=0f' +
  '&sni=cdn.example.net&fp=qq#Germany'

export const HY2 =
  'hysteria2://s3cr3t-pass@hy.example.com:8443?sni=hy.example.com&obfs=salamander' +
  '&obfs-password=obfs-pass#Finland%20HY2'

/** what the panel returns for a non-clash UA: base64(XRAY links) */
export const MIXED_SUB_BODY = Buffer.from([VLESS_A, VLESS_B, HY2].join('\n')).toString('base64')

export const TEST_SETTINGS: AppSettings = {
  proxyMode: 'system',
  autoLaunch: false,
  autoConnect: false,
  language: 'ru',
  socksPort: 10808,
  httpPort: 10809,
  subscriptionRefreshHours: 12
}

export const TEST_RULES: RulesConfig = {
  defaultBehavior: 'auto',
  rules: [
    {
      id: 'r1',
      enabled: true,
      conditionType: 'GeoSite',
      value: 'category-ads-all',
      action: 'REJECT'
    },
    {
      id: 'r2',
      enabled: true,
      conditionType: 'ProcessName',
      value: 'telegram.exe',
      action: 'PROXY'
    }
  ]
}
