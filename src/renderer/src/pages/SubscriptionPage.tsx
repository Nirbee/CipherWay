import { useEffect, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Button, Card, Input } from '../components/ui'
import { ExternalIcon, RefreshIcon, SupportIcon } from '../components/icons'
import { useSubscription } from '../store/subscriptionStore'
import { useNav } from '../store/navStore'
import { toast } from '../store/toastStore'
import { openLink, useLinks } from '../hooks/useLinks'
import { daysLeft, formatAgo, formatBytes, formatDate, formatDays } from '../lib/format'
import { cn } from '../lib/cn'

export function SubscriptionPage() {
  const { data, loading, error, load, fetch, refresh } = useSubscription()
  const setPage = useNav((s) => s.setPage)
  const { supportUrl, renewUrl } = useLinks()
  const [url, setUrl] = useState('')
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const info = data?.userInfo
  const used = (info?.upload ?? 0) + (info?.download ?? 0)
  const total = info?.total ?? 0
  const days = daysLeft(info?.expire)
  const expired = !!info?.expire && info.expire * 1000 <= Date.now()
  const showInput = !data || editing

  const submit = async () => {
    const ok = await fetch(url.trim())
    if (ok) {
      setUrl('')
      setEditing(false)
      toast('Подписка обновлена', 'success')
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        title="Подписка"
        subtitle="Ссылка из бота CipherWay: по ней приходят серверы и срок действия"
        actions={
          data && (
            <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshIcon width={14} height={14} className={cn(loading && 'animate-spin')} />
              Обновить
            </Button>
          )
        }
      />

      <div className="space-y-4 px-7 pb-8">
        {data && (
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold text-text-primary">
                  {data.title || 'CipherWay VPN'}
                </div>
                <div className="mt-0.5 text-xs text-text-muted">
                  Серверов: {data.servers.length} · обновлено {formatAgo(data.fetchedAt)}
                </div>
              </div>
              <span
                className={cn(
                  'rounded-pill px-2.5 py-1 text-[11px] font-medium',
                  expired
                    ? 'bg-accent-red/15 text-accent-red'
                    : days !== null && days <= 3
                      ? 'bg-accent-amber/15 text-accent-amber'
                      : 'bg-accent-green/15 text-accent-green'
                )}
              >
                {expired ? 'истекла' : days !== null ? `активна · ещё ${formatDays(days)}` : 'активна'}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <Cell label="Действует до" value={info?.expire ? formatDate(info.expire) : 'Бессрочно'} />
              <Cell
                label="Израсходовано"
                value={total ? `${formatBytes(used)} из ${formatBytes(total)}` : `${formatBytes(used)} · безлимит`}
              />
              <Cell label="Осталось" value={total ? formatBytes(Math.max(0, total - used)) : '∞'} />
            </div>
            {total > 0 && (
              <div className="mt-3 h-1.5 overflow-hidden rounded-pill bg-bg-elevated">
                <div
                  className="h-full rounded-pill bg-accent-green transition-all"
                  style={{ width: `${Math.min(100, (used / total) * 100)}%` }}
                />
              </div>
            )}

            {(renewUrl || supportUrl) && (
              <div className="mt-4 flex gap-2">
                {renewUrl && (
                  <Button size="sm" onClick={() => openLink(renewUrl)}>
                    Продлить подписку
                    <ExternalIcon width={13} height={13} />
                  </Button>
                )}
                {supportUrl && (
                  <Button size="sm" variant="secondary" onClick={() => openLink(supportUrl)}>
                    <SupportIcon width={14} height={14} />
                    Поддержка
                  </Button>
                )}
              </div>
            )}
          </Card>
        )}

        <Card className="p-5">
          <div className="mb-1 text-sm font-semibold text-text-primary">Ссылка подписки</div>
          {!showInput ? (
            <div className="mt-2 flex items-center gap-3">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-bg-panel-alt px-3 py-2 font-mono text-xs text-text-muted">
                {data?.urlMasked || 'сохранена'}
              </code>
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                Заменить ссылку
              </Button>
            </div>
          ) : (
            <>
              <p className="mb-3 text-xs text-text-muted">
                Скопируйте ссылку подписки в боте CipherWay и вставьте её сюда.
                Ссылка хранится зашифрованной и в логах скрыта.
              </p>
              <div className="flex gap-2">
                <Input
                  mono
                  autoFocus={editing}
                  placeholder="https://…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && url.trim() && void submit()}
                />
                <Button className="shrink-0" disabled={loading || !url.trim()} onClick={() => void submit()}>
                  {loading ? 'Загрузка…' : data ? 'Сохранить' : 'Подключить'}
                </Button>
                {editing && (
                  <Button variant="ghost" className="shrink-0" onClick={() => setEditing(false)}>
                    Отмена
                  </Button>
                )}
              </div>
            </>
          )}
          {error && <div className="mt-2 text-xs text-accent-red">{error}</div>}
        </Card>

        {data && (
          <button
            onClick={() => setPage('servers')}
            className="text-xs text-text-muted underline-offset-2 hover:text-text-primary hover:underline"
          >
            Перейти к серверам →
          </button>
        )}
      </div>
    </div>
  )
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-bg-panel-alt px-3.5 py-3">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="mt-1 truncate text-sm text-text-primary">{value}</div>
    </div>
  )
}
