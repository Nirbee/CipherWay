import { cn } from '../lib/cn'

type Tone = 'green' | 'amber' | 'red' | 'none'

/** ≤ 400 ms green, ≤ 900 amber, slower or no answer red (HTTPS round trip via the node). */
export function latencyTone(ms: number | null | undefined): Tone {
  if (ms === undefined) return 'none'
  if (ms === null) return 'red'
  if (ms <= 400) return 'green'
  if (ms <= 900) return 'amber'
  return 'red'
}

const TONE: Record<Tone, string> = {
  green: 'text-accent-green',
  amber: 'text-accent-amber',
  red: 'text-accent-red',
  none: 'text-text-faint'
}
const DOT: Record<Tone, string> = {
  green: 'bg-accent-green',
  amber: 'bg-accent-amber',
  red: 'bg-accent-red',
  none: 'bg-text-faint/50'
}

interface Props {
  /** undefined = not tested yet, null = no answer */
  ms: number | null | undefined
  testing?: boolean
  className?: string
}

export function LatencyBadge({ ms, testing, className }: Props) {
  const tone = latencyTone(ms)
  if (testing && ms === undefined) {
    return (
      <span
        className={cn('inline-flex items-center gap-1.5 font-mono text-xs text-text-muted', className)}
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-muted" />
        проверка
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-xs tabular-nums',
        TONE[tone],
        testing && 'animate-pulse',
        className
      )}
      title={ms === null ? 'Сервер не ответил за 5 секунд' : undefined}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', DOT[tone])} />
      {ms === undefined ? '—' : ms === null ? 'нет ответа' : `${ms} мс`}
    </span>
  )
}
