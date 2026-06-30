import { CloseIcon, MaximizeIcon, MinimizeIcon } from './icons'

export function TitleBar() {
  return (
    <header className="drag-region flex h-10 items-center justify-end px-2">
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
      className={`flex h-8 w-10 items-center justify-center rounded-lg text-text-muted transition-colors ${
        danger ? 'hover:bg-accent-red hover:text-white' : 'hover:bg-bg-elevated hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}
