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

export const UpdateIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v12" />
    <path d="M8 11l4 4 4-4" />
    <path d="M5 19h14" />
  </svg>
)

export const ActivityIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  </svg>
)

export const BoltIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
  </svg>
)

export const GlobeIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </svg>
)

/** split routing: a path that forks */
export const SplitIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 3v6a6 6 0 0 0 6 6h6" />
    <path d="M6 9v12" />
    <path d="M15 12l3 3-3 3" />
  </svg>
)

/** straight arrow: bypass the VPN */
export const DirectIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 12h15" />
    <path d="M14 7l5 5-5 5" />
  </svg>
)

export const ShieldIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
  </svg>
)

export const ShieldCheckIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </svg>
)

export const SupportIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 12a8 8 0 0 1-11.6 7.2L4 20l1-4.6A8 8 0 1 1 21 12z" />
    <path d="M9 10.5a3 3 0 0 1 5.6 1.4c0 1.6-2.1 2-2.1 3.1M12.5 17.5h.01" />
  </svg>
)

export const RefreshIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
    <path d="M4 3v5h5" />
    <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
    <path d="M20 21v-5h-5" />
  </svg>
)

export const ChevronDownIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)

export const ChevronRightIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)

export const SearchIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
)

export const AlertIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l9.5 17h-19z" />
    <path d="M12 10v4M12 17.5h.01" />
  </svg>
)

export const InfoIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.5h.01" />
  </svg>
)

export const MegaphoneIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z" />
    <path d="M17 9a4 4 0 0 1 0 6" />
  </svg>
)

export const CalendarIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
)

export const DataIcon = (p: P) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </svg>
)

export const ClockIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const ArrowDownIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
)

export const ArrowUpIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
)

export const TrashIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
)

export const CopyIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </svg>
)

export const FileIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
)

export const CodeIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
  </svg>
)

export const ListIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />
  </svg>
)

export const ExternalIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
)

export const BanIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.6 5.6l12.8 12.8" />
  </svg>
)

export const AppWindowIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
  </svg>
)

export const EditIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
)

export const GripIcon = (p: P) => (
  <svg {...base({ ...p, fill: 'currentColor', stroke: 'none' })}>
    <circle cx="9" cy="6" r="1.6" />
    <circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" />
    <circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" />
    <circle cx="15" cy="18" r="1.6" />
  </svg>
)

export const SpinnerIcon = (p: P) => (
  <svg {...base(p)} className={`animate-spin ${p.className ?? ''}`}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
)
