import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../../../../tailwind.config'
import { applyEdition, DEV_EDITION, EDITION_ATTR } from './edition'

const ROOT = join(__dirname, '..', '..', '..', '..')
const css = readFileSync(join(ROOT, 'src/renderer/src/styles/index.css'), 'utf8')

const ACCENT_VARS = [
  'accent-blue',
  'accent-blue-light',
  'accent-blue-bright',
  'accent-blue-dark',
  'accent-blue-deep',
  'accent-green',
  'on-accent'
]

describe('DevVersion theme', () => {
  it('one attribute on the root switches the edition', () => {
    const attrs = new Map<string, string>()
    const el = {
      setAttribute: (n: string, v: string) => void attrs.set(n, v),
      removeAttribute: (n: string) => void attrs.delete(n)
    }
    applyEdition(el, true)
    expect(attrs.get(EDITION_ATTR)).toBe(DEV_EDITION)
    applyEdition(el, false)
    expect(attrs.has(EDITION_ATTR)).toBe(false)
  })

  it('the accent tokens are CSS variables (with alpha), not fixed colours', () => {
    const colors = (config.theme?.extend?.colors ?? {}) as Record<
      string,
      Record<string, string> | string
    >
    const accent = colors.accent as Record<string, string>
    for (const k of ['blue', 'blue-light', 'blue-bright', 'blue-dark', 'blue-deep', 'green']) {
      expect(accent[k]).toBe(`rgb(var(--c-accent-${k}) / <alpha-value>)`)
    }
    expect(colors['on-accent']).toBe('rgb(var(--c-on-accent) / <alpha-value>)')
    expect(String(colors['border-default'])).toContain('var(--c-accent-green)')
    expect((colors.status as Record<string, string>).ok).toBe(
      'rgb(var(--c-status-ok) / <alpha-value>)'
    )
  })

  it('index.css defines every accent variable and overrides each one for data-edition="dev"', () => {
    const block = (sel: string): string => {
      const i = css.indexOf(sel)
      expect(i).toBeGreaterThanOrEqual(0)
      return css.slice(i, css.indexOf('}', i))
    }
    const root = block(':root {')
    const dev = block("[data-edition='dev'] {")
    for (const v of ACCENT_VARS) {
      expect(root).toMatch(new RegExp(`--c-${v}:\\s*\\d+ \\d+ \\d+;`))
      expect(dev).toMatch(new RegExp(`--c-${v}:\\s*\\d+ \\d+ \\d+;`))
    }
    // silver accent → dark text on it (readable), status colours untouched
    expect(dev).toMatch(/--c-on-accent:\s*17 24 39;/)
    expect(dev).not.toMatch(/amber|red/)
    // the status green is its own token: defined once, never overridden by DevVersion
    expect(root).toMatch(/--c-status-ok:\s*52 211 153;/)
    expect(css).not.toMatch(/\[data-edition='dev'\][^}]*--c-status-ok/)
  })

  it('«Защищено» / connected / online use the status token, not the accent', () => {
    const read = (f: string): string => readFileSync(join(ROOT, 'src/renderer/src', f), 'utf8')
    expect(read('components/Sidebar.tsx')).toMatch(/connected'\s*\?\s*'bg-status-ok'/)
    expect(read('components/Sidebar.tsx')).toMatch(/connected'\s*\?\s*'text-status-ok'/)
    expect(read('pages/HomePage.tsx')).toMatch(/connected \? 'text-status-ok'/)
    expect(read('pages/LanPage.tsx')).toMatch(/online \? 'bg-status-ok/)
  })
})
