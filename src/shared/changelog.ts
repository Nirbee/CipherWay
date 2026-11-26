// ---------------------------------------------------------------------------
// «Что нового»: what changed, per version — bundled with the app (works offline).
// Newest first. Short Russian bullets for users, not developers. After an update
// the app shows the entries newer than the last version the user has seen
// (several, if they jumped versions). Pure — unit tested in changelog.test.ts.
// ---------------------------------------------------------------------------

export interface ChangelogEntry {
  version: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.7.0',
    items: [
      '«Настройки» → «Ускорение без VPN (zapret)»: YouTube, Discord и ваши сайты могут идти напрямую, мимо VPN.',
      'zapret обходит замедление у провайдера: меньше пинг и быстрее видео. Всё остальное идёт через VPN, как раньше.',
      'Приложение само проверяет сайты напрямую каждые 10 минут и при смене сети; не открылся — сразу вернёт его в VPN.',
      'Способ обхода подбирается сам и запоминается для каждой сети; есть кнопка «Подобрать заново».',
      'Выключено по умолчанию. После обновления служба CipherWay один раз попросит права администратора.'
    ]
  },
  {
    version: '0.6.0',
    items: [
      'DevVersion — тестовый режим в самом низу «Настроек»: включается только с вашего согласия и в любой момент выключается.',
      'В DevVersion приложение собирает данные о сети и раз в час отправляет их нам — так мы точнее настроим правила.',
      'Новая вкладка «Статистика»: что собрано и когда отправлено, качество серверов, доступность сайтов напрямую и через VPN, «Тест игры».',
      'Сбор не мешает играм: пока идёт игра или звонок, тяжёлые проверки откладываются.',
      'В DevVersion интерфейс серебристый, а в заголовке окна — метка «DEV».'
    ]
  },
  {
    version: '0.5.2',
    items: [
      'Пинг как в Happ: в списке серверов — чистая задержка через VPN, без времени на установку соединения.',
      '«Настройки» → «Пинг»: «Задержка», «С подключением» (как раньше) или «До сервера (TCP)»; ожидание 5–15 с.',
      'Каждый сервер проверяется сам по себе, а не через выбранный — и при включённом VPN, и без него.',
      'Сервер с устаревшими параметрами приложение теперь переподключает само — вручную больше не нужно.',
      'В «Логах» меньше служебного шума от LAN при каждом изменении сети Windows.'
    ]
  },
  {
    version: '0.5.1',
    items: [
      'VPN в режиме TUN и LAN снова запускаются вместе — раньше после включения компьютера туннель мог не подняться.',
      'Первое подключение после включения компьютера больше не ждёт 15 секунд и не повторяется.',
      'LAN дольше ждёт, пока Windows создаст его сетевой адаптер, и не прерывает это на полпути.',
      'Карточка «Что нового» не пропадает непрочитанной: она закрывается сама, только пока окно перед вами.',
      'Список изменений всегда можно открыть: «Настройки» → «Что нового» рядом с версией.'
    ]
  },
  {
    version: '0.5.0',
    items: [
      'Новая вкладка «LAN»: своя локальная сеть с друзьями через интернет — для Minecraft и других игр.',
      'Комнаты по коду: создайте комнату, отправьте другу код — и вы видите компьютеры друг друга.',
      'Видно, кто из друзей в сети, их адреса и качество связи: напрямую или через сервер, пинг.',
      'LAN работает и с включённым VPN, и без него; включённый LAN запоминается после перезапуска.',
      'Подсказка, как открыть мир Minecraft для друга.',
      'После обновления приложение показывает, что в нём нового.'
    ]
  },
  {
    version: '0.4.6',
    items: [
      'Режим TUN снова запускается на компьютерах, где в Windows отключён IPv6.',
      'Если IPv6 выключен, туннель сам работает только через IPv4 — ничего настраивать не нужно.'
    ]
  }
]

/** «0.10.1» > «0.9.9»; a missing part counts as 0; a pre-release tag is ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((x) => {
        const n = Number.parseInt(x, 10)
        return Number.isFinite(n) ? n : 0
      })
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** Entries with lastSeen < version ≤ current, newest first. */
export function entriesBetween(
  lastSeen: string,
  current: string,
  log: ChangelogEntry[] = CHANGELOG
): ChangelogEntry[] {
  return log
    .filter(
      (e) => compareVersions(e.version, lastSeen) > 0 && compareVersions(e.version, current) <= 0
    )
    .sort((x, y) => compareVersions(y.version, x.version))
}

export interface WhatsNewDecision {
  /** what to show (empty = nothing) */
  entries: ChangelogEntry[]
  /** store this as the last seen version right away (nothing to show) */
  recordNow: boolean
}

/**
 * What to show on this start.
 *  - fresh install (nothing remembered, no data of an earlier version): nothing,
 *    just remember the version;
 *  - an update from a version that didn't remember this (≤ 0.4.6): only the
 *    current version's entry — where the user came from is unknown;
 *  - otherwise: everything newer than the last seen version.
 * Remembered only once the user closed the card (× or «Подробнее»): one that hid
 * by itself comes back on the next start.
 */
export function whatsNew(
  lastSeen: string | null,
  current: string,
  hadEarlierVersion: boolean,
  log: ChangelogEntry[] = CHANGELOG
): WhatsNewDecision {
  if (!lastSeen) {
    if (!hadEarlierVersion) return { entries: [], recordNow: true }
    const own = log.filter((e) => compareVersions(e.version, current) === 0)
    return { entries: own, recordNow: own.length === 0 }
  }
  if (compareVersions(current, lastSeen) <= 0) return { entries: [], recordNow: false }
  const entries = entriesBetween(lastSeen, current, log)
  return { entries, recordNow: entries.length === 0 }
}
