// ---------------------------------------------------------------------------
// «DevVersion» (0.6.0) — the opt-in test mode with full diagnostics collection.
// Shared by main (collector, upload) and renderer (Settings, «Статистика»).
// Design and the contract with the bot: .claude/plans/devversion.md (local).
// ---------------------------------------------------------------------------

/** consent_version of the text below — bump it together with the text */
export const DEV_CONSENT_VERSION = '1'

export const DEV_CONSENT_TITLE = 'DevVersion — тестовая версия CipherWay'

/** The consent text, word for word from the plan (consent_version = 1). */
export const DEV_CONSENT: { intro: string; items: string[]; after: string[] } = {
  intro:
    'Включая DevVersion, вы соглашаетесь помогать нам улучшать CipherWay и разрешаете приложению собирать и отправлять на серверы CipherWay технические данные о работе сети и приложений на этом компьютере, в том числе:',
  items: [
    'какие программы, игры и браузеры выходят в сеть, к каким доменам и адресам они подключаются (без содержимого трафика), объём трафика и способ соединения (напрямую или через VPN);',
    'доступность сайтов, сервисов и игровых серверов напрямую и через VPN, результаты проверок протоколов, задержки, потери пакетов, обрывы и ошибки соединений;',
    'сведения о вашем интернет-провайдере и регионе, определяемые по IP-адресу (сам IP-адрес не сохраняется);',
    'версию приложения и Windows, сетевые настройки, журналы работы приложения и ядра VPN;',
    'результаты работы тестовых функций.'
  ],
  after: [
    'Данные используются для настройки правил маршрутизации, поиска блокировок, улучшения качества соединения и разработки новых функций CipherWay. Для анализа данных CipherWay может использовать собственные инструменты, в том числе ИИ-ассистентов. Данные хранятся на серверах CipherWay не дольше 90 дней, не продаются и не передаются третьим лицам для их собственных целей.',
    'В DevVersion могут включаться экспериментальные функции, которые работают нестабильно.',
    'Выключить DevVersion можно в любой момент в «Настройках». Сбор сразу прекращается, данные на компьютере удаляются. Удалить уже отправленные данные можно кнопкой в «Настройках» или через поддержку.'
  ]
}

export const DEV_CONSENT_CHECKBOX = 'Я прочитал(а) и согласен(на)'

/** What the consent dialog sends to main; main refuses anything else. */
export interface DevConsentAccept {
  accepted: true
  consentVersion: string
}

/** «Включить» is available only with the box ticked (and the text shown is current). */
export function canEnableDev(
  checked: boolean,
  shownVersion: string = DEV_CONSENT_VERSION
): boolean {
  return checked === true && shownVersion === DEV_CONSENT_VERSION
}

/** Stored (electron-store `devVersion`) while the mode is on. */
export interface DevVersionConsent {
  enabled: true
  consent_version: string
  /** ISO 8601 */
  accepted_at: string
  /** uuid v4, new on every enable */
  install_id: string
}

export interface DevLastUpload {
  at: number
  ok: boolean
  text: string
}

/** Cheap status (no summaries): Settings, the sidebar, the page header. */
export interface DevStatus {
  enabled: boolean
  acceptedAt: string | null
  /** the collector runs (enabled + started) */
  collecting: boolean
  vpnRunning: boolean
  /** why nothing is sent now (Russian text), null = sending normally */
  paused: string | null
  /** uploads wait: in TUN the core does not route the bot's host directly yet */
  waitingDirect: boolean
  lastUpload: DevLastUpload | null
  nextUploadAt: number | null
  queue: { reports: number; bytes: number }
  /** start of the period being collected now */
  since: number | null
  accumulated: {
    processes: number
    connections: number
    bytes: number
    events: number
    probes: number
  }
  /** game / call traffic seen → heavy probes wait */
  game: { active: boolean; process: string | null }
  heavy: { running: boolean; deferred: boolean; lastAt: number | null; nextAt: number | null }
}

export interface DevAppRow {
  process: string
  bytes: number
  directBytes: number
  vpnBytes: number
  conns: number
  noReply: number
  topDomains: string[]
}

export interface DevNodeRow {
  node: string
  samples: number
  p50: number | null
  p95: number | null
  jitter: number | null
  lossPct: number | null
  tcpDirectMs: number | null
}

export interface DevTunnelRow {
  node: string | null
  samples: number
  p50: number | null
  p95: number | null
  jitter: number | null
  lossPct: number | null
  /** keepalive rounds over 2 s */
  stalls: number
  drops: number
}

export interface DevEventRow {
  at: number
  kind: string
  outbound: string
  target: string
  count: number
}

export interface DevProbeRow {
  target: string
  direct: string
  vpn: string
  dns: string | null
}

export interface DevGameTestView {
  process: string
  phase: 'recording' | 'probing' | 'done' | 'failed'
  startedAt: number
  endsAt: number
  flows: number
  text: string
}

export interface DevStatsView {
  status: DevStatus
  apps: DevAppRow[]
  nodes: DevNodeRow[]
  tunnel: DevTunnelRow | null
  events: DevEventRow[]
  probes: DevProbeRow[]
  gameTest: DevGameTestView | null
}

export interface DevDisableResult {
  status: DevStatus
  /** reports deleted on the server (when asked) */
  deleted?: number
  /** the server deletion failed: Russian text */
  deleteError?: string
}

export interface DevGameCandidate {
  name: string
  /** seen in the connections of this period */
  seen: boolean
}

export const DEV_STATUS_OFF: DevStatus = {
  enabled: false,
  acceptedAt: null,
  collecting: false,
  vpnRunning: false,
  paused: null,
  waitingDirect: false,
  lastUpload: null,
  nextUploadAt: null,
  queue: { reports: 0, bytes: 0 },
  since: null,
  accumulated: { processes: 0, connections: 0, bytes: 0, events: 0, probes: 0 },
  game: { active: false, process: null },
  heavy: { running: false, deferred: false, lastAt: null, nextAt: null }
}
