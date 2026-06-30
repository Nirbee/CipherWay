import type { SelectHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

interface Option {
  value: string
  label: string
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  options: Option[]
  onChange: (value: string) => void
  mono?: boolean
}

export function Select({ options, onChange, className, mono, ...rest }: SelectProps) {
  return (
    <div className="relative">
      <select
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'no-drag h-10 w-full appearance-none rounded-xl border border-border-default bg-bg-input px-3.5 pr-9 text-sm text-text-primary',
          'outline-none transition-colors focus:border-accent-blue',
          mono && 'font-mono',
          className
        )}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-bg-panel text-text-primary">
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  )
}
