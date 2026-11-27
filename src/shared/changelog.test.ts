import { describe, expect, it } from 'vitest'
import {
  CHANGELOG,
  compareVersions,
  entriesBetween,
  whatsNew,
  type ChangelogEntry
} from './changelog'

const LOG: ChangelogEntry[] = [
  { version: '0.10.0', items: ['ten'] },
  { version: '0.5.0', items: ['five'] },
  { version: '0.4.6', items: ['four-six'] },
  { version: '0.4.5', items: ['four-five'] }
]

describe('compareVersions', () => {
  it('numeric, not text; missing parts are 0; v-prefix and pre-release tags ignored', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.4.6', '0.5.0')).toBe(-1)
    expect(compareVersions('0.5', '0.5.0')).toBe(0)
    expect(compareVersions('v0.5.0', '0.5.0')).toBe(0)
    expect(compareVersions('0.5.0-beta.1', '0.5.0')).toBe(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  })
})

describe('«Что нового»', () => {
  it('fresh install: nothing shown, the version is remembered at once', () => {
    expect(whatsNew(null, '0.5.0', false, LOG)).toEqual({ entries: [], recordNow: true })
  })

  it('one version up: only that version', () => {
    expect(whatsNew('0.4.6', '0.5.0', true, LOG).entries.map((e) => e.version)).toEqual(['0.5.0'])
  })

  it('several versions jumped: all newer than the last seen, newest first', () => {
    const r = whatsNew('0.4.5', '0.10.0', true, LOG)
    expect(r.entries.map((e) => e.version)).toEqual(['0.10.0', '0.5.0', '0.4.6'])
    expect(r.recordNow).toBe(false)
    expect(entriesBetween('0.4.5', '0.5.0', LOG).map((e) => e.version)).toEqual(['0.5.0', '0.4.6'])
  })

  it('an update from a version that did not remember it: only the current entry', () => {
    expect(whatsNew(null, '0.5.0', true, LOG).entries.map((e) => e.version)).toEqual(['0.5.0'])
  })

  it('same version, a downgrade, or no entry for the new version: nothing to show', () => {
    expect(whatsNew('0.5.0', '0.5.0', true, LOG).entries).toEqual([])
    expect(whatsNew('0.10.0', '0.5.0', true, LOG)).toEqual({ entries: [], recordNow: false })
    expect(whatsNew('0.5.0', '0.5.1', true, LOG)).toEqual({ entries: [], recordNow: true })
  })

  it('the bundled changelog: newest first, 0.7.2 … 0.5.2 filled, short Russian bullets', () => {
    const versions = CHANGELOG.map((e) => e.version)
    expect(versions.slice(0, 5)).toEqual(['0.7.3', '0.7.2', '0.7.1', '0.7.0', '0.6.0'])
    for (let i = 1; i < versions.length; i++) {
      expect(compareVersions(versions[i - 1], versions[i])).toBe(1)
    }
    for (const e of CHANGELOG) {
      expect(e.items.length).toBeGreaterThan(0)
      for (const item of e.items) {
        expect(item).toMatch(/[а-яё]/i)
        expect(item.length).toBeLessThan(140)
      }
    }
  })
})

describe('the changelog matches the app', () => {
  it('there is an entry for the version in package.json', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'))
    expect(CHANGELOG.some((e) => compareVersions(e.version, pkg.version) === 0)).toBe(true)
  })
})
