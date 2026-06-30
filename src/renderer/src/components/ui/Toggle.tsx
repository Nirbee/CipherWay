import { cn } from '../../lib/cn'

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
  size?: 'sm' | 'md'
}

export function Toggle({ checked, onChange, disabled, label, size = 'md' }: ToggleProps) {
  const dims =
    size === 'sm'
      ? { track: 'h-5 w-9', knob: 'h-3.5 w-3.5', on: 'translate-x-4' }
      : { track: 'h-6 w-11', knob: 'h-4 w-4', on: 'translate-x-5' }

  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'no-drag relative inline-flex shrink-0 items-center rounded-pill transition-colors disabled:opacity-40',
        dims.track,
        checked ? 'bg-accent-blue' : 'bg-bg-elevated'
      )}
    >
      <span
        className={cn(
          'inline-block transform rounded-full bg-white shadow transition-transform',
          dims.knob,
          'translate-x-1',
          checked && dims.on
        )}
      />
    </button>
  )
}
