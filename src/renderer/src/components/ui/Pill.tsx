import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type Tone = 'neutral' | 'blue' | 'green' | 'amber' | 'red'

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
  mono?: boolean
}

const TONES: Record<Tone, string> = {
  neutral: 'bg-bg-elevated text-text-tertiary',
  blue: 'bg-accent-blue/15 text-accent-blue-bright',
  green: 'bg-accent-green/15 text-accent-green',
  amber: 'bg-accent-amber/15 text-accent-amber',
  red: 'bg-accent-red/15 text-accent-red'
}

export function Pill({ tone = 'neutral', mono, className, ...rest }: PillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-[11px] font-medium leading-tight',
        mono && 'font-mono',
        TONES[tone],
        className
      )}
      {...rest}
    />
  )
}
