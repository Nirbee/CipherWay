import { useEffect, useMemo, useState } from 'react'
import type { DefaultBehavior, RoutingRule } from '@shared/types'
import { PageHeader } from '../components/PageHeader'
import { Button, Input } from '../components/ui'
import { PlusIcon } from '../components/icons'
import { useRules } from '../store/rulesStore'
import { RuleCard } from '../components/rules/RuleCard'
import { RuleEditor } from '../components/rules/RuleEditor'
import { CONDITION_META } from '../lib/ruleMeta'
import { cn } from '../lib/cn'

const DEFAULT_BEHAVIOR_OPTS: { value: DefaultBehavior; label: string }[] = [
  { value: 'proxy', label: 'Proxy' },
  { value: 'direct', label: 'Direct' },
  { value: 'auto', label: 'Auto (geoip:ru → direct)' }
]

export function RulesPage() {
  const {
    rules,
    defaultBehavior,
    loaded,
    outboundNames,
    load,
    loadOutbounds,
    addRule,
    updateRule,
    removeRule,
    toggleRule,
    reorder,
    setDefaultBehavior,
    exportRules,
    importRules
  } = useRules()

  const [filter, setFilter] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<RoutingRule | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  useEffect(() => {
    if (!loaded) void load()
    void loadOutbounds()
  }, [loaded, load, loadOutbounds])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rules.map((r, i) => ({ rule: r, index: i }))
    return rules
      .map((r, i) => ({ rule: r, index: i }))
      .filter(
        ({ rule }) =>
          rule.value.toLowerCase().includes(q) ||
          CONDITION_META[rule.conditionType].label.toLowerCase().includes(q) ||
          rule.action.toLowerCase().includes(q)
      )
  }, [rules, filter])

  const dndActive = filter.trim() === ''

  const openAdd = () => {
    setEditing(null)
    setEditorOpen(true)
  }
  const openEdit = (rule: RoutingRule) => {
    setEditing(rule)
    setEditorOpen(true)
  }

  const handleSave = async (draft: Omit<RoutingRule, 'id'>) => {
    if (editing) await updateRule(editing.id, draft)
    else await addRule(draft)
    setEditorOpen(false)
  }

  const handleDrop = async (target: number) => {
    if (dragIndex !== null && dragIndex !== target) await reorder(dragIndex, target)
    setDragIndex(null)
    setOverIndex(null)
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Правила"
        subtitle="Маршрутизация по процессам и доменам. Порядок важен — побеждает первое совпадение."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => importRules()}>
              Импорт
            </Button>
            <Button variant="secondary" size="sm" onClick={() => exportRules()}>
              Экспорт
            </Button>
            <Button size="sm" onClick={openAdd}>
              <PlusIcon width={16} height={16} />
              Добавить
            </Button>
          </>
        }
      />

      <div className="flex items-center gap-3 px-6 pb-3">
        <Input
          placeholder="Фильтр"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-md"
        />
        <div className="ml-auto flex items-center gap-2 text-xs text-text-muted">
          <span>По умолчанию:</span>
          <div className="flex rounded-pill border border-border-default p-0.5">
            {DEFAULT_BEHAVIOR_OPTS.map((o) => (
              <button
                key={o.value}
                onClick={() => setDefaultBehavior(o.value)}
                className={`rounded-pill px-3 py-1 text-xs transition-colors ${
                  defaultBehavior === o.value
                    ? 'bg-accent-blue text-white'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {filtered.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-text-muted">
            {rules.length === 0 ? 'Правил пока нет — нажмите «Добавить»' : 'Ничего не найдено'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map(({ rule, index }) => (
              <div
                key={rule.id}
                draggable={dndActive}
                onDragStart={(e) => {
                  if (!dndActive) return
                  e.dataTransfer.effectAllowed = 'move'
                  setDragIndex(index)
                }}
                onDragEnd={() => {
                  setDragIndex(null)
                  setOverIndex(null)
                }}
                onDragOver={(e) => {
                  if (!dndActive) return
                  e.preventDefault()
                  setOverIndex(index)
                }}
                onDrop={() => dndActive && handleDrop(index)}
                className={cn(
                  dragIndex === index && 'opacity-40',
                  overIndex === index && dragIndex !== index && 'rounded-card ring-1 ring-accent-blue'
                )}
              >
                <RuleCard
                  rule={rule}
                  onToggle={() => toggleRule(rule.id)}
                  onEdit={() => openEdit(rule)}
                  onDelete={() => removeRule(rule.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <RuleEditor
        open={editorOpen}
        initial={editing}
        outboundNames={outboundNames}
        onClose={() => setEditorOpen(false)}
        onSave={handleSave}
      />
    </div>
  )
}
