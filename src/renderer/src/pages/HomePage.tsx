import { useEffect, useMemo, useState } from 'react'
import { useConnection } from '../store/connectionStore'
import { useSubscription } from '../store/subscriptionStore'
import { useServers } from '../store/serversStore'
import { useNav } from '../store/navStore'
import { PageHeader } from '../components/PageHeader'
import { Button, Pill } from '../components/ui'
import { PowerIcon } from '../components/icons'
import { formatBytes, formatSpeed } from '../lib/format'
import { cn } from '../lib/cn'

const PROTO_LABEL: Record<string, string> = {
  vless: 'VLESS · REALITY',
  hysteria2: 'Hysteria2',
  vmess: 'VMess'
}

function useElapsed(connectedAt: number | null): string {
  const [, tick] = useState(0)
  useEffect(() => {
    if (connectedAt == null) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [connectedAt])
  if (connectedAt == null) return '00:00:00'
  const s = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000))
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export function HomePage() {
  const { state, traffic, connectedAt, connect, disconnect } = useConnection()
  const { data, load } = useSubscription()
  const { activeId, loadActive } = useServers()
  const setPage = useNav((s) => s.setPage)
  const elapsed = useElapsed(connectedAt)

  useEffect(() => {
    void load()
    void loadActive()
  }, [load, loadActive])

  const active = useMemo(
    () => data?.outbounds.find((o) => o.id === activeId) ?? data?.outbounds[0],
    [data, activeId]
  )

  const connected = state === 'connected'
  const connecting = state === 'connecting'
  const error = state === 'error'

  const onToggle = () => {
    if (connected || connecting) void disconnect()
    else void connect(active?.id)
  }

  const title = connected
    ? 'Соединение защищено'
    : connecting
      ? 'Установка соединения'
      : error
        ? 'Ошибка соединения'
        : 'Соединение не защищено'

  const flag = (active?.name ?? '··').slice(0, 2).toUpperCase()

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        overline="Статус"
        title={title}
        actions={
          connected ? (
            <Pill tone="green" className="px-3 py-1.5">
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent-green" />
              ЗАЩИЩЕНО
            </Pill>
          ) : undefined
        }
      />

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-7 pb-8">
        {/* connect ring */}
        <button
          onClick={onToggle}
          disabled={!active}
          className="relative flex h-[280px] w-[280px] items-center justify-center disabled:opacity-50"
        >
          <svg viewBox="0 0 280 280" className="absolute inset-0 h-full w-full">
            <defs>
              <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4d7cfe" />
                <stop offset="100%" stopColor="#34d399" />
              </linearGradient>
            </defs>
            <circle cx="140" cy="140" r="120" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
            <circle
              cx="140"
              cy="140"
              r="120"
              fill="none"
              stroke={connected ? 'url(#ring)' : error ? '#f56565' : 'rgba(255,255,255,0.12)'}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={connecting ? '120 754' : undefined}
              className={cn('origin-center transition-all duration-500', connecting && 'animate-[ring-spin_1.1s_linear_infinite]')}
              style={{ transformBox: 'fill-box' }}
            />
          </svg>

          <div
            className={cn(
              'flex h-[200px] w-[200px] flex-col items-center justify-center rounded-full transition-all duration-300',
              connected
                ? 'bg-accent-green/10 animate-glow'
                : error
                  ? 'bg-accent-red/10'
                  : 'bg-bg-panel hover:bg-bg-elevated'
            )}
          >
            <PowerIcon
              width={56}
              height={56}
              className={cn(
                'transition-colors',
                connected ? 'text-accent-green' : connecting ? 'text-accent-amber' : error ? 'text-accent-red' : 'text-text-muted'
              )}
            />
            <div className="mt-3 text-sm font-semibold text-text-primary">
              {connected ? 'Подключено' : connecting ? 'Подключение…' : 'Отключено'}
            </div>
            {connected && <div className="mt-1 font-mono text-sm text-accent-green">{elapsed}</div>}
          </div>
        </button>

        {/* active server card */}
        <div className="mt-8 flex w-full max-w-lg items-center gap-3 rounded-2xl border border-border-default bg-bg-panel px-4 py-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-elevated font-mono text-xs font-bold text-accent-blue-bright">
            {flag}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-text-primary">
              {active?.name ?? 'Сервер не выбран'}
            </div>
            <div className="truncate font-mono text-[11px] text-text-muted">
              {active ? `${PROTO_LABEL[active.protocol] ?? active.protocol} · ${active.server}` : 'Добавьте подписку'}
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setPage('servers')}>
            Сменить
          </Button>
        </div>

        {/* stats */}
        <div className="mt-4 grid w-full max-w-lg grid-cols-4 gap-3">
          <Stat label="Загрузка" value={formatSpeed(traffic.downloadSpeed)} accent="green" />
          <Stat label="Отдача" value={formatSpeed(traffic.uploadSpeed)} accent="blue" />
          <Stat label="Принято" value={formatBytes(traffic.totalDownload)} />
          <Stat label="Протокол" value={active ? (active.protocol === 'hysteria2' ? 'HY2' : active.protocol.toUpperCase()) : '—'} />
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'green' | 'blue' }) {
  return (
    <div className="rounded-2xl border border-border-default bg-bg-panel px-3 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-sm font-semibold',
          accent === 'green' ? 'text-accent-green' : accent === 'blue' ? 'text-accent-blue-bright' : 'text-text-primary'
        )}
      >
        {value}
      </div>
    </div>
  )
}
