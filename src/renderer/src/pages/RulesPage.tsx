import { useEffect, useMemo, useState } from 'react'
import type { DefaultBehavior, RoutingRule } from '@shared/types'
import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/EmptyState'
import { Button, Input } from '../components/ui'
import { CodeIcon, InfoIcon, ListIcon, PlusIcon, RulesIcon, SearchIcon } from '../components/icons'
import { useRules } from '../store/rulesStore'
import { useSettings } from '../store/settingsStore'
import { RuleCard } from '../components/rules/RuleCard'
import { RuleEditor } from '../components/rules/RuleEditor'
import { RulesTextEditor } from '../components/rules/RulesTextEditor'
import { actionLabel, CONDITION_META, DEFAULT_BEHAVIOR_LABEL } from '../lib/ruleMeta'
import { cn } from '../lib/cn'

type Tab = 'list' | 'text'

const BEHAVIORS: DefaultBehavior[] = ['auto', 'proxy', 'direct']

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
  const routingMode = useSettings((s) => s.settings?.routingMode ?? 'rule')
  const setRoutingMode = useSettings((s) => s.setRoutingMode)

  const [tab, setTab] = useState<Tab>('list')
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
    const all = rules.map((r, i) => ({ rule: r, index: i }))
    if (!q) return all
    return all.filter(
      ({ rule }) =>
        rule.value.toLowerCase().includes(q) ||
        CONDITION_META[rule.conditionType].label.toLowerCase().includes(q) ||
        CONDITION_META[rule.conditionType].clash.toLowerCase().includes(q) ||
        actionLabel(rule.action).toLowerCase().includes(q)
    )
  }, [rules, filter])

  const dndActive = filter.trim() === ''

  const openAdd = () => {
    setEditing(null)
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
        subtitle="Что идёт через VPN, а что напрямую. Правила проверяются сверху вниз — срабатывает первое подходящее."
        actions={
          <div className="flex rounded-pill border border-border-default p-0.5 text-xs">
            {(
              [
                ['list', 'Список', ListIcon],
                ['text', 'Текст / импорт из Clash', CodeIcon]
              ] as const
            ).map(([k, label, Icon]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cn(
                  'flex items-center gap-1.5 rounded-pill px-3 py-1.5 transition-colors',
                  tab === k ? 'bg-bg-elevated text-text-primary' : 'text-text-muted hover:text-text-primary'
                )}
              >
                <Icon width={13} height={13} />
                {label}
              </button>
            ))}
          </div>
        }
      />

      {routingMode !== 'rule' && (
        <div className="mx-7 mb-3 flex items-center gap-2.5 rounded-xl border border-accent-amber/30 bg-accent-amber/10 px-3.5 py-2 text-xs text-accent-amber">
          <InfoIcon width={15} height={15} className="shrink-0" />
          <span className="flex-1">
            Сейчас включён режим «{routingMode === 'global' ? 'Весь трафик' : 'Напрямую'}» — правила
            не действуют.
          </span>
          <button
            onClick={() => void setRoutingMode('rule')}
            className="rounded-lg px-2 py-1 font-medium text-accent-amber hover:bg-accent-amber/15"
          >
            Включить «По правилам»
          </button>
        </div>
      )}

      {tab === 'text' ? (
        <RulesTextEditor onApplied={() => setTab('list')} />
      ) : (
        <>
          <div className="flex items-center gap-3 px-7 pb-3">
            <div className="relative max-w-xs flex-1">
              <SearchIcon
                width={15}
                height={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-faint"
              />
              <Input
                placeholder="Поиск по правилам"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-9 pl-9"
              />
            </div>
            <Button variant="ghost" size="sm" onClick={() => void importRules()}>
              Импорт JSON
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void exportRules()}>
              Экспорт JSON
            </Button>
            <div className="flex-1" />
            <Button size="sm" onClick={openAdd}>
              <PlusIcon width={15} height={15} />
              Добавить правило
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-4">
            {filtered.length === 0 ? (
              <EmptyState
                icon={<RulesIcon width={24} height={24} />}
                title={rules.length === 0 ? 'Правил пока нет' : 'Ничего не найдено'}
                text={
                  rules.length === 0
                    ? 'Добавьте правило вручную или перенесите свои правила из Koala Clash на вкладке «Текст».'
                    : 'Измените запрос поиска.'
                }
                action={
                  rules.length === 0 && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={openAdd}>
                        Добавить правило
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setTab('text')}>
                        Импорт из Clash
                      </Button>
                    </div>
                  )
                }
              />
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
                      'transition-opacity',
                      dragIndex === index && 'opacity-40',
                      overIndex === index && dragIndex !== index && 'rounded-card ring-1 ring-accent-green'
                    )}
                  >
                    <RuleCard
                      rule={rule}
                      index={index}
                      draggable={dndActive}
                      onToggle={() => toggleRule(rule.id)}
                      onEdit={() => {
                        setEditing(rule)
                        setEditorOpen(true)
                      }}
                      onDelete={() => removeRule(rule.id)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* default route for everything no rule matched */}
          <div className="mx-7 mb-6 flex items-center gap-3 rounded-2xl border border-border-default bg-bg-panel px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-primary">Всё остальное</div>
              <div className="text-[11px] text-text-muted">
                Куда идёт трафик, для которого не подошло ни одно правило
              </div>
            </div>
            <div className="flex rounded-pill border border-border-default p-0.5">
              {BEHAVIORS.map((b) => (
                <button
                  key={b}
                  onClick={() => void setDefaultBehavior(b)}
                  title={b === 'auto' ? 'Локальная сеть и российские сайты/IP — напрямую, остальное — через VPN' : undefined}
                  className={cn(
                    'rounded-pill px-3 py-1 text-xs transition-colors',
                    defaultBehavior === b
                      ? 'bg-accent-green/15 text-accent-green'
                      : 'text-text-muted hover:text-text-primary'
                  )}
                >
                  {DEFAULT_BEHAVIOR_LABEL[b]}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

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
