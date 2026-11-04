import type { RoutingRule } from '@shared/types'
import { Card, Pill, Toggle } from '../ui'
import { EditIcon, GripIcon, TrashIcon } from '../icons'
import { actionLabel, actionTone, CONDITION_META } from '../../lib/ruleMeta'
import { cn } from '../../lib/cn'

interface Props {
  rule: RoutingRule
  index: number
  draggable: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}

export function RuleCard({ rule, index, draggable, onToggle, onEdit, onDelete }: Props) {
  const meta = CONDITION_META[rule.conditionType]

  return (
    <Card className={cn('group flex items-center gap-3 px-3 py-2.5', !rule.enabled && 'opacity-50')}>
      <div
        className={cn(
          'flex w-9 shrink-0 items-center gap-1 self-stretch text-text-faint',
          draggable && 'cursor-grab active:cursor-grabbing'
        )}
        title={draggable ? 'Перетащите, чтобы изменить порядок' : undefined}
      >
        <GripIcon width={14} height={14} className={cn(!draggable && 'invisible')} />
        <span className="font-mono text-[10px] tabular-nums">{index + 1}</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-sm font-medium text-text-primary', meta.mono && 'font-mono text-[13px]')}>
          {rule.value || '—'}
        </div>
        <div className="mt-0.5 text-[11px] text-text-muted">
          {meta.label} <span className="font-mono text-[10px] text-text-faint">{meta.clash}</span>
        </div>
      </div>

      <Pill tone={actionTone(rule.action)} className="max-w-[200px] truncate">
        {actionLabel(rule.action)}
      </Pill>

      <div className="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
        <button
          onClick={onEdit}
          title="Изменить"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-bg-elevated hover:text-text-primary"
        >
          <EditIcon width={15} height={15} />
        </button>
        <button
          onClick={onDelete}
          title="Удалить"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-accent-red/15 hover:text-accent-red"
        >
          <TrashIcon width={15} height={15} />
        </button>
      </div>
      <Toggle size="sm" checked={rule.enabled} onChange={onToggle} label="Включено" />
    </Card>
  )
}
