import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { BoltIcon, GlobeIcon } from './icons'

// Simplified SVG flags (viewBox 30×20). Windows can't draw emoji flags, and a
// font/sprite would be another asset — these cover the usual VPN locations.
// Anything else falls back to the ISO code on a neutral tile.

const W = 30
const H = 20

const hBands = (...colors: string[]): ReactNode => {
  const h = H / colors.length
  return colors.map((c, i) => <rect key={i} x="0" y={i * h} width={W} height={h + 0.05} fill={c} />)
}
const vBands = (...colors: string[]): ReactNode => {
  const w = W / colors.length
  return colors.map((c, i) => <rect key={i} x={i * w} y="0" width={w + 0.05} height={H} fill={c} />)
}
/** Nordic cross: background, cross, optional inner cross */
const nordic = (bg: string, cross: string, inner?: string): ReactNode => (
  <>
    <rect width={W} height={H} fill={bg} />
    <rect x="8" y="0" width="5" height={H} fill={cross} />
    <rect x="0" y="7.5" width={W} height="5" fill={cross} />
    {inner && (
      <>
        <rect x="9.5" y="0" width="2" height={H} fill={inner} />
        <rect x="0" y="9" width={W} height="2" fill={inner} />
      </>
    )}
  </>
)

const FLAGS: Record<string, ReactNode> = {
  RU: hBands('#ffffff', '#0039a6', '#d52b1e'),
  NL: hBands('#ae1c28', '#ffffff', '#21468b'),
  DE: hBands('#1a1a1a', '#dd0000', '#ffce00'),
  AT: hBands('#c8102e', '#ffffff', '#c8102e'),
  PL: hBands('#ffffff', '#dc143c'),
  UA: hBands('#0057b7', '#ffd700'),
  EE: hBands('#0072ce', '#1a1a1a', '#ffffff'),
  LT: hBands('#fdb913', '#006a44', '#c1272d'),
  LV: (
    <>
      <rect width={W} height={H} fill="#9e3039" />
      <rect y="8" width={W} height="4" fill="#ffffff" />
    </>
  ),
  HU: hBands('#ce2939', '#ffffff', '#477050'),
  BG: hBands('#ffffff', '#00966e', '#d62612'),
  LU: hBands('#ed2939', '#ffffff', '#00a1de'),
  AM: hBands('#d90012', '#0033a0', '#f2a800'),
  RS: hBands('#c6363c', '#0c4076', '#ffffff'),
  KZ: (
    <>
      <rect width={W} height={H} fill="#00afca" />
      <circle cx="15" cy="9" r="4" fill="#fec50c" />
    </>
  ),
  FR: vBands('#0055a4', '#ffffff', '#ef4135'),
  IT: vBands('#009246', '#ffffff', '#ce2b37'),
  IE: vBands('#169b62', '#ffffff', '#ff883e'),
  BE: vBands('#1a1a1a', '#fdda24', '#ef3340'),
  RO: vBands('#002b7f', '#fcd116', '#ce1126'),
  MD: vBands('#0046ae', '#ffd200', '#cc092f'),
  FI: nordic('#ffffff', '#003580'),
  SE: nordic('#006aa7', '#fecc00'),
  DK: nordic('#c8102e', '#ffffff'),
  NO: nordic('#ba0c2f', '#ffffff', '#00205b'),
  IS: nordic('#02529c', '#ffffff', '#dc1e35'),
  CH: (
    <>
      <rect width={W} height={H} fill="#da291c" />
      <rect x="13" y="4" width="4" height="12" fill="#ffffff" />
      <rect x="9" y="8" width="12" height="4" fill="#ffffff" />
    </>
  ),
  GE: (
    <>
      <rect width={W} height={H} fill="#ffffff" />
      <rect x="13" y="0" width="4" height={H} fill="#e8112d" />
      <rect x="0" y="8" width={W} height="4" fill="#e8112d" />
    </>
  ),
  JP: (
    <>
      <rect width={W} height={H} fill="#ffffff" />
      <circle cx="15" cy="10" r="5.5" fill="#bc002d" />
    </>
  ),
  TR: (
    <>
      <rect width={W} height={H} fill="#e30a17" />
      <circle cx="12" cy="10" r="5" fill="#ffffff" />
      <circle cx="13.3" cy="10" r="4" fill="#e30a17" />
      <circle cx="18.5" cy="10" r="1.6" fill="#ffffff" />
    </>
  ),
  US: (
    <>
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} y={(i * 2 * H) / 13} width={W} height={H / 13} fill="#b22234" />
      ))}
      {Array.from({ length: 6 }, (_, i) => (
        <rect key={`w${i}`} y={((i * 2 + 1) * H) / 13} width={W} height={H / 13} fill="#ffffff" />
      ))}
      <rect width="13" height="10.8" fill="#3c3b6e" />
    </>
  ),
  GB: (
    <>
      <rect width={W} height={H} fill="#012169" />
      <path d="M0 0L30 20M30 0L0 20" stroke="#ffffff" strokeWidth="4" />
      <path d="M0 0L30 20M30 0L0 20" stroke="#c8102e" strokeWidth="1.4" />
      <rect x="12" width="6" height={H} fill="#ffffff" />
      <rect y="7" width={W} height="6" fill="#ffffff" />
      <rect x="13.2" width="3.6" height={H} fill="#c8102e" />
      <rect y="8.2" width={W} height="3.6" fill="#c8102e" />
    </>
  ),
  CA: (
    <>
      {vBands('#d80621', '#ffffff', '#ffffff', '#d80621')}
      <path d="M15 5l1.4 2.8 2-0.8-0.6 3.4 2-1.4 0.2 1.6-2.6 2.2 0.4 1.6h-2.2V17h-1.2v-2.6h-2.2l0.4-1.6-2.6-2.2 0.2-1.6 2 1.4-0.6-3.4 2 0.8z" fill="#d80621" />
    </>
  ),
  CZ: (
    <>
      {hBands('#ffffff', '#d7141a')}
      <path d="M0 0L15 10L0 20z" fill="#11457e" />
    </>
  ),
  ES: (
    <>
      <rect width={W} height={H} fill="#aa151b" />
      <rect y="5" width={W} height="10" fill="#f1bf00" />
    </>
  ),
  PT: (
    <>
      <rect width="12" height={H} fill="#046a38" />
      <rect x="12" width="18" height={H} fill="#da291c" />
      <circle cx="12" cy="10" r="3.6" fill="#ffe900" />
    </>
  ),
  IL: (
    <>
      <rect width={W} height={H} fill="#ffffff" />
      <rect y="2" width={W} height="2.6" fill="#0038b8" />
      <rect y="15.4" width={W} height="2.6" fill="#0038b8" />
      <path d="M15 6.5l3 5.2h-6zM15 13.5l-3-5.2h6z" fill="none" stroke="#0038b8" strokeWidth="0.9" />
    </>
  ),
  AE: (
    <>
      {hBands('#00732f', '#ffffff', '#1a1a1a')}
      <rect width="8" height={H} fill="#ff0000" />
    </>
  ),
  IN: (
    <>
      {hBands('#ff9933', '#ffffff', '#138808')}
      <circle cx="15" cy="10" r="2.4" fill="none" stroke="#000080" strokeWidth="0.8" />
    </>
  ),
  SG: (
    <>
      {hBands('#ef3340', '#ffffff')}
      <circle cx="7" cy="5" r="3" fill="#ffffff" />
      <circle cx="8.2" cy="5" r="2.6" fill="#ef3340" />
    </>
  ),
  HK: (
    <>
      <rect width={W} height={H} fill="#de2910" />
      <circle cx="15" cy="10" r="4.5" fill="#ffffff" />
      <circle cx="15" cy="10" r="1.6" fill="#de2910" />
    </>
  )
}

interface FlagProps {
  code?: string
  /** «Лучший сервер (авто)» tile */
  auto?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZES = {
  sm: 'h-[18px] w-[27px] rounded-[4px]',
  md: 'h-6 w-9 rounded-md',
  lg: 'h-8 w-12 rounded-lg'
}

export function Flag({ code, auto, size = 'md', className }: FlagProps) {
  const box = cn('relative inline-flex shrink-0 overflow-hidden', SIZES[size], className)
  if (auto) {
    return (
      <span
        className={cn(
          box,
          'items-center justify-center bg-gradient-to-br from-accent-green/30 to-accent-blue/30 text-accent-green ring-1 ring-inset ring-accent-green/40'
        )}
      >
        <BoltIcon width={size === 'lg' ? 18 : 14} height={size === 'lg' ? 18 : 14} />
      </span>
    )
  }
  const svg = code ? FLAGS[code] : undefined
  if (!svg) {
    return (
      <span
        className={cn(
          box,
          'items-center justify-center bg-bg-elevated font-mono text-[9px] font-bold tracking-wide text-text-muted ring-1 ring-inset ring-white/5'
        )}
      >
        {code ?? <GlobeIcon width={size === 'lg' ? 16 : 13} height={size === 'lg' ? 16 : 13} />}
      </span>
    )
  }
  return (
    <span className={cn(box, 'ring-1 ring-inset ring-black/20')}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {svg}
      </svg>
      {/* subtle gloss so light flags don't melt into the dark UI */}
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/15 to-transparent" />
    </span>
  )
}
