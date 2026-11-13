// ---------------------------------------------------------------------------
// App update state. Owned by main (src/main/updater/AppUpdater.ts), pushed to
// the renderer as a whole on every change (IPC.evtUpdater), read once on start
// (IPC.updaterGetState). The sidebar button, «Настройки → Обновления» and the
// tray menu all draw from this one state.
// ---------------------------------------------------------------------------

export type UpdaterPhase =
  /** nothing checked yet */
  | 'idle'
  /** a check the user asked for is running (background checks stay invisible) */
  | 'checking'
  | 'not-available'
  /** a newer version exists, not downloaded (yet) */
  | 'available'
  | 'downloading'
  /** the installer is on disk: «Перезапустить и обновить» */
  | 'downloaded'
  /** «Перезапустить и обновить» pressed: the cores are being stopped */
  | 'installing'
  /** a check / download / install the user asked for failed */
  | 'error'

export interface UpdaterState {
  phase: UpdaterPhase
  /** the new version, when one is known */
  version: string | null
  /** download progress 0..100 */
  percent: number
  /** short reason of the last failed user action (phase 'error') */
  error: string | null
  /** +1 on every failed user action — the renderer shows one toast per step */
  errorSeq: number
  /** time of the last finished check (ms), null — none yet */
  checkedAt: number | null
}

export const INITIAL_UPDATER_STATE: UpdaterState = {
  phase: 'idle',
  version: null,
  percent: 0,
  error: null,
  errorSeq: 0,
  checkedAt: null
}

export type UpdaterAction =
  | { type: 'check-start'; manual: boolean }
  | { type: 'available'; version: string; at: number }
  | { type: 'not-available'; at: number }
  | { type: 'download-start' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'install-start' }
  /** manual = the user is waiting for the result; background failures stay silent */
  | { type: 'failed'; manual: boolean; message: string }

const busy = (p: UpdaterPhase): boolean =>
  p === 'downloading' || p === 'downloaded' || p === 'installing'

/** Pure state transition; returns the same object when nothing changes. */
export function reduceUpdater(s: UpdaterState, a: UpdaterAction): UpdaterState {
  switch (a.type) {
    case 'check-start':
      // background checks don't touch the button; nothing to check mid-download
      if (!a.manual || busy(s.phase)) return s
      return { ...s, phase: 'checking', error: null }
    case 'available':
      if (busy(s.phase) && s.version === a.version) return { ...s, checkedAt: a.at }
      if (s.phase === 'installing') return s
      return { ...s, phase: 'available', version: a.version, error: null, checkedAt: a.at }
    case 'not-available':
      if (busy(s.phase)) return { ...s, checkedAt: a.at }
      return { ...s, phase: 'not-available', version: null, error: null, checkedAt: a.at }
    case 'download-start':
      if (s.phase === 'downloaded' || s.phase === 'installing') return s
      return { ...s, phase: 'downloading', percent: s.phase === 'downloading' ? s.percent : 0 }
    case 'progress': {
      if (s.phase === 'downloaded' || s.phase === 'installing') return s
      const percent = Math.max(0, Math.min(100, Math.round(a.percent || 0)))
      if (s.phase === 'downloading' && s.percent === percent) return s
      return { ...s, phase: 'downloading', percent, error: null }
    }
    case 'downloaded':
      return { ...s, phase: 'downloaded', version: a.version, percent: 100, error: null }
    case 'install-start':
      if (s.phase !== 'downloaded') return s
      return { ...s, phase: 'installing' }
    case 'failed': {
      if (a.manual) {
        // the installer is still on disk: one more press can work
        const errorSeq = s.errorSeq + 1
        if (s.phase === 'installing') {
          return { ...s, phase: 'downloaded', error: a.message, errorSeq }
        }
        return { ...s, phase: 'error', error: a.message, errorSeq }
      }
      // background: never an error on screen, only fall back to what we know
      if (s.phase === 'downloading') return { ...s, phase: 'available', percent: 0 }
      if (s.phase === 'installing') return { ...s, phase: 'downloaded' }
      return s
    }
    default:
      return s
  }
}

/** The update entry of the tray menu, null — none. */
export function trayUpdateItem(
  s: UpdaterState
): { label: string; action: 'open' | 'install' | null } | null {
  const v = s.version ? ` ${s.version}` : ''
  switch (s.phase) {
    case 'available':
      return { label: `Доступно обновление${v}`, action: 'open' }
    case 'error':
      return s.version ? { label: `Доступно обновление${v}`, action: 'open' } : null
    case 'downloading':
      return { label: `Загрузка обновления${v}…`, action: null }
    case 'downloaded':
      return { label: `Перезапустить и обновить до${v}`, action: 'install' }
    case 'installing':
      return { label: 'Установка обновления…', action: null }
    default:
      return null
  }
}
