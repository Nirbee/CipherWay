import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean
  highlighted?: boolean
}

export function Card({ hover, highlighted, className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-card border bg-bg-panel transition-all duration-200',
        highlighted ? 'border-accent-blue' : 'border-border-default',
        hover && 'hover:-translate-y-0.5 hover:border-accent-green/45 hover:bg-bg-elevated',
        className
      )}
      {...rest}
    />
  )
}
