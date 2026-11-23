import { useCallback, useEffect, useState } from 'react'
import type { DevGameCandidate, DevStatsView } from '@shared/devversion'
import { PageHeader } from '../components/PageHeader'
import { Button, Card, Modal, Pill } from '../components/ui'
import { useDev } from '../store/devStore'
import { toast } from '../store/toastStore'
import { errorText, formatAgo, formatBytes, formatDuration } from '../lib/format'
import { cn } from '../lib/cn'

/** the page asks main this often — only while it is open and the window visible */
const POLL_MS = 3000

const EVENT_LABEL: Record<string, string> = {
  reality: 'REALITY: чужой сертификат',
  timeout: 'таймаут',
  no_activity: 'нет активности',
  reset: 'сброс соединения',
  refused: 'отказ в соединении',
  eof: 'обрыв (EOF)',
  tls: 'ошибка TLS',
  dns: 'ошибка DNS',
  direct_timeout: 'напрямую: таймаут',
  direct_reset: 'напрямую: сброс',
  direct_refused: 'напрямую: отказ',
  direct_eof: 'напрямую: обрыв'
}

const ms = (v: number | null | undefined): string => (typeof v === 'number' ? `${v} мс` : '—')
const time = (t: number | null | undefined): string =>
  t ? new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'

export function StatsPage() {
  const [view, setView] = useState<DevStatsView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [gamePick, setGamePick] = useState(false)
  const setStatus = useDev((s) => s.set)

  const refresh = useCallback(async () => {
    try {
      const v = await window.api.dev.stats()
      setView(v)
      setStatus(v.status)
    } catch {
      /* the next poll will try again */
    }
  }, [setStatus])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  const act = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const s = view?.status
  const game = view?.gameTest
  const gameRunning = game?.phase === 'recording' || game?.phase === 'probing'

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        overline="DevVersion"
        title="Статистика"
        subtitle="Что собирается и отправляется. Содержимое трафика не собирается; адреса серверов, ссылка подписки и ключи скрыты."
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy}
              onClick={() =>
                void act('save', async () => {
                  const path = await window.api.dev.saveReport()
                  if (path) toast('Отчёт сохранён', 'success')
                })
              }
            >
              Сохранить отчёт в файл
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy || gameRunning}
              onClick={() => setGamePick(true)}
            >
              Тест игры
            </Button>
            <Button
              size="sm"
              disabled={!!busy}
              onClick={() =>
                void act('send', async () => {
                  const st = await window.api.dev.sendNow()
                  setStatus(st)
                  toast(
                    st.lastUpload?.text ?? 'Отчёт поставлен в очередь',
                    st.lastUpload?.ok === false ? 'error' : 'success'
                  )
                })
              }
            >
              {busy === 'send' ? 'Отправляем…' : 'Отправить сейчас'}
            </Button>
          </>
        }
      />

      <div className="space-y-5 px-7 pb-8">
        {!view || !s ? (
          <Card className="p-4 text-sm text-text-muted">Загружаем…</Card>
        ) : (
          <>
            <Card className="grid grid-cols-2 gap-x-6 gap-y-2.5 p-4 text-[13px]">
              <Stat label="Сбор">
                {s.collecting ? (
                  <Pill tone="green">идёт</Pill>
                ) : (
                  <Pill tone="amber">остановлен</Pill>
                )}
                {!s.vpnRunning && (
                  <span className="ml-2 text-[11px] text-text-faint">
                    VPN выключен — проверки через VPN пропускаются
                  </span>
                )}
              </Stat>
              <Stat label="Игра / звонок">
                {s.game.active ? (
                  <span className="text-accent-amber">
                    {s.game.process} — тяжёлые проверки отложены
                  </span>
                ) : (
                  'нет'
                )}
              </Stat>
              <Stat label="Последняя отправка">
                {s.lastUpload ? (
                  <span className={s.lastUpload.ok ? undefined : 'text-accent-amber'}>
                    {formatAgo(s.lastUpload.at)} — {s.lastUpload.text}
                  </span>
                ) : (
                  'ещё не было'
                )}
              </Stat>
              <Stat label="Следующая отправка">{time(s.nextUploadAt)}</Stat>
              <Stat label="Накоплено с">
                {time(s.since)} · программ {s.accumulated.processes}, соединений{' '}
                {s.accumulated.connections}, {formatBytes(s.accumulated.bytes)}
              </Stat>
              <Stat label="Замеры и события">
                замеров {s.accumulated.probes}, событий {s.accumulated.events}
              </Stat>
              <Stat label="Проверки сайтов и серверов">
                {s.heavy.running
                  ? 'идут сейчас'
                  : s.heavy.deferred
                    ? 'отложены до конца игры'
                    : `следующие в ${time(s.heavy.nextAt)}`}
                {s.heavy.lastAt ? ` · последние ${formatAgo(s.heavy.lastAt)}` : ''}
              </Stat>
              <Stat label="Очередь на отправку">
                {s.queue.reports
                  ? `${s.queue.reports} отч. · ${formatBytes(s.queue.bytes)}`
                  : 'пусто'}
              </Stat>
              {(s.paused || s.waitingDirect) && (
                <div className="col-span-2 rounded-xl border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-[12px] text-accent-amber">
                  {s.paused ??
                    'Отправка ждёт переподключения VPN — чтобы отчёт ушёл напрямую, мимо VPN.'}
                </div>
              )}
            </Card>

            {game && (
              <GameTestCard
                view={view}
                busy={!!busy}
                onStop={() =>
                  void act('stop', async () => setView(await window.api.dev.gameStop()))
                }
              />
            )}

            <Block title="Программы" hint="Топ по трафику за текущий период">
              <Table
                head={[
                  'Программа',
                  'Трафик',
                  'Напрямую',
                  'Через VPN',
                  'Соед.',
                  'Без ответа',
                  'Домены'
                ]}
                rows={view.apps.map((a) => [
                  a.process,
                  formatBytes(a.bytes),
                  formatBytes(a.directBytes),
                  formatBytes(a.vpnBytes),
                  String(a.conns),
                  a.noReply ? (
                    <span key="nr" className="text-accent-amber">
                      {a.noReply}
                    </span>
                  ) : (
                    '0'
                  ),
                  <span key="dom" className="text-text-faint">
                    {a.topDomains.join(', ') || '—'}
                  </span>
                ])}
                empty="Пока пусто: соединения видны, когда VPN включён"
              />
            </Block>

            <Block
              title="Качество серверов"
              hint="5 замеров через каждый сервер раз в ~30 минут (не во время игр) и TCP до сервера напрямую"
            >
              {view.tunnel && (
                <div className="mb-3 rounded-xl border border-border-subtle bg-bg-panel-alt px-3 py-2 text-[12px] text-text-secondary">
                  Туннель{view.tunnel.node ? ` (${view.tunnel.node})` : ''}, замер раз в минуту: p50{' '}
                  {ms(view.tunnel.p50)}, p95 {ms(view.tunnel.p95)}, разброс {ms(view.tunnel.jitter)}
                  , потери {view.tunnel.lossPct ?? 0}%, заморозки {view.tunnel.stalls}, обрывы{' '}
                  {view.tunnel.drops}
                </div>
              )}
              <Table
                head={['Сервер', 'Замеров', 'p50', 'p95', 'Разброс', 'Потери', 'TCP напрямую']}
                rows={view.nodes.map((n) => [
                  n.node,
                  String(n.samples),
                  ms(n.p50),
                  ms(n.p95),
                  ms(n.jitter),
                  n.lossPct === null ? '—' : `${n.lossPct}%`,
                  ms(n.tcpDirectMs)
                ])}
                empty="Замеров ещё не было"
              />
            </Block>

            <Block
              title="Доступность: напрямую и через VPN"
              hint="TCP, TLS (с проверкой сертификата), HTTP-ответ; DNS системы против DoH 1.1.1.1"
            >
              <Table
                head={['Адрес', 'Напрямую', 'Через VPN', 'DNS']}
                rows={view.probes.map((p) => [
                  p.target,
                  p.direct,
                  p.vpn,
                  p.dns ? (
                    <span
                      key="dns"
                      className={p.dns === 'совпадает' ? undefined : 'text-accent-amber'}
                    >
                      {p.dns}
                    </span>
                  ) : (
                    '—'
                  )
                ])}
                empty="Проверок ещё не было"
              />
            </Block>

            <Block
              title="Последние события"
              hint="Обрывы, ошибки REALITY, таймауты из журнала ядра"
            >
              {view.events.length === 0 ? (
                <div className="text-[12px] text-text-faint">Событий нет</div>
              ) : (
                <div className="space-y-1 font-mono text-[11.5px] text-text-secondary">
                  {view.events.map((e, i) => (
                    <div key={`${e.at}-${i}`} className="flex gap-3">
                      <span className="text-text-faint">{time(e.at)}</span>
                      <span className="text-accent-amber">{EVENT_LABEL[e.kind] ?? e.kind}</span>
                      <span>{e.outbound || '—'}</span>
                      <span className="truncate text-text-muted">{e.target}</span>
                    </div>
                  ))}
                </div>
              )}
            </Block>
          </>
        )}
      </div>

      <GamePickModal
        open={gamePick}
        onClose={() => setGamePick(false)}
        onPick={(name) =>
          void act('game', async () => {
            setGamePick(false)
            setView(await window.api.dev.gameStart(name))
          })
        }
      />
    </div>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-text-faint">{label}</div>
      <div className="text-text-secondary">{children}</div>
    </div>
  )
}

function Block({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2 px-1">
        <div className="text-sm font-semibold text-text-primary">{title}</div>
        {hint && <div className="mt-0.5 text-[11px] text-text-muted">{hint}</div>}
      </div>
      <Card className="p-4">{children}</Card>
    </section>
  )
}

function Table({
  head,
  rows,
  empty
}: {
  head: string[]
  rows: React.ReactNode[][]
  empty: string
}) {
  if (rows.length === 0) return <div className="text-[12px] text-text-faint">{empty}</div>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[12px]">
        <thead>
          <tr className="text-text-faint">
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap pb-1.5 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-text-secondary">
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border-subtle">
              {r.map((c, j) => (
                <td
                  key={j}
                  className={cn(
                    'py-1.5 pr-3 align-top',
                    j === 0 && 'font-medium text-text-primary'
                  )}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GameTestCard({
  view,
  busy,
  onStop
}: {
  view: DevStatsView
  busy: boolean
  onStop: () => void
}) {
  const g = view.gameTest
  if (!g) return null
  const left = Math.max(0, g.endsAt - Date.now())
  return (
    <Card className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0 text-[13px]">
        <div className="font-semibold text-text-primary">Тест игры: {g.process}</div>
        <div className="text-[12px] text-text-muted">
          {g.text}
          {g.phase === 'recording' &&
            ` · осталось ${formatDuration(left)} · направлений ${g.flows}`}
        </div>
      </div>
      {g.phase === 'recording' && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={onStop}>
          Остановить
        </Button>
      )}
    </Card>
  )
}

function GamePickModal({
  open,
  onClose,
  onPick
}: {
  open: boolean
  onClose: () => void
  onPick: (name: string) => void
}) {
  const [list, setList] = useState<DevGameCandidate[] | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => {
    if (!open) return
    setList(null)
    setQ('')
    void window.api.dev
      .gameCandidates()
      .then(setList)
      .catch(() => setList([]))
  }, [open])
  const shown = (list ?? []).filter((c) => c.name.includes(q.trim().toLowerCase())).slice(0, 200)
  return (
    <Modal open={open} onClose={onClose} title="Тест игры" width="max-w-md">
      <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
        Запустите игру, выберите её процесс и играйте как обычно: 5 минут записываем, куда она
        подключается, затем по одному проверяем эти адреса напрямую и через VPN. Лучше в режиме TUN
        — в «Системном прокси» игры обычно идут мимо VPN и их соединений не видно.
      </p>
      <input
        autoFocus
        placeholder="Поиск: rainbowsix.exe"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="mb-2 h-9 w-full rounded-lg border border-border-default bg-bg-input px-3 text-[13px] text-text-primary outline-none"
      />
      <div className="max-h-72 space-y-0.5 overflow-y-auto">
        {list === null ? (
          <div className="py-3 text-[12px] text-text-faint">Загружаем список процессов…</div>
        ) : shown.length === 0 ? (
          <div className="py-3 text-[12px] text-text-faint">Ничего не найдено</div>
        ) : (
          shown.map((c) => (
            <button
              key={c.name}
              onClick={() => onPick(c.name)}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
            >
              <span className="truncate">{c.name}</span>
              {c.seen && <Pill tone="green">в сети</Pill>}
            </button>
          ))
        )}
      </div>
    </Modal>
  )
}
