import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-blue text-white hover:bg-accent-blue-light active:bg-accent-blue-dark',
  secondary:
    'bg-bg-panel-alt text-text-secondary hover:bg-bg-elevated border border-border-default',
  ghost: 'text-text-muted hover:bg-bg-elevated hover:text-text-primary',
  danger: 'bg-accent-red/15 text-accent-red hover:bg-accent-red hover:text-white'
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs rounded-lg',
  md: 'h-10 px-4 text-sm rounded-xl',
  lg: 'h-12 px-6 text-base rounded-xl'
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        'no-drag inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      disabled={disabled}
      {...rest}
    />
  )
}
