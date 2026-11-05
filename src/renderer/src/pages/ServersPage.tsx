import { useEffect, useMemo, useState } from 'react'
import { AUTO_OUTBOUND_ID } from '@shared/types'
import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/EmptyState'
import { Flag } from '../components/Flag'
import { LatencyBadge } from '../components/LatencyBadge'
import { Button } from '../components/ui'
import { CheckIcon, RefreshIcon, ServerIcon } from '../components/icons'
import { useSubscription } from '../store/subscriptionStore'
import { useServers } from '../store/serversStore'
import { useConnection } from '../store/connectionStore'
import { useNav } from '../store/navStore'
import { useServerList, type ServerEntry } from '../hooks/useServerList'
import { formatAgo, PROTOCOL_LABEL } from '../lib/format'
import { cn } from '../lib/cn'

type Sort = 'list' | 'latency'

export function ServersPage() {
  const { load } = useSubscription()
  const { testing, testedAt, test, select, loadActive, activeId } = useServers()
  const connected = useConnection((s) => s.state === 'connected')
  const setPage = useNav((s) => s.setPage)
  const { entries, autoPick } = useServerList()
  const [sort, setSort] = useState<Sort>('list')

  useEffect(() => {
    void load()
    void loadActive()
  }, [load, loadActive])

  // fresh latency on open (at most once a minute)
  const hasServers = entries.length > 0
  useEffect(() => {
    if (hasServers) void test()
  }, [hasServers, test])

  const [auto, ...servers] = entries
  const sorted = useMemo(() => {
    if (sort === 'list') return servers
    const score = (e: ServerEntry) =>
      e.latency === undefined ? 1e9 : e.latency === null ? 1e8 : e.latency
    return [...servers].sort((a, b) => score(a) - score(b))
  }, [servers, sort])

  const okCount = servers.filter((s) => typeof s.latency === 'number').length
  const subtitle = !hasServers
    ? 'Подписка не загружена'
    : testedAt
      ? `${servers.length} ${servers.length === 1 ? 'сервер' : 'серверов'} · отвечают ${okCount} · проверено ${formatAgo(testedAt)}`
      : `${servers.length} серверов в подписке`

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Серверы"
        subtitle={subtitle}
        actions={
          hasServers && (
            <>
              <div className="flex rounded-pill border border-border-default p-0.5 text-xs">
                {(
                  [
                    ['list', 'Как в подписке'],
                    ['latency', 'По задержке']
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setSort(k)}
                    className={cn(
                      'rounded-pill px-3 py-1 transition-colors',
                      sort === k ? 'bg-bg-elevated text-text-primary' : 'text-text-muted hover:text-text-primary'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Button size="sm" variant="secondary" onClick={() => void test(true)} disabled={testing}>
                <RefreshIcon width={14} height={14} className={cn(testing && 'animate-spin')} />
                {testing ? 'Проверка…' : 'Проверить'}
              </Button>
            </>
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-7">
        {!hasServers ? (
          <EmptyState
            icon={<ServerIcon width={24} height={24} />}
            title="Серверов пока нет"
            text="Добавьте ссылку подписки — список серверов загрузится из вашей панели."
            action={<Button onClick={() => setPage('subscription')}>Добавить подписку</Button>}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <ServerRow
              entry={auto}
              selected={activeId === AUTO_OUTBOUND_ID}
              testing={testing}
              onSelect={() => void select(AUTO_OUTBOUND_ID)}
              sub={
                autoPick
                  ? `${connected ? 'Сейчас' : 'Быстрее всех'}: ${autoPick.label}`
                  : 'Сам выбирает самый быстрый сервер и проверяет их каждые 5 минут'
              }
              highlight
            />
            <div className="mb-1 mt-3 px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-faint">
              Все серверы
            </div>
            {sorted.map((e) => (
              <ServerRow
                key={e.id}
                entry={e}
                selected={activeId === e.id}
                testing={testing}
                onSelect={() => void select(e.id)}
                sub={PROTOCOL_LABEL[e.protocol ?? ''] ?? ''}
                inAuto={connected && activeId === AUTO_OUTBOUND_ID && autoPick?.id === e.id}
              />
            ))}
            <p className="mt-3 px-1 text-[11px] leading-relaxed text-text-faint">
              Задержка — время настоящего запроса к сайту через сервер (как в Clash url-test), а
              не пинг до адреса. «Нет ответа» — сервер сейчас не пропускает трафик.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function ServerRow({
  entry,
  selected,
  testing,
  onSelect,
  sub,
  highlight,
  inAuto
}: {
  entry: ServerEntry
  selected: boolean
  testing: boolean
  onSelect: () => void
  sub: string
  highlight?: boolean
  inAuto?: boolean
}) {
  const dead = entry.latency === null && !entry.auto
  return (
    <button
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center gap-4 rounded-2xl border px-4 py-3 text-left transition-all duration-200',
        selected
          ? 'border-accent-green/50 bg-accent-green/[0.07]'
          : highlight
            ? 'border-border-default bg-gradient-to-r from-accent-green/[0.06] to-transparent hover:bg-bg-elevated'
            : 'border-border-subtle bg-bg-panel hover:border-border-default hover:bg-bg-elevated'
      )}
    >
      <Flag code={entry.code} auto={entry.auto} size="lg" className={cn(dead && 'opacity-50 grayscale')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-sm font-semibold', dead ? 'text-text-muted' : 'text-text-primary')}>
            {entry.label}
          </span>
          {inAuto && (
            <span className="shrink-0 rounded-pill bg-accent-green/15 px-2 py-px text-[10px] font-medium text-accent-green">
              выбран автоматически
            </span>
          )}
        </div>
        {entry.hint ? (
          <div className="text-[11px] leading-snug text-accent-amber">{entry.hint}</div>
        ) : (
          sub && <div className="truncate text-[11px] text-text-muted">{sub}</div>
        )}
      </div>
      <LatencyBadge ms={entry.latency} testing={testing} />
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors',
          selected
            ? 'border-accent-green bg-accent-green text-bg-app'
            : 'border-border-default text-transparent group-hover:border-accent-green/50'
        )}
      >
        <CheckIcon width={14} height={14} />
      </span>
    </button>
  )
}
