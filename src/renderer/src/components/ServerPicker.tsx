import { useEffect, useRef, useState } from 'react'
import { useServers } from '../store/serversStore'
import { useServerList, type ServerEntry } from '../hooks/useServerList'
import { useConnection } from '../store/connectionStore'
import { PROTOCOL_LABEL } from '../lib/format'
import { cn } from '../lib/cn'
import { Flag } from './Flag'
import { LatencyBadge } from './LatencyBadge'
import { CheckIcon, ChevronDownIcon, RefreshIcon } from './icons'

/** Bottom-of-home server selector: one click opens, one click picks. */
export function ServerPicker() {
  const { entries, active, autoPick } = useServerList()
  const { testing, test, select } = useServers()
  const connected = useConnection((s) => s.state === 'connected')
  const pickLabel = connected ? 'Сейчас' : 'Быстрее всех'
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    void test() // at most once a minute
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, test])

  if (!active) return null

  return (
    <div ref={ref} className="relative w-full">
      {open && (
        <div className="animate-pop absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-2xl border border-border-default bg-bg-panel shadow-[0_18px_50px_rgba(0,0,0,0.55)]">
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
            <span className="text-xs font-semibold text-text-muted">Выбор сервера</span>
            <button
              onClick={() => void test(true)}
              disabled={testing}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:opacity-50"
            >
              <RefreshIcon width={13} height={13} className={cn(testing && 'animate-spin')} />
              {testing ? 'Проверка…' : 'Проверить'}
            </button>
          </div>
          <div className="max-h-[300px] overflow-y-auto p-1.5">
            {entries.map((e) => (
              <PickerRow
                key={e.id}
                entry={e}
                hint={e.auto ? autoHint(e, autoPick?.label, pickLabel.toLowerCase()) : undefined}
                selected={e.id === active.id}
                testing={testing || !!e.checking}
                onClick={() => {
                  setOpen(false)
                  if (e.id !== active.id) void select(e.id)
                }}
              />
            ))}
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-[60px] w-full items-center gap-3.5 rounded-2xl border bg-bg-panel px-4 text-left transition-all duration-200 hover:bg-bg-elevated',
          open ? 'border-accent-green/50' : 'border-border-default'
        )}
      >
        <Flag code={active.code} auto={active.auto} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-text-primary">{active.label}</div>
          <div
            className={cn(
              'truncate text-[11px]',
              active.dead ? 'text-accent-red' : 'text-text-muted'
            )}
          >
            {active.auto
              ? (autoHint(active, autoPick?.label, pickLabel) ??
                'Самый быстрый из доступных, проверка каждые 5 минут')
              : (PROTOCOL_LABEL[active.protocol ?? ''] ?? 'Сервер')}
          </div>
        </div>
        <LatencyBadge ms={active.latency} testing={testing || !!active.checking} />
        <ChevronDownIcon
          width={18}
          height={18}
          className={cn('text-text-muted transition-transform duration-300', open && 'rotate-180')}
        />
      </button>
    </div>
  )
}

/** second line of «Лучший сервер (авто)» */
function autoHint(e: ServerEntry, pick: string | undefined, prefix: string): string | undefined {
  if (e.checking) return 'Проверяем серверы…'
  if (e.dead) return 'Ни один сервер не отвечает — проверьте интернет или выберите сервер вручную'
  return pick ? `${prefix}: ${pick}` : undefined
}

function PickerRow({
  entry,
  hint,
  selected,
  testing,
  onClick
}: {
  entry: ServerEntry
  hint?: string
  selected: boolean
  testing: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors',
        selected ? 'bg-accent-green/10' : 'hover:bg-bg-elevated'
      )}
    >
      <Flag code={entry.code} auto={entry.auto} />
      <div className="min-w-0 flex-1">
        <div
          className={cn('truncate text-sm', selected ? 'text-accent-green' : 'text-text-primary')}
        >
          {entry.label}
        </div>
        {hint && <div className="truncate text-[11px] text-text-muted">{hint}</div>}
      </div>
      <LatencyBadge ms={entry.latency} testing={testing} />
      <span className={cn('w-4 text-accent-green', !selected && 'invisible')}>
        <CheckIcon width={16} height={16} />
      </span>
    </button>
  )
}
