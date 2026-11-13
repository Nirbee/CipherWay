import type { UpdaterState } from '@shared/updater'

/** How the update button looks and what a click does — pure, see updateButton.test.ts. */
export interface UpdateButtonView {
  /** plain — quiet sidebar row; accent — green, noticeable; progress — download bar */
  tone: 'plain' | 'accent' | 'progress' | 'error'
  label: string
  /** small version tag on the right */
  tag: string | null
  action: 'check' | 'download' | 'install' | null
  /** the badge dot pulses: something new for the user */
  pulse: boolean
  /** progress bar width (tone 'progress') */
  percent: number
  /** spinning / pulsing icon */
  working: boolean
}

export function updateButtonView(s: UpdaterState): UpdateButtonView {
  const tag = s.version ? `v${s.version}` : null
  const base = { tag: null, pulse: false, percent: 0, working: false }
  switch (s.phase) {
    case 'checking':
      return { ...base, tone: 'plain', label: 'Проверка…', action: null, working: true }
    case 'not-available':
      return { ...base, tone: 'plain', label: 'Версия актуальна', action: 'check' }
    case 'available':
      return {
        ...base,
        tone: 'accent',
        label: `Доступно обновление${s.version ? ` ${s.version}` : ''}`,
        action: 'download',
        pulse: true
      }
    case 'downloading':
      return {
        ...base,
        tone: 'progress',
        label: `Загрузка ${s.percent}%`,
        tag,
        action: null,
        percent: s.percent,
        working: true
      }
    case 'downloaded':
      return {
        ...base,
        tone: 'accent',
        label: 'Перезапустить и обновить',
        tag,
        action: 'install',
        pulse: true
      }
    case 'installing':
      return { ...base, tone: 'accent', label: 'Перезапуск…', tag, action: null, working: true }
    case 'error':
      // the toast already told what failed; the button offers the next step
      return s.version
        ? {
            ...base,
            tone: 'accent',
            label: `Доступно обновление ${s.version}`,
            action: 'download',
            pulse: true
          }
        : { ...base, tone: 'error', label: 'Повторить проверку', action: 'check' }
    case 'idle':
    default:
      return { ...base, tone: 'plain', label: 'Проверить обновления', action: 'check' }
  }
}
