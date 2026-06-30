import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean
  invalid?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, mono, invalid, ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      className={cn(
        'no-drag h-10 w-full rounded-xl border bg-bg-input px-3.5 text-sm text-text-primary placeholder:text-text-faint',
        'outline-none transition-colors focus:border-accent-blue',
        invalid ? 'border-accent-red' : 'border-border-default',
        mono && 'font-mono',
        'select-text',
        className
      )}
      {...rest}
    />
  )
})
