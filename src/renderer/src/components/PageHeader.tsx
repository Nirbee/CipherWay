import type { ReactNode } from 'react'

export function PageHeader({
  title,
  overline,
  subtitle,
  actions
}: {
  title: string
  overline?: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-7 pb-5 pt-6">
      <div className="min-w-0">
        {overline && (
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            {overline}
          </div>
        )}
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
