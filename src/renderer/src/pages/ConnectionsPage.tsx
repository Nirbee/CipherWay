import { useEffect, useMemo, useState } from 'react'
import type { ConnItem, ConnSnapshot, FailedDirect, RoutingRule } from '@shared/types'
import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/EmptyState'
import { Button, Input } from '../components/ui'
import {
  ActivityIcon,
  AppWindowIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CloseIcon,
  GlobeIcon,
  InfoIcon,
  PowerIcon,
  SearchIcon
} from '../components/icons'
import { useConnection } from '../store/connectionStore'
import { useRules } from '../store/rulesStore'
import { useProcessIcon } from '../hooks/useProcessIcon'
import { toast } from '../store/toastStore'
import { errorText, formatBytes, formatDuration, formatSpeed } from '../lib/format'
import { cn } from '../lib/cn'

type GroupBy = 'process' | 'host'

interface Group {
  key: string
  title: string
  path?: string
  items: ConnItem[]
  total: number
  upSpeed: number
  downSpeed: number
  vpn: number
  direct: number
}

const IP_RE = /^[\d.]+$|:/

/** youtube.com from rr3---sn-abc.googlevideo.com style hosts */
function siteOf(host: string): string {
  if (IP_RE.test(host)) return host
  const parts = host.split('.')
  return parts.length <= 2 ? host : parts.slice(-2).join('.')
}

function group(items: ConnItem[], by: GroupBy): Group[] {
  const map = new Map<string, Group>()
  for (const c of items) {
    const key = by === 'process' ? (c.process ?? '').toLowerCase() || '—' : siteOf(c.host)
    const title = by === 'process' ? c.process || 'Неизвестная программа' : key
    let g = map.get(key)
    if (!g) {
      g = { key, title, path: by === 'process' ? c.processPath : undefined, items: [], total: 0, upSpeed: 0, downSpeed: 0, vpn: 0, direct: 0 }
      map.set(key, g)
    }
    g.items.push(c)
    g.total += c.upload + c.download
    g.upSpeed += c.uploadSpeed
    g.downSpeed += c.downloadSpeed
    if (c.route === 'proxy') g.vpn++
    else if (c.route === 'direct') g.direct++
  }
  return [...map.values()].sort((a, b) => b.total - a.total || b.items.length - a.items.length)
}

function matches(c: ConnItem, q: string): boolean {
  return [c.process, c.host, c.serverName, c.rule, c.port].some((v) => v?.toLowerCase().includes(q))
}

function useConnections(enabled: boolean): ConnSnapshot | null {
  const [snap, setSnap] = useState<ConnSnapshot | null>(null)
  useEffect(() => {
    if (!enabled) {
      setSnap(null)
      return
    }
    let alive = true
    const poll = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const s = await window.api.connections.list()
        if (alive) setSnap(s)
      } catch {
        /* core restarting */
      }
    }
    void poll()
    const id = setInterval(() => void poll(), 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [enabled])
  return snap
}

export function ConnectionsPage() {
  const { state, connect } = useConnection()
  const connected = state === 'connected'
  const snap = useConnections(connected)
  const [query, setQuery] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('process')
  const [selected, setSelected] = useState<string | null>(null)

  const items = useMemo(() => snap?.items ?? [], [snap])
  const hasProcesses = items.some((c) => c.process)
  const effectiveBy: GroupBy = groupBy === 'process' && items.length > 0 && !hasProcesses ? 'host' : groupBy
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => (q ? items.filter((c) => matches(c, q)) : items), [items, q])
  const groups = useMemo(() => group(filtered, effectiveBy), [filtered, effectiveBy])
  const current = groups.find((g) => g.key === selected) ?? groups[0]

  const vpnCount = items.filter((c) => c.route === 'proxy').length
  const directCount = items.filter((c) => c.route === 'direct').length
  const down = items.reduce((s, c) => s + c.downloadSpeed, 0)
  const up = items.reduce((s, c) => s + c.uploadSpeed, 0)

  const closeAll = async () => {
    try {
      await window.api.connections.closeAll()
      toast('Все соединения закрыты — программы переподключатся сами', 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  if (!connected) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Подключения" subtitle="Какие программы и сайты идут через VPN, а какие — напрямую" />
        <EmptyState
          className="flex-1"
          icon={<ActivityIcon width={24} height={24} />}
          title={state === 'connecting' ? 'Подключение…' : 'VPN не подключён'}
          text="Список соединений появится после подключения. Здесь видно, через что идёт каждое соединение и какое правило сработало."
          action={
            state !== 'connecting' && (
              <Button onClick={() => void connect()}>
                <PowerIcon width={15} height={15} />
                Подключить
              </Button>
            )
          }
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Подключения"
        subtitle={`${items.length} соединений · через VPN ${vpnCount} · напрямую ${directCount}`}
        actions={
          <>
            <div className="mr-1 flex items-center gap-3 font-mono text-xs tabular-nums">
              <span className="flex items-center gap-1 text-accent-green">
                <ArrowDownIcon width={13} height={13} />
                {formatSpeed(down)}
              </span>
              <span className="flex items-center gap-1 text-accent-blue-bright">
                <ArrowUpIcon width={13} height={13} />
                {formatSpeed(up)}
              </span>
            </div>
            <Button variant="danger" size="sm" onClick={() => void closeAll()} disabled={items.length === 0}>
              Закрыть все
            </Button>
          </>
        }
      />

      <div className="flex items-center gap-3 px-7 pb-3">
        <div className="relative max-w-sm flex-1">
          <SearchIcon width={15} height={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
          <Input
            placeholder="Поиск: программа, сайт, сервер, правило"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 pl-9"
          />
        </div>
        <div className="flex rounded-pill border border-border-default p-0.5 text-xs">
          {(
            [
              ['process', 'По программам', AppWindowIcon],
              ['host', 'По сайтам', GlobeIcon]
            ] as const
          ).map(([k, label, Icon]) => (
            <button
              key={k}
              onClick={() => {
                setGroupBy(k)
                setSelected(null)
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-pill px-3 py-1 transition-colors',
                effectiveBy === k ? 'bg-bg-elevated text-text-primary' : 'text-text-muted hover:text-text-primary'
              )}
            >
              <Icon width={13} height={13} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {(snap?.proxyMode === 'system' || (items.length > 0 && !hasProcesses)) && (
        <div className="mx-7 mb-3 flex items-start gap-2 rounded-xl border border-border-subtle bg-bg-panel-alt px-3 py-2 text-[11px] leading-relaxed text-text-muted">
          <InfoIcon width={14} height={14} className="mt-px shrink-0 text-accent-blue-bright" />
          {items.length > 0 && !hasProcesses
            ? 'Ядро не сообщило, какие программы открыли эти соединения, поэтому они сгруппированы по сайтам.'
            : 'Режим «Системный прокси»: здесь видны только программы, которые используют прокси Windows. Программы, которые его игнорируют (часть игр и мессенджеров), идут мимо VPN и в списке не появляются. Чтобы VPN видел всё, включите TUN в настройках.'}
        </div>
      )}

      {snap?.failed && snap.failed.length > 0 && <FailedDirectPanel failed={snap.failed} />}

      <div className="mx-7 mb-6 flex min-h-0 flex-1 overflow-hidden rounded-card border border-border-default bg-bg-panel">
        {groups.length === 0 ? (
          <EmptyState
            className="flex-1"
            icon={<ActivityIcon width={24} height={24} />}
            title={q ? 'Ничего не найдено' : 'Пока тихо'}
            text={q ? 'Измените запрос поиска.' : 'Как только программы начнут выходить в сеть, они появятся здесь.'}
          />
        ) : (
          <>
            <div className="flex w-[300px] shrink-0 flex-col border-r border-border-subtle">
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {groups.map((g) => (
                  <GroupRow
                    key={g.key}
                    g={g}
                    by={effectiveBy}
                    active={current?.key === g.key}
                    onClick={() => setSelected(g.key)}
                  />
                ))}
              </div>
              <div className="flex items-center gap-3 border-t border-border-subtle px-4 py-2 text-[10px] text-text-faint">
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent-green" />
                  через VPN
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent-blue" />
                  напрямую
                </span>
              </div>
            </div>
            {current && <GroupDetail g={current} by={effectiveBy} />}
          </>
        )}
      </div>
    </div>
  )
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/** The rule that would send this address through the VPN. */
function vpnRuleFor(f: FailedDirect): Omit<RoutingRule, 'id'> {
  if (f.telegram) return { enabled: true, conditionType: 'GeoIP', value: 'telegram', action: 'PROXY' }
  if (IPV4_RE.test(f.host) || f.host.includes(':'))
    return { enabled: true, conditionType: 'IPCIDR', value: f.host, action: 'PROXY' }
  return { enabled: true, conditionType: 'DomainSuffix', value: f.host, action: 'PROXY' }
}

function ruleText(r: Omit<RoutingRule, 'id'>): string {
  if (r.conditionType === 'GeoIP') return 'адреса Telegram'
  return r.conditionType === 'IPCIDR' ? `IP ${r.value}` : `сайт ${r.value}`
}

/**
 * Connections that went «напрямую» and timed out: in Russia that is almost
 * always a blocked address. One click adds a «через VPN» rule at the top.
 */
function FailedDirectPanel({ failed }: { failed: FailedDirect[] }) {
  const [open, setOpen] = useState(false)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const { prependRule, rules, loaded, load } = useRules()
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])
  const hasTelegramRule = rules.some(
    (r) => r.enabled && r.conditionType === 'GeoIP' && r.value.toLowerCase() === 'telegram'
  )
  const shown = open ? failed : failed.slice(0, 3)

  const add = async (f: FailedDirect) => {
    const rule = vpnRuleFor(f)
    try {
      await prependRule(rule)
      setAdded((s) => new Set(s).add(`${rule.conditionType}:${rule.value}`))
      toast(`Правило добавлено: ${ruleText(rule)} → через VPN. Применится через секунду.`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  return (
    <div className="mx-7 mb-3 rounded-xl border border-accent-amber/30 bg-accent-amber/[0.07] px-3.5 py-2.5">
      <div className="flex items-start gap-2 text-[11px] leading-relaxed text-accent-amber">
        <InfoIcon width={14} height={14} className="mt-px shrink-0" />
        <span className="flex-1">
          Не удалось подключиться напрямую (нет ответа): {failed.length}{' '}
          {failed.length === 1 ? 'адрес' : 'адресов'}. Возможно, они заблокированы — добавьте правило
          «через VPN».
        </span>
        {failed.length > 3 && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded-lg px-2 font-medium hover:bg-accent-amber/15"
          >
            {open ? 'Свернуть' : 'Показать все'}
          </button>
        )}
      </div>
      <div className="mt-1.5 space-y-1">
        {shown.map((f) => {
          const rule = vpnRuleFor(f)
          const key = `${rule.conditionType}:${rule.value}`
          const done = added.has(key) || (f.telegram && hasTelegramRule)
          return (
            <div key={`${f.host}:${f.port}`} className="flex items-center gap-3 text-[11px]">
              <span className="min-w-0 flex-1 truncate font-mono text-text-secondary select-text">
                {f.host}
                <span className="text-text-faint">:{f.port}</span>
                <span className="ml-2 font-sans text-text-faint">
                  {f.process ?? 'программа неизвестна'}
                  {f.telegram ? ' · Telegram' : ''} · {f.count} раз
                </span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="h-6 shrink-0 px-2 text-[11px]"
                disabled={done}
                onClick={() => void add(f)}
              >
                {done ? 'Добавлено' : f.telegram ? 'Telegram через VPN' : 'Через VPN'}
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ProcIcon({ path, by, className }: { path?: string; by: GroupBy; className?: string }) {
  const icon = useProcessIcon(by === 'process' ? path : undefined)
  return (
    <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-elevated text-text-muted', className)}>
      {icon ? (
        <img src={icon} alt="" className="h-5 w-5" />
      ) : by === 'process' ? (
        <AppWindowIcon width={16} height={16} />
      ) : (
        <GlobeIcon width={16} height={16} />
      )}
    </span>
  )
}

function GroupRow({ g, by, active, onClick }: { g: Group; by: GroupBy; active: boolean; onClick: () => void }) {
  const n = g.items.length
  const vpnShare = n ? (g.vpn / n) * 100 : 0
  const directShare = n ? (g.direct / n) * 100 : 0
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors',
        active ? 'bg-accent-green/10' : 'hover:bg-bg-elevated/70'
      )}
    >
      <ProcIcon path={g.path} by={by} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('truncate text-[13px] font-medium', active ? 'text-text-primary' : 'text-text-secondary')}>
            {g.title}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-text-faint">{n}</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          {/* share of connections: VPN (mint) / direct (blue) / blocked */}
          <div className="flex h-1 flex-1 overflow-hidden rounded-pill bg-bg-elevated">
            <span className="h-full bg-accent-green" style={{ width: `${vpnShare}%` }} />
            <span className="h-full bg-accent-blue" style={{ width: `${directShare}%` }} />
          </div>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-faint">
            {g.downSpeed + g.upSpeed > 0 ? formatSpeed(g.downSpeed + g.upSpeed) : formatBytes(g.total)}
          </span>
        </div>
      </div>
    </button>
  )
}

function RouteBadge({ c }: { c: ConnItem }) {
  if (c.route === 'reject') {
    return <span className="rounded-pill bg-accent-red/15 px-2 py-0.5 text-[10px] font-medium text-accent-red">Заблокировано</span>
  }
  if (c.route === 'direct') {
    return <span className="rounded-pill bg-accent-blue/15 px-2 py-0.5 text-[10px] font-medium text-accent-blue-bright">Напрямую</span>
  }
  return (
    <span className="max-w-[160px] truncate rounded-pill bg-accent-green/15 px-2 py-0.5 text-[10px] font-medium text-accent-green">
      VPN{c.serverName ? ` · ${c.serverName}` : ''}
    </span>
  )
}

function GroupDetail({ g, by }: { g: Group; by: GroupBy }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => setNow(Date.now()), [g])
  const items = [...g.items].sort((a, b) => b.start - a.start)

  const close = async (id: string) => {
    try {
      await window.api.connections.close(id)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
        <ProcIcon path={g.path} by={by} className="h-9 w-9" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-text-primary">{g.title}</div>
          <div className="truncate font-mono text-[10px] text-text-faint select-text">
            {by === 'process' ? (g.path ?? 'путь неизвестен') : `${g.items.length} соединений`}
          </div>
        </div>
        <div className="shrink-0 text-right font-mono text-[11px] tabular-nums text-text-muted">
          <div className="text-accent-green">↓ {formatSpeed(g.downSpeed)}</div>
          <div className="text-accent-blue-bright">↑ {formatSpeed(g.upSpeed)}</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.map((c) => (
          <div
            key={c.id}
            className="group grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border-subtle/60 px-4 py-2.5 last:border-0 hover:bg-bg-elevated/40"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-[12px] text-text-primary select-text">
                  {by === 'process' ? c.host : (c.process ?? c.host)}
                  <span className="text-text-faint">:{c.port}</span>
                </span>
                <span className="shrink-0 rounded bg-bg-elevated px-1 font-mono text-[9px] uppercase text-text-faint">
                  {c.network}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-text-muted">
                <RouteBadge c={c} />
                <span className="truncate">{c.rule}</span>
              </div>
              {c.stalled && (
                <div className="mt-0.5 text-[10px] text-accent-amber">
                  Нет ответа — возможно, этот адрес заблокирован. Добавьте правило «через VPN».
                </div>
              )}
            </div>
            <div className="text-right font-mono text-[10px] leading-relaxed tabular-nums text-text-faint">
              <div>
                ↓ {formatBytes(c.download)} · ↑ {formatBytes(c.upload)}
              </div>
              <div>{formatDuration(now - c.start)}</div>
            </div>
            <button
              onClick={() => void close(c.id)}
              title="Закрыть соединение"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-text-faint opacity-0 transition-all hover:bg-accent-red/15 hover:text-accent-red group-hover:opacity-100"
            >
              <CloseIcon width={14} height={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="border-t border-border-subtle px-4 py-2 text-[10px] text-text-faint">
        Соединения, заблокированные правилами, сбрасываются сразу и в списке не задерживаются.
      </div>
    </div>
  )
}
