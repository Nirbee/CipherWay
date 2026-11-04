import { describe, expect, it } from 'vitest'
import { parseServerName } from './flags'

describe('parseServerName', () => {
  it('takes the country from an emoji flag and removes it from the label', () => {
    expect(parseServerName('🇳🇱 Нидерланды')).toEqual({ code: 'NL', label: 'Нидерланды' })
    expect(parseServerName('Finland 🇫🇮 | HY2')).toEqual({ code: 'FI', label: 'Finland | HY2' })
  })

  it('cascade: the exit country wins', () => {
    expect(parseServerName('🇷🇺 Россия —> 🇩🇪 Frankfurt').code).toBe('DE')
    expect(parseServerName('Россия —> Frankfurt').code).toBe('DE')
  })

  it('guesses from words (Russian and English) when there is no flag', () => {
    expect(parseServerName('Германия').code).toBe('DE')
    expect(parseServerName('Netherlands · Eygelshoven').code).toBe('NL')
    expect(parseServerName('Россия (СПб)').code).toBe('RU')
    expect(parseServerName('Сервер США').code).toBe('US')
    expect(parseServerName('Польша').code).toBe('PL')
  })

  it('no false positives inside other words', () => {
    // «спбх», «вселенная» etc. must not match the short keywords
    expect(parseServerName('Вселенная').code).toBeUndefined()
    expect(parseServerName('⚡ Автовыбор')).toEqual({ code: undefined, label: '⚡ Автовыбор' })
  })

  it('never returns an empty label', () => {
    expect(parseServerName('🇩🇪').label).toBe('🇩🇪')
    expect(parseServerName('').label).toBe('Сервер')
  })
})
