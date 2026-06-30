import type { Config } from 'tailwindcss'

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
          blue: '#4d7cfe',
          'blue-light': '#5b86ff',
          'blue-bright': '#9bb5ff',
          'blue-dark': '#3d63e0',
          'blue-deep': '#2c4ba0',
          green: '#34d399',
          amber: '#f5b942',
          red: '#f56565'
        },
        text: {
          primary: '#eef2fa',
          secondary: '#dbe3f2',
          tertiary: '#cdd6e8',
          muted: '#8593ad',
          disabled: '#6b7790',
          faint: '#5b6880'
        },
        border: {
          subtle: 'rgba(255,255,255,0.06)',
          DEFAULT: 'rgba(255,255,255,0.08)'
        }
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace']
      },
      borderRadius: {
        card: '18px',
        pill: '999px'
      }
    }
  },
  plugins: []
} satisfies Config
