import type { Config } from 'tailwindcss'

/**
 * Accent colours come from CSS variables (src/renderer/src/styles/index.css):
 * «DevVersion» swaps them for graphite / silver with one attribute on <html>
 * (data-edition="dev") instead of touching every component. `<alpha-value>`
 * keeps `bg-accent-green/10` and friends working.
 */
const v = (name: string): string => `rgb(var(--c-${name}) / <alpha-value>)`

export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          app: '#0a0f1c',
          panel: '#0c1322',
          'panel-alt': '#0d1526',
          sidebar: '#101a2e',
          elevated: '#1c2740',
          input: '#1a2540'
        },
        accent: {
          blue: v('accent-blue'),
          'blue-light': v('accent-blue-light'),
          'blue-bright': v('accent-blue-bright'),
          'blue-dark': v('accent-blue-dark'),
          'blue-deep': v('accent-blue-deep'),
          green: v('accent-green'),
          amber: '#f5b942',
          red: '#f56565'
        },
        /** status «ok / connected / online» — stays green in DevVersion too */
        status: {
          ok: v('status-ok')
        },
        text: {
          primary: '#eef2fa',
          secondary: '#dbe3f2',
          tertiary: '#cdd6e8',
          muted: '#8593ad',
          disabled: '#6b7790',
          faint: '#5b6880'
        },
        // NOTE: flat keys so `border-border-default` / `border-border-subtle`
        // (used across the app) resolve correctly. A nested { DEFAULT } would
        // only produce `border-border`, leaving `-default` to fall back to
        // Tailwind's near-white preflight color.
        'border-default': 'rgb(var(--c-accent-green) / 0.22)',
        'border-subtle': 'rgb(var(--c-accent-green) / 0.12)',
        /** text / knobs on an accent background (white; dark on DevVersion silver) */
        'on-accent': v('on-accent')
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace']
      },
      // default border color for bare `border` (overrides Tailwind's near-white)
      borderColor: {
        DEFAULT: 'rgb(var(--c-accent-green) / 0.22)'
      },
      borderRadius: {
        card: '20px',
        pill: '999px'
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.22, 1, 0.36, 1)'
      }
    }
  },
  plugins: []
} satisfies Config
