import type { RoutingMode } from '@shared/types'
import { useSettings } from '../store/settingsStore'
import { useConnection } from '../store/connectionStore'
import { toast } from '../store/toastStore'
import { errorText } from '../lib/format'
import { cn } from '../lib/cn'
import { DirectIcon, ShieldIcon, SplitIcon } from './icons'

export const ROUTING_MODES: {
  key: RoutingMode
  label: string
  hint: string
  Icon: typeof SplitIcon
}[] = [
  { key: 'rule', label: 'По правилам', hint: 'Как настроено на странице «Правила»', Icon: SplitIcon },
  { key: 'global', label: 'Весь трафик', hint: 'Всё через VPN, кроме локальной сети', Icon: ShieldIcon },
  { key: 'direct', label: 'Напрямую', hint: 'VPN не используется, всё идёт напрямую', Icon: DirectIcon }
]

const ROW = 34 // px, keeps the sliding highlight aligned with the rows

/** «Режим трафика» — one click, applied on the fly (no reconnect). */
export function ModeSwitch() {
  const settings = useSettings((s) => s.settings)
  const setRoutingMode = useSettings((s) => s.setRoutingMode)
  const connected = useConnection((s) => s.state === 'connected')
  const mode = settings?.routingMode ?? 'rule'
  const index = ROUTING_MODES.findIndex((m) => m.key === mode)

  const pick = async (m: RoutingMode) => {
    if (m === mode) return
    try {
      await setRoutingMode(m)
      if (connected) toast(`Режим: ${ROUTING_MODES.find((x) => x.key === m)?.label}`, 'success')
    } catch (e) {
      toast(`Не удалось сменить режим: ${errorText(e)}`, 'error')
    }
  }

  return (
    <div className="rounded-2xl border border-border-subtle bg-bg-panel/70 p-1.5">
      <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-faint">
        Режим трафика
      </div>
      <div className="relative" role="radiogroup" aria-label="Режим трафика">
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 rounded-xl bg-accent-green/10 ring-1 ring-inset ring-accent-green/35 transition-transform duration-300 ease-spring"
          style={{ height: ROW, transform: `translateY(${Math.max(0, index) * ROW}px)` }}
        />
        {ROUTING_MODES.map(({ key, label, hint, Icon }) => {
          const active = key === mode
          return (
            <button
              key={key}
              role="radio"
              aria-checked={active}
              title={hint}
              onClick={() => void pick(key)}
              style={{ height: ROW }}
              className={cn(
                'relative flex w-full items-center gap-2.5 rounded-xl px-2.5 text-[13px] font-medium transition-colors duration-200',
                active ? 'text-accent-green' : 'text-text-muted hover:text-text-primary'
              )}
            >
              <Icon width={16} height={16} />
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
