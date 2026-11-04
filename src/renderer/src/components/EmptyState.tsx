import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

export function EmptyState({
  icon,
  title,
  text,
  action,
  className
}: {
  icon: ReactNode
  title: string
  text?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'animate-fade flex flex-col items-center justify-center px-6 py-12 text-center',
        className
      )}
    >
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-border-default bg-bg-panel text-accent-green">
        {icon}
      </div>
      <div className="text-sm font-semibold text-text-primary">{title}</div>
      {text && <div className="mt-1.5 max-w-sm text-xs leading-relaxed text-text-muted">{text}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
