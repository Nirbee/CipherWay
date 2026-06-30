import type { RoutingRule } from '@shared/types'
import { Card, Pill, Toggle } from '../ui'
import { actionTone, CONDITION_META } from '../../lib/ruleMeta'

interface Props {
  rule: RoutingRule
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}

export function RuleCard({ rule, onToggle, onEdit, onDelete }: Props) {
  const meta = CONDITION_META[rule.conditionType]

  return (
    <Card
      hover
      className={`flex items-center gap-3 px-3 py-3 ${rule.enabled ? '' : 'opacity-55'}`}
    >
      {/* drag handle (whole card is draggable) */}
      <div
        className="flex cursor-grab items-center self-stretch px-1 text-text-faint active:cursor-grabbing"
        title="Перетащите для изменения порядка"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.6" />
          <circle cx="15" cy="6" r="1.6" />
          <circle cx="9" cy="12" r="1.6" />
          <circle cx="15" cy="12" r="1.6" />
          <circle cx="9" cy="18" r="1.6" />
          <circle cx="15" cy="18" r="1.6" />
        </svg>
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-text-primary">
          <span className={meta.mono ? 'font-mono' : ''}>{rule.value || '—'}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Pill tone={meta.tone} mono={meta.mono}>
            {meta.label}
          </Pill>
          <span className="text-text-faint">→</span>
          <Pill tone={actionTone(rule.action)} mono>
            {rule.action}
          </Pill>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={onEdit}
          title="Редактировать"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-bg-elevated hover:text-text-primary"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        </button>
        <button
          onClick={onDelete}
          title="Удалить"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-accent-red/15 hover:text-accent-red"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
          </svg>
        </button>
        <div className="ml-1">
          <Toggle size="sm" checked={rule.enabled} onChange={onToggle} />
        </div>
      </div>
    </Card>
  )
}
