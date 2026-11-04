import { useEffect, useState } from 'react'
import { useConnection } from '../store/connectionStore'
import { useSubscription } from '../store/subscriptionStore'
import { useServers } from '../store/serversStore'
import { useSettings } from '../store/settingsStore'
import { useNav } from '../store/navStore'
import { openLink, useLinks } from '../hooks/useLinks'
import { ROUTING_MODES } from '../components/ModeSwitch'
import { ServerPicker } from '../components/ServerPicker'
import { Button } from '../components/ui'
import {
  AlertIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CardIcon,
  ExternalIcon,
  MegaphoneIcon,
  PowerIcon,
  SupportIcon
} from '../components/icons'
import {
  daysLeft,
  formatBytes,
  formatClock,
  formatDate,
  formatDays,
  formatSpeed,
  plural
} from '../lib/format'
import { cn } from '../lib/cn'

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function HomePage() {
  const { data, loaded, load } = useSubscription()
  const loadActive = useServers((s) => s.loadActive)
  const test = useServers((s) => s.test)
  const hasServers = !!data?.servers.length

  useEffect(() => {
    void load()
    void loadActive()
  }, [load, loadActive])

  // latency for the server bar (at most once a minute, see serversStore)
  useEffect(() => {
    if (hasServers) void test()
  }, [hasServers, test])

  return (
    <div className="mx-auto flex h-full w-full max-w-[760px] flex-col gap-5 px-7 pb-6 pt-2">
      {data?.announce && <Announcement text={data.announce} />}
      {loaded && <ProfileCard />}
      <div className="flex min-h-[300px] flex-1 flex-col items-center justify-center">
        <ConnectHero hasServers={hasServers} />
      </div>
      <ServerPicker />
    </div>
  )
}

// --- announcement ------------------------------------------------------------

function Announcement({ text }: { text: string }) {
  const [hidden, setHidden] = useState(false)
  if (hidden) return null
  return (
    <div className="animate-fade flex items-start gap-3 rounded-2xl border border-accent-blue/30 bg-accent-blue/10 px-4 py-3">
      <MegaphoneIcon width={18} height={18} className="mt-0.5 shrink-0 text-accent-blue-bright" />
      <p className="min-w-0 flex-1 whitespace-pre-line text-[13px] leading-relaxed text-text-secondary select-text">
        {text}
      </p>
      <button
        onClick={() => setHidden(true)}
        className="shrink-0 rounded-md px-1.5 text-xs text-text-muted hover:text-text-primary"
        title="Скрыть"
      >
        ✕
      </button>
    </div>
  )
}

// --- subscription profile ----------------------------------------------------

function ProfileCard() {
  const data = useSubscription((s) => s.data)
  const setPage = useNav((s) => s.setPage)
  const { renewUrl } = useLinks()

  if (!data) {
    return (
      <div className="animate-fade flex items-center gap-4 rounded-card border border-border-default bg-bg-panel px-5 py-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-green/10 text-accent-green">
          <CardIcon width={20} height={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-primary">Добавьте подписку</div>
          <div className="text-xs text-text-muted">
            Вставьте ссылку из бота CipherWay — серверы появятся автоматически.
          </div>
        </div>
        <Button size="sm" onClick={() => setPage('subscription')}>
          Добавить
        </Button>
      </div>
    )
  }

  const info = data.userInfo
  const used = (info?.upload ?? 0) + (info?.download ?? 0)
  const total = info?.total ?? 0
  const left = Math.max(0, total - used)
  const days = daysLeft(info?.expire)
  const expired = !!info?.expire && info.expire * 1000 <= Date.now()
  const soon = !expired && days !== null && days <= 3
  const lowTraffic = total > 0 && left / total < 0.1

  return (
    <div className="animate-fade rounded-card border border-border-default bg-bg-panel p-4">
      <div className="flex items-center gap-3 px-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-text-primary">
              {data.title || 'CipherWay VPN'}
            </span>
            <StatusPill expired={expired} soon={soon} days={days} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPage('support')}>
            <SupportIcon width={15} height={15} />
            Поддержка
          </Button>
          {renewUrl && (
            <Button
              variant={soon || expired ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => openLink(renewUrl)}
            >
              Продлить
              <ExternalIcon width={13} height={13} />
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2.5">
        <Tile
          label="Трафика осталось"
          value={total ? formatBytes(left) : 'Безлимит'}
          sub={total ? `из ${formatBytes(total)}` : undefined}
          warn={lowTraffic}
          progress={total ? left / total : undefined}
        />
        <Tile
          label="Дней осталось"
          value={days === null ? '∞' : String(days)}
          sub={days === null ? 'бессрочно' : plural(days, 'день', 'дня', 'дней')}
          warn={soon || expired}
        />
        <Tile
          label="Истекает"
          value={info?.expire ? formatDate(info.expire).replace(/\s*г\.$/, '') : 'Никогда'}
          warn={soon || expired}
        />
      </div>

      {(soon || expired) && (
        <div
          className={cn(
            'mt-3 flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs',
            expired ? 'bg-accent-red/10 text-accent-red' : 'bg-accent-amber/10 text-accent-amber'
          )}
        >
          <AlertIcon width={15} height={15} className="shrink-0" />
          <span className="flex-1">
            {expired
              ? 'Подписка закончилась — VPN перестанет работать. Продлите её, чтобы продолжить.'
              : days === 0
                ? 'Подписка заканчивается сегодня. Продлите её, чтобы VPN не отключился.'
                : `Подписка заканчивается через ${formatDays(days ?? 0)}. Продлите её заранее.`}
          </span>
        </div>
      )}
    </div>
  )
}

function StatusPill({
  expired,
  soon,
  days
}: {
  expired: boolean
  soon: boolean
  days: number | null
}) {
  const [tone, text] = expired
    ? ['bg-accent-red/15 text-accent-red', 'истекла']
    : soon
      ? [
          'bg-accent-amber/15 text-accent-amber',
          days === 0 ? 'истекает сегодня' : `ещё ${formatDays(days ?? 0)}`
        ]
      : ['bg-accent-green/15 text-accent-green', 'активна']
  return (
    <span className={cn('shrink-0 rounded-pill px-2 py-0.5 text-[11px] font-medium', tone)}>
      {text}
    </span>
  )
}

function Tile({
  label,
  value,
  sub,
  warn,
  progress
}: {
  label: string
  value: string
  sub?: string
  warn?: boolean
  progress?: number
}) {
  return (
    <div className="rounded-xl bg-bg-panel-alt px-3.5 py-3">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className={cn(
            'truncate text-lg font-semibold tabular-nums',
            warn ? 'text-accent-amber' : 'text-text-primary'
          )}
        >
          {value}
        </span>
        {sub && <span className="truncate text-[11px] text-text-faint">{sub}</span>}
      </div>
      {progress !== undefined && (
        <div className="mt-2 h-1 overflow-hidden rounded-pill bg-bg-elevated">
          <div
            className={cn('h-full rounded-pill', warn ? 'bg-accent-amber' : 'bg-accent-green')}
            style={{ width: `${Math.max(2, Math.min(100, progress * 100))}%` }}
          />
        </div>
      )}
    </div>
  )
}

// --- the big button ----------------------------------------------------------

function ConnectHero({ hasServers }: { hasServers: boolean }) {
  const { state, message, traffic, connectedAt, connect, disconnect } = useConnection()
  const mode = useSettings((s) => s.settings?.routingMode ?? 'rule')
  const setPage = useNav((s) => s.setPage)
  const now = useNow(state === 'connected')

  const connected = state === 'connected'
  const connecting = state === 'connecting'
  const error = state === 'error'
  const modeMeta = ROUTING_MODES.find((m) => m.key === mode)

  const onToggle = () => {
    if (connected || connecting) void disconnect()
    else void connect()
  }

  return (
    <div className="flex flex-col items-center">
      <button
        onClick={onToggle}
        disabled={!hasServers && !connected && !connecting}
        aria-label={connected || connecting ? 'Отключить' : 'Подключить'}
        className="group relative flex h-[196px] w-[196px] items-center justify-center rounded-full outline-none transition-transform duration-300 ease-spring active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {/* soft halo */}
        <span
          className={cn(
            'absolute inset-0 rounded-full transition-opacity duration-500',
            connected ? 'animate-glow opacity-100' : 'opacity-0'
          )}
        />
        <svg viewBox="0 0 196 196" className="absolute inset-0 h-full w-full">
          <defs>
            <linearGradient id="cw-ring" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#4d7cfe" />
              <stop offset="100%" stopColor="#34d399" />
            </linearGradient>
          </defs>
          <circle
            cx="98"
            cy="98"
            r="90"
            fill="none"
            stroke="rgba(255,255,255,0.05)"
            strokeWidth="5"
          />
          <circle
            cx="98"
            cy="98"
            r="90"
            fill="none"
            stroke={
              connected
                ? 'url(#cw-ring)'
                : connecting
                  ? '#f5b942'
                  : error
                    ? '#f56565'
                    : 'rgba(52,211,153,0.22)'
            }
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={connecting ? '110 455' : undefined}
            className={cn(
              'origin-center transition-[stroke] duration-500',
              connecting && 'animate-[ring-spin_1.1s_linear_infinite]'
            )}
            style={{ transformBox: 'fill-box' }}
          />
        </svg>
        <span
          className={cn(
            'flex h-[152px] w-[152px] flex-col items-center justify-center rounded-full border transition-all duration-300',
            connected
              ? 'border-accent-green/30 bg-accent-green/10'
              : error
                ? 'border-accent-red/30 bg-accent-red/5'
                : 'border-border-subtle bg-bg-panel group-hover:bg-bg-elevated'
          )}
        >
          <PowerIcon
            width={48}
            height={48}
            className={cn(
              'transition-colors duration-300',
              connected
                ? 'text-accent-green'
                : connecting
                  ? 'text-accent-amber'
                  : error
                    ? 'text-accent-red'
                    : 'text-text-muted group-hover:text-text-primary'
            )}
          />
          <span className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">
            {connected ? 'Отключить' : connecting ? 'Отмена' : 'Подключить'}
          </span>
        </span>
      </button>

      <div className="mt-5 text-center">
        <div
          className={cn(
            'text-lg font-semibold',
            connected ? 'text-accent-green' : error ? 'text-accent-red' : 'text-text-primary'
          )}
        >
          {connected
            ? 'Соединение защищено'
            : connecting
              ? 'Подключение…'
              : error
                ? 'Не удалось подключиться'
                : 'VPN выключен'}
        </div>

        {connected && (
          <div className="mt-1.5 flex items-center justify-center gap-3 text-xs text-text-muted">
            <span className="font-mono tabular-nums text-text-secondary">
              {formatClock(now - (connectedAt ?? now))}
            </span>
            <span className="h-1 w-1 rounded-full bg-text-faint" />
            <span>{modeMeta?.label}</span>
          </div>
        )}
        {error && message && (
          <div className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-accent-red/90">
            {message}{' '}
            <button
              onClick={() => setPage('logs')}
              className="text-text-muted underline-offset-2 hover:underline"
            >
              Логи
            </button>
          </div>
        )}
        {connecting && message && (
          <div className="animate-fade mt-1.5 text-xs text-accent-amber">{message}</div>
        )}
        {!connected && !connecting && !error && (
          <div className="mt-1.5 text-xs text-text-muted">
            {hasServers
              ? 'Нажмите на кнопку, чтобы подключиться'
              : 'Нет серверов — добавьте подписку'}
          </div>
        )}
      </div>

      <div
        className={cn(
          'mt-4 flex items-center gap-6 font-mono text-sm tabular-nums transition-opacity duration-300',
          connected ? 'opacity-100' : 'opacity-0'
        )}
      >
        <span className="flex items-center gap-1.5 text-accent-green">
          <ArrowDownIcon width={14} height={14} />
          {formatSpeed(traffic.downloadSpeed)}
        </span>
        <span className="flex items-center gap-1.5 text-accent-blue-bright">
          <ArrowUpIcon width={14} height={14} />
          {formatSpeed(traffic.uploadSpeed)}
        </span>
        <span className="text-xs text-text-faint">
          всего {formatBytes(traffic.totalDownload + traffic.totalUpload)}
        </span>
      </div>
    </div>
  )
}
