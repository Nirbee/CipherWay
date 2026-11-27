import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface MenuItem {
  label: string
  onSelect?: () => void
  disabled?: boolean
  /** why it is disabled / what it does (a tooltip and a second line) */
  hint?: string
  danger?: boolean
  icon?: ReactNode
}

export type MenuEntry = MenuItem | 'separator'

interface Props {
  /** where the right click was (client coordinates) */
  x: number
  y: number
  title?: string
  items: MenuEntry[]
  onClose: () => void
}

/** A small right-click menu: closes on a click outside, Esc, scroll, resize or the window losing focus. */
export function ContextMenu({ x, y, title, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // keep it inside the window
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    })
  }, [x, y])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    window.addEventListener('wheel', onClose, { passive: true })
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('wheel', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-[70] min-w-[240px] max-w-[340px] rounded-xl border border-border-default bg-bg-elevated/95 p-1 text-xs shadow-2xl backdrop-blur"
    >
      {title && <div className="truncate px-2.5 pb-1 pt-1.5 text-[10px] text-text-faint">{title}</div>}
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={`s${i}`} className="my-1 h-px bg-border-subtle" />
        ) : (
          <button
            key={`${i}:${it.label}`}
            role="menuitem"
            disabled={it.disabled}
            title={it.hint}
            onClick={() => {
              if (it.disabled) return
              onClose()
              it.onSelect?.()
            }}
            className={cn(
              'flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
              it.disabled
                ? 'cursor-default text-text-faint'
                : it.danger
                  ? 'text-accent-red hover:bg-accent-red/10'
                  : 'text-text-secondary hover:bg-bg-panel-alt hover:text-text-primary'
            )}
          >
            {it.icon && <span className="mt-px shrink-0">{it.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{it.label}</span>
              {it.hint && it.disabled && (
                <span className="block text-[10px] leading-snug text-text-faint">{it.hint}</span>
              )}
            </span>
          </button>
        )
      )}
    </div>
  )
}
