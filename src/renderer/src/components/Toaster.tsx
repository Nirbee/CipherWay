import { useToasts } from '../store/toastStore'
import { cn } from '../lib/cn'
import { AlertIcon, CheckIcon, InfoIcon } from './icons'

export function Toaster() {
  const { toasts, dismiss } = useToasts()
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[340px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          onClick={() => dismiss(t.id)}
          className={cn(
            'animate-toast pointer-events-auto flex cursor-pointer items-start gap-2.5 rounded-xl border bg-bg-elevated/95 px-3.5 py-3 text-left text-xs leading-snug text-text-secondary shadow-2xl backdrop-blur',
            t.tone === 'error'
              ? 'border-accent-red/40'
              : t.tone === 'success'
                ? 'border-status-ok/40'
                : 'border-border-default'
          )}
        >
          <span
            className={cn(
              'mt-px shrink-0',
              t.tone === 'error'
                ? 'text-accent-red'
                : t.tone === 'success'
                  ? 'text-status-ok'
                  : 'text-accent-blue-bright'
            )}
          >
            {t.tone === 'error' ? (
              <AlertIcon width={15} height={15} />
            ) : t.tone === 'success' ? (
              <CheckIcon width={15} height={15} />
            ) : (
              <InfoIcon width={15} height={15} />
            )}
          </span>
          <span className="min-w-0 flex-1 break-words">
            {t.text}
            {t.action && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  dismiss(t.id)
                  t.action?.run()
                }}
                className="mt-1.5 block rounded-lg font-medium text-accent-blue-bright hover:underline"
              >
                {t.action.label}
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
