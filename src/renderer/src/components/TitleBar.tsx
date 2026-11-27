import { CloseIcon, MaximizeIcon, MinimizeIcon } from './icons'
import { useDev } from '../store/devStore'
import { cn } from '../lib/cn'
import { useNewYear } from '../seasonal'

export function TitleBar() {
  const dev = useDev((s) => s.status.enabled)
  // the garland runs behind the buttons: a dark backing keeps them visible
  const newYear = useNewYear() !== 'off'
  return (
    <header className="drag-region relative z-[4] flex h-10 items-center justify-end gap-2 px-2">
      {dev && (
        <span
          className="mr-auto ml-5 rounded-md bg-accent-blue px-1.5 py-px font-mono text-[10px] font-bold tracking-wider text-on-accent"
          title="Включён DevVersion — тестовая версия со сбором диагностики (Настройки)"
        >
          DEV
        </span>
      )}
      <div
        className={cn(
          'no-drag flex items-center',
          newYear && 'rounded-xl bg-bg-app/75 shadow-[0_0_12px_6px_rgba(10,15,28,0.55)]'
        )}
      >
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
        danger
          ? 'hover:bg-accent-red hover:text-white'
          : 'hover:bg-bg-elevated hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}
