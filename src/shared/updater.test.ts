import { describe, expect, it } from 'vitest'
import {
  INITIAL_UPDATER_STATE,
  reduceUpdater,
  trayUpdateItem,
  type UpdaterAction,
  type UpdaterState
} from './updater'

const run = (actions: UpdaterAction[], from: UpdaterState = INITIAL_UPDATER_STATE) =>
  actions.reduce(reduceUpdater, from)

describe('reduceUpdater', () => {
  it('background check start leaves the button alone', () => {
    const s = run([{ type: 'not-available', at: 1 }])
    expect(reduceUpdater(s, { type: 'check-start', manual: false })).toBe(s)
  })

  it('manual check shows «Проверка…»', () => {
    expect(run([{ type: 'check-start', manual: true }]).phase).toBe('checking')
  })

  it('available → downloading → downloaded', () => {
    const s = run([
      { type: 'available', version: '0.4.5', at: 1 },
      { type: 'download-start' },
      { type: 'progress', percent: 41.6 }
    ])
    expect(s).toMatchObject({ phase: 'downloading', percent: 42, version: '0.4.5' })
    const d = reduceUpdater(s, { type: 'downloaded', version: '0.4.5' })
    expect(d).toMatchObject({ phase: 'downloaded', percent: 100 })
  })

  it('progress is clamped', () => {
    expect(run([{ type: 'progress', percent: 140 }]).percent).toBe(100)
    expect(run([{ type: 'progress', percent: -3 }]).percent).toBe(0)
  })

  it('a later check does not undo a downloaded update', () => {
    const s = run([
      { type: 'available', version: '0.4.5', at: 1 },
      { type: 'downloaded', version: '0.4.5' },
      { type: 'not-available', at: 2 },
      { type: 'available', version: '0.4.5', at: 3 },
      { type: 'check-start', manual: true }
    ])
    expect(s).toMatchObject({ phase: 'downloaded', version: '0.4.5', checkedAt: 3 })
  })

  it('background failure: silent, a broken download falls back to «available»', () => {
    const before = run([{ type: 'not-available', at: 1 }])
    expect(reduceUpdater(before, { type: 'failed', manual: false, message: 'x' })).toBe(before)
    const dl = run([{ type: 'available', version: '0.4.5', at: 1 }, { type: 'download-start' }])
    const s = reduceUpdater(dl, { type: 'failed', manual: false, message: 'x' })
    expect(s).toMatchObject({ phase: 'available', errorSeq: 0, error: null })
  })

  it('manual failure: phase error, errorSeq counts every failure', () => {
    const s = run([
      { type: 'check-start', manual: true },
      { type: 'failed', manual: true, message: 'Нет связи' },
      { type: 'check-start', manual: true },
      { type: 'failed', manual: true, message: 'Нет связи' }
    ])
    expect(s).toMatchObject({ phase: 'error', error: 'Нет связи', errorSeq: 2 })
  })

  it('install only from downloaded; a failed install returns there', () => {
    expect(run([{ type: 'install-start' }]).phase).toBe('idle')
    const s = run([
      { type: 'downloaded', version: '0.4.5' },
      { type: 'install-start' },
      { type: 'failed', manual: true, message: 'Не удалось запустить установку' }
    ])
    expect(s).toMatchObject({ phase: 'downloaded', errorSeq: 1 })
  })
})

describe('trayUpdateItem', () => {
  it('nothing for «актуальна» / idle', () => {
    expect(trayUpdateItem(INITIAL_UPDATER_STATE)).toBeNull()
    expect(trayUpdateItem(run([{ type: 'not-available', at: 1 }]))).toBeNull()
  })

  it('available / downloading / downloaded', () => {
    const a = run([{ type: 'available', version: '0.4.5', at: 1 }])
    expect(trayUpdateItem(a)).toEqual({ label: 'Доступно обновление 0.4.5', action: 'open' })
    expect(trayUpdateItem(reduceUpdater(a, { type: 'download-start' }))?.action).toBeNull()
    const d = reduceUpdater(a, { type: 'downloaded', version: '0.4.5' })
    expect(trayUpdateItem(d)).toEqual({
      label: 'Перезапустить и обновить до 0.4.5',
      action: 'install'
    })
  })
})
