// Minimal inline SVG icon set (stroke-based, currentColor) to avoid an icon dep.
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

const base = (props: P) => ({
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...props
})

export const HomeIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 11l9-8 9 8" />
    <path d="M5 10v10h14V10" />
  </svg>
)

export const ServerIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </svg>
)

export const CardIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18" />
  </svg>
)

export const AppsIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
)

export const RulesIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6h16M4 12h16M4 18h10" />
    <circle cx="18" cy="18" r="2" />
  </svg>
)

export const LogsIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
)

export const SettingsIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 2.6 14H2.5a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.2 7L4.14 7a2 2 0 1 1 2.83-2.83L7 4.2a1.7 1.7 0 0 0 1.88.34H9A1.7 1.7 0 0 0 10 2.6V2.5a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83L20.6 7A1.7 1.7 0 0 0 21 9h.09a2 2 0 0 1 0 4H21a1.7 1.7 0 0 0-1.55 1z" />
  </svg>
)

export const MinimizeIcon = (p: P) => (
  <svg {...base({ ...p, strokeWidth: 1.4 })}>
    <path d="M5 12h14" />
  </svg>
)

export const MaximizeIcon = (p: P) => (
  <svg {...base({ ...p, strokeWidth: 1.4 })}>
    <rect x="5" y="5" width="14" height="14" rx="1.5" />
  </svg>
)

export const CloseIcon = (p: P) => (
  <svg {...base({ ...p, strokeWidth: 1.4 })}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export const PlusIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const CheckIcon = (p: P) => (
  <svg {...base({ ...p, strokeWidth: 2 })}>
    <path d="M5 13l4 4L19 7" />
  </svg>
)

export const PowerIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4v8" />
    <path d="M6.3 7.3a8 8 0 1 0 11.4 0" />
  </svg>
)
