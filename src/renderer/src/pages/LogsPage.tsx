import { useEffect, useRef } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/ui'
import { useLogs } from '../store/logsStore'
import { cn } from '../lib/cn'

const LEVEL_COLOR: Record<string, string> = {
  info: 'text-text-tertiary',
  warn: 'text-accent-amber',
  error: 'text-accent-red',
  debug: 'text-text-faint'
}

export function LogsPage() {
  const { entries, clear } = useLogs()
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  const copyAll = () => {
    const text = entries
      .map((e) => `${new Date(e.ts).toISOString()} [${e.source}/${e.level}] ${e.message}`)
      .join('\n')
    void navigator.clipboard.writeText(text)
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Логи"
        subtitle="Вывод ядра sing-box и приложения"
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={copyAll} disabled={entries.length === 0}>
              Копировать
            </Button>
            <Button variant="ghost" size="sm" onClick={clear} disabled={entries.length === 0}>
              Очистить
            </Button>
          </>
        }
      />

      <div className="mx-6 mb-6 min-h-0 flex-1 overflow-y-auto rounded-card border border-border-default bg-bg-panel-alt p-3">
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            Логи появятся после подключения
          </div>
        ) : (
          <div className="space-y-0.5 font-mono text-[11.5px] leading-relaxed">
            {entries.map((e, i) => (
              <div key={i} className="flex gap-2 select-text">
                <span className="shrink-0 text-text-faint">
                  {new Date(e.ts).toLocaleTimeString('ru-RU')}
                </span>
                <span className="shrink-0 uppercase text-text-muted">[{e.source}]</span>
                <span className={cn('whitespace-pre-wrap break-all', LEVEL_COLOR[e.level])}>
                  {e.message}
                </span>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>
    </div>
  )
}
