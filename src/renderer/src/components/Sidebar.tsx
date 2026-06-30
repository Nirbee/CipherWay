import { useEffect } from 'react'
import { useNav, type PageKey } from '../store/navStore'
import { useConnection } from '../store/connectionStore'
import { useUpdater } from '../store/updaterStore'
import { useSubscription } from '../store/subscriptionStore'
import { daysLeft } from '../lib/format'
import { cn } from '../lib/cn'
import {
  CardIcon,
  HomeIcon,
  LogsIcon,
  RulesIcon,
  ServerIcon,
  SettingsIcon,
  UpdateIcon
} from './icons'
import shield from '../assets/logo-shield.png'

const NAV: { key: PageKey; label: string; Icon: typeof HomeIcon }[] = [
  { key: 'home', label: 'Подключение', Icon: HomeIcon },
  { key: 'servers', label: 'Серверы', Icon: ServerIcon },
  { key: 'rules', label: 'Правила', Icon: RulesIcon },
  { key: 'logs', label: 'Логи', Icon: LogsIcon },
  { key: 'subscription', label: 'Подписка', Icon: CardIcon },
  { key: 'settings', label: 'Настройки', Icon: SettingsIcon }
]

export function Sidebar() {
  const { page, setPage } = useNav()
  const { state } = useConnection()
  const { data, load } = useSubscription()

  useEffect(() => {
    void load()
  }, [load])

  const connected = state === 'connected'
  const connecting = state === 'connecting'
  const left = daysLeft(data?.userInfo?.expire)

  return (
    <nav className="drag-region flex w-[228px] shrink-0 flex-col border-r border-border-default bg-bg-sidebar">
      {/* brand */}
      <div className="flex items-center gap-3 px-5 pb-4 pt-5">
        <img src={shield} alt="CipherWay" className="h-9 w-9 rounded-xl object-cover" />
        <div className="leading-tight">
          <div className="text-sm font-semibold text-text-primary">CipherWay</div>
          <div className="font-mono text-[10px] text-text-muted">
            {connected ? 'Secure' : 'Ready'}
          </div>
        </div>
      </div>

      {/* nav */}
      <div className="no-drag flex flex-1 flex-col gap-1 px-3">
        {NAV.map(({ key, label, Icon }) => {
          const active = page === key
          return (
            <button
              key={key}
              onClick={() => setPage(key)}
              className={cn(
                'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
                active
                  ? 'bg-accent-blue text-white shadow-[0_4px_14px_rgba(77,124,254,0.35)]'
                  : 'text-text-muted hover:bg-bg-elevated hover:text-text-primary'
              )}
            >
              <Icon
                width={18}
                height={18}
                className={cn('transition-transform duration-200 group-hover:scale-110')}
              />
              {label}
            </button>
          )
        })}
      </div>

      {/* update button — always visible, above the CipherWay VPN card */}
      <div className="no-drag px-3">
        <UpdateButton onOpenSettings={() => setPage('settings')} />
      </div>

      {/* status / subscription card */}
      <div className="no-drag p-3 pt-1">
        <button
          onClick={() => setPage('subscription')}
          className="flex w-full items-center gap-3 rounded-2xl border border-border-default bg-bg-panel px-3 py-3 text-left transition-colors hover:bg-bg-elevated"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-elevated font-mono text-xs font-semibold text-accent-blue-bright">
            CW
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-xs font-semibold text-text-primary">
              {data?.rawTitle || 'CipherWay VPN'}
            </div>
            <div className="font-mono text-[10px] text-text-muted">
              {left != null ? `осталось ${left} дн.` : data ? 'активна' : 'нет подписки'}
            </div>
          </div>
          <span
            className={cn(
              'h-2.5 w-2.5 shrink-0 rounded-full',
              connected
                ? 'bg-accent-green shadow-[0_0_8px_2px_rgba(52,211,153,0.6)]'
                : connecting
                  ? 'animate-pulse bg-accent-amber'
                  : 'bg-text-faint'
            )}
          />
        </button>
      </div>
    </nav>
  )
}

function UpdateButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { phase, version, percent, check, download, install } = useUpdater()

  // green, attention-grabbing states
  if (phase === 'available') {
    return (
      <button
        onClick={() => {
          download()
          onOpenSettings()
        }}
        className="animate-fade mb-2 flex w-full items-center gap-2.5 rounded-xl border border-accent-green/40 bg-accent-green/10 px-3 py-2.5 text-left text-sm font-medium text-accent-green transition-colors hover:bg-accent-green/20"
      >
        <span className="relative flex h-5 w-5 items-center justify-center">
          <UpdateIcon width={18} height={18} />
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-ping rounded-full bg-accent-green" />
        </span>
        <span className="flex flex-col leading-tight">
          <span>Обновить</span>
          {version && <span className="font-mono text-[10px] opacity-70">v{version}</span>}
        </span>
      </button>
    )
  }

  if (phase === 'downloading') {
    return (
      <div className="mb-2 rounded-xl border border-accent-blue/40 bg-accent-blue/10 px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-2 text-sm font-medium text-accent-blue-bright">
          <UpdateIcon width={18} height={18} className="animate-pulse" />
          Загрузка {percent}%
        </div>
        <div className="h-1.5 overflow-hidden rounded-pill bg-bg-elevated">
          <div className="h-full rounded-pill bg-accent-blue transition-all" style={{ width: `${percent}%` }} />
        </div>
      </div>
    )
  }

  if (phase === 'downloaded') {
    return (
      <button
        onClick={install}
        className="animate-fade mb-2 flex w-full items-center gap-2.5 rounded-xl border border-accent-green/40 bg-accent-green/10 px-3 py-2.5 text-left text-sm font-medium text-accent-green transition-colors hover:bg-accent-green/20"
      >
        <UpdateIcon width={18} height={18} />
        <span className="flex flex-col leading-tight">
          <span>Установить</span>
          {version && <span className="font-mono text-[10px] opacity-70">v{version}</span>}
        </span>
      </button>
    )
  }

  // neutral states: idle / checking / not-available / error
  const label =
    phase === 'checking'
      ? 'Проверка…'
      : phase === 'not-available'
        ? 'Актуальная версия'
        : phase === 'error'
          ? 'Повторить проверку'
          : 'Проверить обновления'

  return (
    <button
      onClick={check}
      disabled={phase === 'checking'}
      className={cn(
        'mb-2 flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm font-medium transition-colors',
        phase === 'error'
          ? 'border-accent-red/40 text-accent-red hover:bg-accent-red/10'
          : 'border-border-default text-text-muted hover:bg-bg-elevated hover:text-text-primary'
      )}
    >
      <UpdateIcon width={18} height={18} className={cn(phase === 'checking' && 'animate-pulse')} />
      {label}
    </button>
  )
}
