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
 * Remembered only once shown (the window may start hidden in the tray).
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
