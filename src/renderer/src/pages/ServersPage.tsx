import { useEffect } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Button, Card, Pill } from '../components/ui'
import { CheckIcon } from '../components/icons'
import { useSubscription } from '../store/subscriptionStore'
import { useServers } from '../store/serversStore'
import { useNav } from '../store/navStore'
import { cn } from '../lib/cn'

const PROTO_LABEL: Record<string, string> = {
  vless: 'VLESS',
  hysteria2: 'Hysteria2',
  vmess: 'VMess'
}

function latencyTone(ms: number | null | undefined): 'green' | 'amber' | 'red' | 'neutral' {
  if (ms == null) return 'red'
  if (ms < 150) return 'green'
  if (ms < 400) return 'amber'
  return 'red'
}

export function ServersPage() {
  const { data, load } = useSubscription()
  const { pings, pinging, activeId, ping, setActive, loadActive } = useServers()
  const setPage = useNav((s) => s.setPage)

  useEffect(() => {
    void load()
    void loadActive()
  }, [load, loadActive])

  const outbounds = data?.outbounds ?? []

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        overline="Локации"
        title="Серверы"
        subtitle={data ? `${outbounds.length} нод в подписке` : 'Подписка не загружена'}
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => ping()}
            disabled={pinging || outbounds.length === 0}
          >
            {pinging ? 'Пинг…' : 'Проверить пинг'}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {outbounds.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-3 text-sm text-text-muted">
            Нет серверов. Добавьте подписку Remnawave.
            <Button size="sm" onClick={() => setPage('subscription')}>
              Перейти к подписке
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {outbounds.map((o) => {
              const isActive = o.id === activeId
              const ms = pings[o.id]
              return (
                <Card
                  key={o.id}
                  hover
                  highlighted={isActive}
                  className="flex cursor-pointer items-center gap-3 px-4 py-3"
                  onClick={() => setActive(o.id)}
                >
                  <div
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded-full border',
                      isActive ? 'border-accent-blue bg-accent-blue text-white' : 'border-border-default text-transparent'
                    )}
                  >
                    <CheckIcon width={14} height={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-text-primary">{o.name}</div>
                    <div className="truncate font-mono text-[11px] text-text-faint">
                      {o.server}:{o.port}
                    </div>
                  </div>
                  <Pill tone="blue">{PROTO_LABEL[o.protocol] ?? o.protocol}</Pill>
                  {o.id in pings && (
                    <Pill tone={latencyTone(ms)} mono>
                      {ms == null ? 'timeout' : `${ms} ms`}
                    </Pill>
                  )}
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
