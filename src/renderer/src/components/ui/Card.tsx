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
        'rounded-card border bg-bg-panel transition-colors',
        highlighted ? 'border-accent-blue' : 'border-border-default',
        hover && 'hover:bg-bg-elevated',
        className
      )}
      {...rest}
    />
  )
}
