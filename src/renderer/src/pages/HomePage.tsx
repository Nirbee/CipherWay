import { useEffect, useMemo } from 'react'
import { useConnection } from '../store/connectionStore'
import { useSubscription } from '../store/subscriptionStore'
import { useServers } from '../store/serversStore'
import { PowerIcon } from '../components/icons'
import { formatBytes, formatSpeed } from '../lib/format'
import { cn } from '../lib/cn'

export function HomePage() {
  const { state, traffic, connect, disconnect } = useConnection()
  const { data, load } = useSubscription()
  const { activeId, loadActive } = useServers()

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

  const label = connected
    ? 'Подключено'
    : connecting
      ? 'Подключение…'
      : error
        ? 'Ошибка'
        : 'Отключено'

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      {/* connect button */}
      <button
        onClick={onToggle}
        disabled={!active}
        className={cn(
          'group relative flex h-44 w-44 items-center justify-center rounded-full transition-all disabled:opacity-40',
          connected
            ? 'bg-accent-green/15'
            : error
              ? 'bg-accent-red/15'
              : 'bg-bg-panel hover:bg-bg-elevated'
        )}
      >
        <span
          className={cn(
            'absolute inset-0 rounded-full border-2',
            connected
              ? 'border-accent-green shadow-[0_0_30px_rgba(52,211,153,0.35)]'
              : connecting
                ? 'animate-pulse border-accent-amber'
                : error
                  ? 'border-accent-red'
                  : 'border-border-default group-hover:border-accent-blue'
          )}
        />
        <PowerIcon
          width={64}
          height={64}
          className={cn(
            connected
              ? 'text-accent-green'
              : connecting
                ? 'text-accent-amber'
                : error
                  ? 'text-accent-red'
                  : 'text-text-muted group-hover:text-accent-blue'
          )}
        />
      </button>

      <div className="mt-6 text-center">
        <div
          className={cn(
            'text-lg font-semibold',
            connected ? 'text-accent-green' : error ? 'text-accent-red' : 'text-text-primary'
          )}
        >
          {label}
        </div>
        <div className="mt-1 text-sm text-text-muted">
          {active ? active.name : 'Нет доступных серверов — добавьте подписку'}
        </div>
      </div>

      {/* live speed + total traffic */}
      <div className="mt-10 grid w-full max-w-md grid-cols-2 gap-3">
        <Stat label="Загрузка" value={formatSpeed(traffic.downloadSpeed)} accent="green" />
        <Stat label="Выгрузка" value={formatSpeed(traffic.uploadSpeed)} accent="blue" />
        <Stat label="Принято" value={formatBytes(traffic.totalDownload)} />
        <Stat label="Отправлено" value={formatBytes(traffic.totalUpload)} />
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  accent
}: {
  label: string
  value: string
  accent?: 'green' | 'blue'
}) {
  return (
    <div className="rounded-card border border-border-default bg-bg-panel px-4 py-3">
      <div className="text-xs text-text-muted">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-lg font-semibold',
          accent === 'green'
            ? 'text-accent-green'
            : accent === 'blue'
              ? 'text-accent-blue-bright'
              : 'text-text-primary'
        )}
      >
        {value}
      </div>
    </div>
  )
}
