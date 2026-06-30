import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Button, Card, Input, Pill } from '../components/ui'
import { CheckIcon } from '../components/icons'
import { useSubscription } from '../store/subscriptionStore'
import { daysLeft, formatBytes, formatDate } from '../lib/format'
import { cn } from '../lib/cn'

interface Plan {
  id: string
  title: string
  price: string
  period: string
  totalNote: string
  features: string[]
  best?: boolean
}

// Plan catalogue is illustrative; "Выбрать" opens the Remnawave payment page
// in the system browser (payments are never embedded in-app).
const PLANS: Plan[] = [
  {
    id: 'month',
    title: 'Месяц',
    price: '199 ₽',
    period: '/ мес',
    totalNote: '199 ₽ за 1 месяц',
    features: ['Безлимитный трафик', 'До 3 устройств', 'Все локации']
  },
  {
    id: 'year',
    title: 'Год',
    price: '1490 ₽',
    period: '/ год',
    totalNote: '124 ₽ / мес при оплате за год',
    features: ['Безлимитный трафик', 'До 5 устройств', 'Все локации', 'Приоритетная поддержка'],
    best: true
  },
  {
    id: 'biennial',
    title: '2 года',
    price: '2490 ₽',
    period: '/ 2 года',
    totalNote: '104 ₽ / мес при оплате за 2 года',
    features: ['Безлимитный трафик', 'До 10 устройств', 'Все локации', 'Приоритетная поддержка']
  }
]

export function SubscriptionPage() {
  const { data, loading, error, load, fetch, refresh } = useSubscription()
  const [url, setUrl] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (data?.url) setUrl(data.url)
  }, [data?.url])

  const paymentBase = useMemo(() => {
    try {
      return data?.url ? new URL(data.url).origin : null
    } catch {
      return null
    }
  }, [data?.url])

  const info = data?.userInfo
  const used = (info?.upload ?? 0) + (info?.download ?? 0)
  const total = info?.total ?? 0
  const left = daysLeft(info?.expire)

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader overline="Тарифы" title="Подписка" subtitle="Управление подпиской Remnawave" />

      <div className="space-y-5 px-6 pb-8">
        {/* subscription URL */}
        <Card className="p-4">
          <div className="mb-2 text-xs font-medium text-text-muted">Ссылка подписки</div>
          <div className="flex gap-2">
            <Input
              mono
              placeholder="https://panel.example.com/api/sub/<uuid>"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button
              className="shrink-0"
              disabled={loading || !url.trim()}
              onClick={() => fetch(url.trim())}
            >
              {loading ? '…' : data ? 'Обновить ссылку' : 'Подключить'}
            </Button>
            {data && (
              <Button variant="secondary" className="shrink-0" onClick={refresh} disabled={loading}>
                Синхронизировать
              </Button>
            )}
          </div>
          {error && <div className="mt-2 text-xs text-accent-red">{error}</div>}
        </Card>

        {/* current status */}
        {data && (
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-text-primary">
                {data.rawTitle || 'Текущая подписка'}
              </span>
              <Pill tone={left && left > 0 ? 'green' : 'amber'}>
                {left != null ? (left > 0 ? `активна · ${left} дн.` : 'истекла') : 'активна'}
              </Pill>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <StatusCell label="Действует до" value={formatDate(info?.expire)} />
              <StatusCell
                label="Трафик"
                value={total ? `${formatBytes(used)} / ${formatBytes(total)}` : 'Безлимит'}
                mono
              />
              <StatusCell label="Нод доступно" value={String(data.outbounds.length)} mono />
            </div>
            {total > 0 && (
              <div className="mt-3 h-1.5 overflow-hidden rounded-pill bg-bg-elevated">
                <div
                  className="h-full rounded-pill bg-accent-blue"
                  style={{ width: `${Math.min(100, (used / total) * 100)}%` }}
                />
              </div>
            )}
          </Card>
        )}

        {/* pricing plans */}
        <div>
          <div className="mb-3 text-sm font-semibold text-text-primary">Тарифы</div>
          <div className="grid grid-cols-3 gap-3">
            {PLANS.map((plan) => (
              <Card key={plan.id} highlighted={plan.best} className="flex flex-col p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-text-primary">{plan.title}</span>
                  {plan.best && <Pill tone="blue">Выгоднее всего</Pill>}
                </div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="font-mono text-3xl font-bold text-text-primary">{plan.price}</span>
                  <span className="text-sm text-text-muted">{plan.period}</span>
                </div>
                <div className="mt-1 text-[11px] text-text-faint">{plan.totalNote}</div>
                <ul className="mt-4 flex-1 space-y-2">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-xs text-text-tertiary">
                      <CheckIcon width={16} height={16} className="shrink-0 text-accent-green" />
                      {f}
                    </li>
                  ))}
                </ul>
                <a
                  href={paymentBase ? `${paymentBase}/billing?plan=${plan.id}` : undefined}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    'mt-5 inline-flex h-10 items-center justify-center rounded-xl border border-border-default bg-bg-panel-alt text-sm font-medium text-text-secondary transition-colors hover:bg-bg-elevated',
                    !paymentBase && 'pointer-events-none opacity-50'
                  )}
                >
                  Выбрать
                </a>
              </Card>
            ))}
          </div>
          {!paymentBase && (
            <p className="mt-2 text-[11px] text-text-faint">
              Подключите подписку, чтобы открыть страницу оплаты вашей панели.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl bg-bg-panel-alt px-3 py-2.5">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className={cn('mt-0.5 text-sm text-text-primary', mono && 'font-mono')}>{value}</div>
    </div>
  )
}
