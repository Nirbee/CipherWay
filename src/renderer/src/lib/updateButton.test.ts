import { describe, expect, it } from 'vitest'
import { INITIAL_UPDATER_STATE, type UpdaterState } from '@shared/updater'
import { updateButtonView } from './updateButton'

const st = (p: Partial<UpdaterState>): UpdaterState => ({ ...INITIAL_UPDATER_STATE, ...p })

describe('updateButtonView', () => {
  it('no update: plain «Версия актуальна», click = manual check', () => {
    const v = updateButtonView(st({ phase: 'not-available' }))
    expect(v).toMatchObject({ tone: 'plain', label: 'Версия актуальна', action: 'check' })
    expect(v.pulse).toBe(false)
  })

  it('before the first check: «Проверить обновления»', () => {
    expect(updateButtonView(INITIAL_UPDATER_STATE)).toMatchObject({
      tone: 'plain',
      label: 'Проверить обновления',
      action: 'check'
    })
  })

  it('checking: disabled', () => {
    expect(updateButtonView(st({ phase: 'checking' }))).toMatchObject({
      label: 'Проверка…',
      action: null
    })
  })

  it('update found: green, pulsing, «Доступно обновление 0.4.5», click = download', () => {
    expect(updateButtonView(st({ phase: 'available', version: '0.4.5' }))).toEqual({
      tone: 'accent',
      label: 'Доступно обновление 0.4.5',
      tag: null,
      action: 'download',
      pulse: true,
      percent: 0,
      working: false
    })
  })

  it('downloading: «Загрузка 42%» with the bar, not clickable', () => {
    expect(
      updateButtonView(st({ phase: 'downloading', version: '0.4.5', percent: 42 }))
    ).toMatchObject({ tone: 'progress', label: 'Загрузка 42%', percent: 42, action: null })
  })

  it('ready: «Перезапустить и обновить», click = install', () => {
    expect(
      updateButtonView(st({ phase: 'downloaded', version: '0.4.5', percent: 100 }))
    ).toMatchObject({
      tone: 'accent',
      label: 'Перезапустить и обновить',
      tag: 'v0.4.5',
      action: 'install',
      pulse: true
    })
  })

  it('installing: no second click', () => {
    expect(updateButtonView(st({ phase: 'installing', version: '0.4.5' }))).toMatchObject({
      label: 'Перезапуск…',
      action: null
    })
  })

  it('error of a check: red «Повторить проверку»', () => {
    expect(updateButtonView(st({ phase: 'error', error: 'нет связи' }))).toMatchObject({
      tone: 'error',
      label: 'Повторить проверку',
      action: 'check'
    })
  })

  it('error of a download: still the green offer to download', () => {
    expect(
      updateButtonView(st({ phase: 'error', version: '0.4.5', error: 'обрыв' }))
    ).toMatchObject({ tone: 'accent', label: 'Доступно обновление 0.4.5', action: 'download' })
  })
})
