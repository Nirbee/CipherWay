import { useEffect, useState, type ReactNode } from 'react'
import {
  ZAPRET_CUSTOM_MAX,
  ZAPRET_SERVICES,
  normalizeZapretDomain,
  zapretStateText,
  type ZapretItem,
  type ZapretServiceId,
  type ZapretView
} from '@shared/zapret'
import { Button, Card, Input, Modal, Pill, Toggle } from './ui'
import { CloseIcon } from './icons'
import { toast } from '../store/toastStore'
import { errorText, formatAgo } from '../lib/format'

// Settings → «Ускорение без VPN (zapret)» (0.7.0): off by default; the first
// switch-on shows a one-time warning; services, own domains, the state of each,
// the strategy and «Подобрать заново». Everything else lives in main/zapret.

const PHASE_TEXT: Record<ZapretView['phase'], string> = {
  off: 'Выключено. Выбранные сайты идут через VPN, как всё остальное.',
  idle: 'Включено — заработает, когда вы подключите VPN.',
  starting: 'Запускаем и проверяем сайты напрямую…',
  running: 'Работает: открывающиеся напрямую сайты идут мимо VPN.',
  picking: 'Подбираем способ обхода для этой сети…',
  error: 'Ошибка — подробности ниже.'
}

const WARNING_POINTS = [
  'Выбранные сайты пойдут напрямую, мимо VPN: они увидят ваш настоящий IP-адрес и провайдера.',
  'zapret работает через драйвер WinDivert — антивирус может предупредить о нём или удалить файл. Это известная реакция на такие программы; файлы взяты из официального выпуска zapret и проверяются по хэшу.',
  'Нужны права администратора: служба CipherWay ставится один раз (Windows спросит разрешение), потом запрос не появляется.',
  'Если сайт не откроется напрямую, приложение само вернёт его в VPN и попробует снова позже.'
]

export function ZapretSection({
  Section
}: {
  Section: (p: { title: string; hint?: string; children: ReactNode }) => JSX.Element
}) {
  const [view, setView] = useState<ZapretView | null>(null)
  const [busy, setBusy] = useState(false)
  const [warn, setWarn] = useState(false)
  const [domain, setDomain] = useState('')

  useEffect(() => {
    void window.api.zapret.get().then(setView)
    return window.api.on.zapret(setView)
  }, [])

  if (!view) return null

  const run = async (fn: () => Promise<ZapretView>, ok?: string): Promise<boolean> => {
    setBusy(true)
    try {
      setView(await fn())
      if (ok) toast(ok, 'success')
      return true
    } catch (e) {
      toast(errorText(e), 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const s = view.settings
  const toggle = (on: boolean): void => {
    if (on && !s.warned) {
      setWarn(true)
      return
    }
    void run(() => window.api.zapret.setEnabled(on))
  }
  const accept = (): void => {
    setWarn(false)
    void run(() => window.api.zapret.setEnabled(true, true))
  }
  const setService = (id: ZapretServiceId, on: boolean): void => {
    const next = on ? [...s.services, id] : s.services.filter((x) => x !== id)
    void run(() => window.api.zapret.setServices(next))
  }
  const check = domain.trim() ? normalizeZapretDomain(domain) : null
  const add = (): void => {
    if (!check) return
    if (!check.ok) {
      toast(check.error, 'error')
      return
    }
    void run(() => window.api.zapret.addDomain(domain)).then((ok) => ok && setDomain(''))
  }

  const items = new Map(view.items.map((i) => [i.key, i]))
  const active = view.phase === 'running' || view.phase === 'starting' || view.phase === 'error'

  return (
    <Section
      title="Ускорение без VPN (zapret)"
      hint="YouTube, Discord и ваши сайты идут напрямую, мимо VPN, — zapret обходит замедление у провайдера. Меньше пинг и быстрее видео. Всё остальное идёт через VPN, как раньше."
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm text-text-primary">Ускорение без VPN</div>
          <div className="text-[11px] text-text-faint">
            {view.available ? PHASE_TEXT[view.phase] : 'В этой сборке нет zapret.'}
          </div>
        </div>
        <Toggle
          checked={s.enabled}
          disabled={busy || !view.available}
          label="Ускорение без VPN"
          onChange={toggle}
        />
      </div>

      {view.warning && <Note tone="amber">{view.warning}</Note>}
      {view.error && <Note tone="red">{view.error}</Note>}

      <div>
        <div className="mb-1.5 text-[11px] text-text-muted">Сервисы</div>
        <div className="space-y-1.5">
          {ZAPRET_SERVICES.map((svc) => (
            <div
              key={svc.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-panel-alt px-3 py-2"
            >
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-text-primary">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent-green"
                  checked={s.services.includes(svc.id)}
                  disabled={busy}
                  onChange={(e) => setService(svc.id, e.target.checked)}
                />
                {svc.name}
              </label>
              {s.enabled && s.services.includes(svc.id) && (
                <StatePill item={items.get(svc.id)} phase={view.phase} />
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-[11px] text-text-muted">
          <span>Свои сайты</span>
          <span className="text-text-faint">
            {s.custom.length} из {ZAPRET_CUSTOM_MAX}
          </span>
        </div>
        <div className="flex gap-2">
          <Input
            mono
            placeholder="example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <Button
            className="shrink-0"
            variant="secondary"
            disabled={busy || !check?.ok || s.custom.length >= ZAPRET_CUSTOM_MAX}
            onClick={add}
          >
            Добавить
          </Button>
        </div>
        {check && !check.ok && (
          <div className="mt-1 text-[11px] text-accent-amber">{check.error}</div>
        )}
        <div className="mt-1 text-[11px] text-text-faint">
          Поддомены тоже: example.com включает www.example.com. Ваши правила на странице «Правила»
          важнее — если правило отправляет сайт через VPN, он пойдёт через VPN.
        </div>
        {s.custom.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {s.custom.map((d) => (
              <div
                key={d}
                className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-panel-alt px-3 py-1.5"
              >
                <span className="min-w-0 truncate font-mono text-[12px] text-text-primary">
                  {d}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  {s.enabled && <StatePill item={items.get(`d:${d}`)} phase={view.phase} />}
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded-lg text-text-muted hover:bg-bg-elevated hover:text-text-primary disabled:opacity-40"
                    title="Удалить"
                    aria-label={`Удалить ${d}`}
                    disabled={busy}
                    onClick={() => void run(() => window.api.zapret.removeDomain(d))}
                  >
                    <CloseIcon width={14} height={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {s.enabled && (
        <Card className="flex items-center justify-between gap-4 border-border-subtle bg-bg-panel-alt px-3.5 py-3">
          <div className="min-w-0">
            <div className="text-sm text-text-primary">
              Стратегия:{' '}
              {view.phase === 'picking'
                ? `подбираем${view.picking ? ` (${view.picking.done} из ${view.picking.total})` : '…'}`
                : (view.strategy?.name ??
                  (active ? 'ни одна не помогла — всё через VPN' : 'подберётся при подключении'))}
            </div>
            <div className="text-[11px] text-text-faint">
              {view.checking
                ? 'Проверяем сайты напрямую…'
                : view.checkedAt
                  ? `Проверено ${formatAgo(view.checkedAt)}. Повторяется каждые 10 минут и при смене сети.`
                  : 'Выбор запоминается для каждой сети (дом, работа, телефон).'}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={busy || !active || view.phase === 'picking'}
            title={!active ? 'Работает, когда VPN подключён' : undefined}
            onClick={() => void run(() => window.api.zapret.repick())}
          >
            Подобрать заново
          </Button>
        </Card>
      )}

      <Modal
        open={warn}
        onClose={() => setWarn(false)}
        title="Ускорение без VPN"
        width="max-w-xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setWarn(false)}>
              Отмена
            </Button>
            <Button onClick={accept}>Понятно, включить</Button>
          </>
        }
      >
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-text-secondary">
          {WARNING_POINTS.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </Modal>
    </Section>
  )
}

function StatePill({ item, phase }: { item: ZapretItem | undefined; phase: ZapretView['phase'] }) {
  if (!item || item.state === 'idle') {
    return <Pill>{phase === 'idle' ? 'включится с VPN' : 'выключено'}</Pill>
  }
  const tone = item.state === 'direct' ? 'green' : item.state === 'vpn' ? 'amber' : 'blue'
  return (
    <Pill tone={tone} title={item.detail}>
      {zapretStateText(item)}
    </Pill>
  )
}

function Note({ tone, children }: { tone: 'amber' | 'red'; children: ReactNode }) {
  return (
    <div
      className={
        tone === 'amber'
          ? 'rounded-xl border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-[12px] text-accent-amber'
          : 'rounded-xl border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red'
      }
    >
      {children}
    </div>
  )
}
