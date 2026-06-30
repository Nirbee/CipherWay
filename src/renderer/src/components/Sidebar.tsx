import { useNav, type PageKey } from '../store/navStore'
import { useConnection } from '../store/connectionStore'
import { useUpdater } from '../store/updaterStore'
import {
  AppsIcon,
  CardIcon,
  HomeIcon,
  LogsIcon,
  RulesIcon,
  ServerIcon,
  SettingsIcon
} from './icons'

const NAV: { key: PageKey; label: string; Icon: typeof HomeIcon }[] = [
  { key: 'home', label: 'Главная', Icon: HomeIcon },
  { key: 'servers', label: 'Серверы', Icon: ServerIcon },
  { key: 'subscription', label: 'Подписка', Icon: CardIcon },
  { key: 'connectors', label: 'Приложения', Icon: AppsIcon },
  { key: 'rules', label: 'Правила', Icon: RulesIcon },
  { key: 'logs', label: 'Логи', Icon: LogsIcon },
  { key: 'settings', label: 'Настройки', Icon: SettingsIcon }
]

export function Sidebar() {
  const { page, setPage } = useNav()
  const { state, globalMode, setGlobalMode } = useConnection()
  const updatePhase = useUpdater((s) => s.phase)
  const updateReady = updatePhase === 'available' || updatePhase === 'downloaded'

  const connected = state === 'connected'
  const connecting = state === 'connecting'

  return (
    <nav className="flex w-[72px] flex-col items-center border-r border-border-default bg-bg-sidebar py-3">
      <div className="flex flex-1 flex-col items-center gap-1">
        {NAV.map(({ key, label, Icon }) => {
          const active = page === key
          return (
            <button
              key={key}
              title={label}
              onClick={() => setPage(key)}
              className={`group relative flex h-12 w-12 items-center justify-center rounded-xl transition-colors ${
                active
                  ? 'bg-accent-blue/15 text-accent-blue'
                  : 'text-text-muted hover:bg-bg-elevated hover:text-text-primary'
              }`}
            >
              {active && (
                <span className="absolute left-0 h-6 w-[3px] -translate-x-3 rounded-full bg-accent-blue" />
              )}
              {key === 'settings' && updateReady && (
                <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent-green ring-2 ring-bg-sidebar" />
              )}
              <Icon />
            </button>
          )
        })}
      </div>

      {/* bottom block: connection mode + status indicator */}
      <div className="flex flex-col items-center gap-2 pt-2">
        <button
          onClick={() => setGlobalMode(!globalMode)}
          title={globalMode ? 'Глобальный режим' : 'Раздельный туннель'}
          className="flex h-12 w-12 flex-col items-center justify-center rounded-xl text-[9px] font-medium text-text-muted hover:bg-bg-elevated hover:text-text-primary"
        >
          <span className="text-base leading-none">{globalMode ? '🌐' : '⑂'}</span>
          <span className="mt-1">{globalMode ? 'Global' : 'Split'}</span>
        </button>

        <div
          title={connected ? 'Подключено' : connecting ? 'Подключение…' : 'Отключено'}
          className={`h-2.5 w-2.5 rounded-full ${
            connected
              ? 'bg-accent-green shadow-[0_0_8px_2px_rgba(52,211,153,0.6)]'
              : connecting
                ? 'animate-pulse bg-accent-amber'
                : 'bg-text-faint'
          }`}
        />
      </div>
    </nav>
  )
}
