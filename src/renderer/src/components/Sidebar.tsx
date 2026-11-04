import { useNav, type PageKey } from '../store/navStore'
import { useConnection } from '../store/connectionStore'
import { useUpdater } from '../store/updaterStore'
import { useSupport } from '../store/supportStore'
import { cn } from '../lib/cn'
import {
  ActivityIcon,
  CardIcon,
  HomeIcon,
  LogsIcon,
  RulesIcon,
  ServerIcon,
  SettingsIcon,
  SupportIcon,
  UpdateIcon
} from './icons'
import { ModeSwitch } from './ModeSwitch'
import shield from '../assets/logo-shield.png'

const NAV: { key: PageKey; label: string; Icon: typeof HomeIcon }[] = [
  { key: 'home', label: 'Главная', Icon: HomeIcon },
  { key: 'servers', label: 'Серверы', Icon: ServerIcon },
  { key: 'connections', label: 'Подключения', Icon: ActivityIcon },
  { key: 'rules', label: 'Правила', Icon: RulesIcon },
  { key: 'subscription', label: 'Подписка', Icon: CardIcon },
  { key: 'support', label: 'Поддержка', Icon: SupportIcon },
  { key: 'logs', label: 'Логи', Icon: LogsIcon },
  { key: 'settings', label: 'Настройки', Icon: SettingsIcon }
]

const STATE_TEXT = {
  connected: 'Защищено',
  connecting: 'Подключение…',
  disconnected: 'Не подключено',
  error: 'Ошибка'
} as const

export function Sidebar() {
  const { page, setPage } = useNav()
  const state = useConnection((s) => s.state)
  const unread = useSupport((s) => s.view?.unread ?? 0)

  return (
    <nav className="drag-region flex w-[216px] shrink-0 flex-col border-r border-border-subtle bg-bg-sidebar">
      {/* brand + live state */}
      <div className="flex items-center gap-3 px-5 pb-5 pt-5">
        <div className="relative">
          <img src={shield} alt="" className="h-9 w-9 rounded-xl object-cover" />
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-bg-sidebar transition-colors',
              state === 'connected'
                ? 'bg-accent-green'
                : state === 'connecting'
                  ? 'animate-pulse bg-accent-amber'
                  : state === 'error'
                    ? 'bg-accent-red'
                    : 'bg-text-faint'
            )}
          />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-text-primary">CipherWay</div>
          <div
            className={cn(
              'text-[11px]',
              state === 'connected'
                ? 'text-accent-green'
                : state === 'error'
                  ? 'text-accent-red'
                  : 'text-text-muted'
            )}
          >
            {STATE_TEXT[state]}
          </div>
        </div>
      </div>

      {/* nav */}
      <div className="no-drag flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
        {NAV.map(({ key, label, Icon }) => {
          const active = page === key
          return (
            <button
              key={key}
              onClick={() => setPage(key)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group relative flex h-[38px] shrink-0 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors duration-200',
                active
                  ? 'bg-accent-green/10 text-text-primary'
                  : 'text-text-muted hover:bg-bg-elevated/60 hover:text-text-primary'
              )}
            >
              <span
                className={cn(
                  'absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-green transition-all duration-300 ease-spring',
                  active ? 'opacity-100' : 'h-0 opacity-0'
                )}
              />
              <Icon
                width={18}
                height={18}
                className={cn(
                  'transition-transform duration-200 group-hover:scale-110',
                  active && 'text-accent-green'
                )}
              />
              <span className="flex-1 text-left">{label}</span>
              {key === 'support' && unread > 0 && (
                <span
                  className="animate-fade flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-accent-green px-1.5 text-[10.5px] font-bold text-bg-sidebar"
                  title="Новые ответы поддержки"
                >
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="no-drag space-y-2 p-3">
        <ModeSwitch />
        <UpdateButton onOpenSettings={() => setPage('settings')} />
      </div>
    </nav>
  )
}

function UpdateButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { phase, version, percent, check, download, install } = useUpdater()

  if (phase === 'available' || phase === 'downloaded') {
    const ready = phase === 'downloaded'
    return (
      <button
        onClick={() => {
          if (ready) install()
          else {
            download()
            onOpenSettings()
          }
        }}
        className="animate-fade flex h-10 w-full items-center gap-2.5 rounded-xl border border-accent-green/40 bg-accent-green/10 px-3 text-left text-[13px] font-medium text-accent-green transition-colors hover:bg-accent-green/20"
      >
        <span className="relative flex h-5 w-5 items-center justify-center">
          <UpdateIcon width={17} height={17} />
          {!ready && (
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-ping rounded-full bg-accent-green" />
          )}
        </span>
        <span className="flex-1">{ready ? 'Установить' : 'Обновить'}</span>
        {version && <span className="font-mono text-[10px] opacity-70">v{version}</span>}
      </button>
    )
  }

  if (phase === 'downloading') {
    return (
      <div className="rounded-xl border border-accent-blue/40 bg-accent-blue/10 px-3 py-2">
        <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-accent-blue-bright">
          <UpdateIcon width={15} height={15} className="animate-pulse" />
          Загрузка {percent}%
        </div>
        <div className="h-1 overflow-hidden rounded-pill bg-bg-elevated">
          <div
            className="h-full rounded-pill bg-accent-blue transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    )
  }

  const label =
    phase === 'checking'
      ? 'Проверка…'
      : phase === 'not-available'
        ? 'Версия актуальна'
        : phase === 'error'
          ? 'Повторить проверку'
          : 'Проверить обновления'

  return (
    <button
      onClick={check}
      disabled={phase === 'checking'}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left text-xs font-medium transition-colors',
        phase === 'error'
          ? 'text-accent-red hover:bg-accent-red/10'
          : 'text-text-faint hover:bg-bg-elevated/60 hover:text-text-primary'
      )}
    >
      <UpdateIcon width={15} height={15} className={cn(phase === 'checking' && 'animate-pulse')} />
      {label}
    </button>
  )
}
