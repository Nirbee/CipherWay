import { CloseIcon, MaximizeIcon, MinimizeIcon } from './icons'
import { useNav, type PageKey } from '../store/navStore'

const TITLES: Record<PageKey, string> = {
  home: 'Главная',
  servers: 'Серверы',
  subscription: 'Подписка',
  connectors: 'Приложения',
  rules: 'Правила',
  logs: 'Логи',
  settings: 'Настройки'
}

export function TitleBar() {
  const page = useNav((s) => s.page)

  return (
    <header className="drag-region flex h-11 items-center justify-between border-b border-border-default bg-bg-app pl-5 pr-2">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-sm font-semibold tracking-wide text-text-primary">
          CipherWay
        </span>
        <span className="text-sm text-text-muted">{TITLES[page]}</span>
      </div>

      <div className="no-drag flex items-center">
        <WinButton onClick={() => window.api.window.minimize()} label="Свернуть">
          <MinimizeIcon />
        </WinButton>
        <WinButton onClick={() => window.api.window.maximize()} label="Развернуть">
          <MaximizeIcon />
        </WinButton>
        <WinButton onClick={() => window.api.window.close()} label="Закрыть" danger>
          <CloseIcon />
        </WinButton>
      </div>
    </header>
  )
}

function WinButton({
  children,
  onClick,
  label,
  danger
}: {
  children: React.ReactNode
  onClick: () => void
  label: string
  danger?: boolean
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className={`flex h-8 w-11 items-center justify-center rounded-md text-text-muted transition-colors ${
        danger ? 'hover:bg-accent-red hover:text-white' : 'hover:bg-bg-elevated hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}
