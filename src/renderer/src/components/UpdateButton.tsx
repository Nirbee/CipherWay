import { useUpdater } from '../store/updaterStore'
import { updateButtonView } from '../lib/updateButton'
import { cn } from '../lib/cn'
import { UpdateIcon } from './icons'

/**
 * The one update control: bottom of the sidebar and «Настройки → Обновления».
 * Quiet «Версия актуальна» most of the time; green with a pulsing dot when a
 * version is found; «Загрузка 42%» with a bar; «Перезапустить и обновить».
 */
export function UpdateButton({ className }: { className?: string }) {
  const state = useUpdater((s) => s.state)
  const check = useUpdater((s) => s.check)
  const download = useUpdater((s) => s.download)
  const install = useUpdater((s) => s.install)
  const v = updateButtonView(state)

  const onClick = (): void => {
    if (v.action === 'check') check()
    else if (v.action === 'download') download()
    else if (v.action === 'install') install()
  }

  if (v.tone === 'progress') {
    return (
      <div
        className={cn(
          'animate-fade rounded-xl border border-accent-green/35 bg-accent-green/[0.07] px-3 py-2',
          className
        )}
        role="status"
        aria-live="polite"
      >
        <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-accent-green">
          <UpdateIcon width={16} height={16} className="animate-pulse" />
          <span className="flex-1">{v.label}</span>
          {v.tag && <span className="font-mono text-[10px] opacity-70">{v.tag}</span>}
        </div>
        <div className="h-1 overflow-hidden rounded-pill bg-bg-elevated">
          <div
            className="h-full rounded-pill bg-accent-green transition-all duration-300"
            style={{ width: `${v.percent}%` }}
          />
        </div>
      </div>
    )
  }

  if (v.tone === 'accent') {
    return (
      <button
        onClick={onClick}
        disabled={!v.action}
        title={
          v.action === 'install'
            ? 'VPN отключится, приложение закроется, установится новая версия и запустится снова'
            : v.action === 'download'
              ? 'Скачать обновление'
              : undefined
        }
        className={cn(
          'relative flex min-h-10 w-full flex-col justify-center rounded-xl border border-accent-green/45 bg-accent-green/[0.12] px-3 py-1.5 text-left text-[12.5px] font-semibold leading-tight text-accent-green transition-colors hover:bg-accent-green/20 disabled:cursor-default disabled:opacity-80',
          v.pulse ? 'animate-update-glow' : 'animate-fade',
          v.working && 'animate-pulse',
          className
        )}
      >
        {/* no icon: «Перезапустить и обновить» has to fit the 216 px sidebar */}
        {v.pulse && (
          <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
            <span className="absolute h-full w-full animate-ping rounded-full bg-accent-green opacity-75" />
            <span className="relative h-2.5 w-2.5 rounded-full border-2 border-bg-sidebar bg-accent-green" />
          </span>
        )}
        <span>{v.label}</span>
        {v.tag && <span className="font-mono text-[10px] font-normal opacity-70">{v.tag}</span>}
      </button>
    )
  }

  return (
    <button
      onClick={onClick}
      disabled={!v.action}
      title={v.action === 'check' ? 'Проверить обновления сейчас' : undefined}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left text-xs font-medium transition-colors disabled:cursor-default',
        v.tone === 'error'
          ? 'text-accent-red hover:bg-accent-red/10'
          : 'text-text-faint hover:bg-bg-elevated/60 hover:text-text-primary',
        className
      )}
    >
      <UpdateIcon width={15} height={15} className={cn(v.working && 'animate-pulse')} />
      {v.label}
    </button>
  )
}
