import { useEffect, useState } from 'react'
import { DEFAULT_API_BASE, type AppSettings, type TunServiceInfo } from '@shared/types'
import { buildDiagnostics } from '@shared/diagnostics'
import { PageHeader } from '../components/PageHeader'
import { Button, Card, Input, Toggle } from '../components/ui'
import { CheckIcon, CopyIcon } from '../components/icons'
import { useSettings } from '../store/settingsStore'
import { useLogs } from '../store/logsStore'
import { useUpdater } from '../store/updaterStore'
import { useConnection } from '../store/connectionStore'
import { useSubscription } from '../store/subscriptionStore'
import { toast } from '../store/toastStore'
import { errorText } from '../lib/format'
import { cn } from '../lib/cn'

export function SettingsPage() {
  const { settings, load, update } = useSettings()
  const logs = useLogs((s) => s.entries)
  const state = useConnection((s) => s.state)
  const servers = useSubscription((s) => s.data?.servers.length ?? 0)
  const [version, setVersion] = useState('')
  const [support, setSupport] = useState('')
  const [apiBase, setApiBase] = useState('')

  useEffect(() => {
    void load()
    void window.api.app.getVersion().then(setVersion)
  }, [load])
  useEffect(() => {
    if (settings) setSupport(settings.supportUrl)
  }, [settings?.supportUrl]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (settings) setApiBase(settings.apiBase)
  }, [settings?.apiBase]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings) return null

  const save = async (patch: Partial<AppSettings>, ok?: string) => {
    try {
      await update(patch)
      if (ok) toast(ok, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const copyDiagnostics = async () => {
    // log lines arrive already masked by the main process (no node addresses,
    // no subscription link); settings hold nothing secret
    const blob = buildDiagnostics({ version, state, servers, settings, logs })
    await navigator.clipboard.writeText(blob)
    toast('Диагностика скопирована — адреса серверов и ссылка подписки в ней скрыты', 'success')
  }

  const supportDirty = support.trim() !== settings.supportUrl
  const apiDirty = apiBase.trim() !== settings.apiBase

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title="Настройки" />

      <div className="space-y-6 px-7 pb-8">
        <Section
          title="Способ подключения"
          hint={state === 'connected' ? 'Смена способа переподключит VPN.' : undefined}
        >
          <div className="grid grid-cols-2 gap-3">
            <ModeCard
              active={settings.proxyMode === 'system'}
              onClick={() => void save({ proxyMode: 'system' })}
              title="Системный прокси"
              desc="Без прав администратора. Через VPN идут программы, которые используют прокси Windows: браузеры, большинство приложений."
            />
            <ModeCard
              active={settings.proxyMode === 'tun'}
              onClick={() => void save({ proxyMode: 'tun' })}
              title="TUN — весь компьютер"
              desc="Перехватывает трафик всех программ, включая игры. Права администратора Windows спросит один раз — при установке службы TUN."
            />
          </div>
          {settings.proxyMode === 'tun' && <TunServiceControls enabled={settings.tunService} />}
        </Section>

        <Section title="Запуск">
          <Row
            label="Запускать вместе с Windows"
            hint="CipherWay стартует при входе в систему и ждёт в трее"
          >
            <Toggle checked={settings.autoLaunch} onChange={(v) => void save({ autoLaunch: v })} />
          </Row>
          <Row label="Подключаться при запуске" hint="Сразу включать VPN после старта приложения">
            <Toggle
              checked={settings.autoConnect}
              onChange={(v) => void save({ autoConnect: v })}
            />
          </Row>
        </Section>

        <Section
          title="Поддержка"
          hint="Чат поддержки — на странице «Поддержка». Ссылка ниже — запасной вариант «Написать в Telegram», если подписка не передаёт свою (https:// или tg://)."
        >
          <div className="flex gap-2">
            <Input
              mono
              placeholder="https://t.me/…"
              value={support}
              onChange={(e) => setSupport(e.target.value)}
            />
            <Button
              className="shrink-0"
              variant="secondary"
              disabled={!supportDirty}
              onClick={() =>
                void save({ supportUrl: support.trim() }, 'Ссылка поддержки сохранена')
              }
            >
              Сохранить
            </Button>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] text-text-muted">Сервер чата поддержки</div>
            <div className="flex gap-2">
              <Input
                mono
                placeholder={DEFAULT_API_BASE}
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
              />
              <Button
                className="shrink-0"
                variant="secondary"
                disabled={!apiDirty}
                onClick={() =>
                  void save(
                    { apiBase: apiBase.trim() || DEFAULT_API_BASE },
                    'Адрес сервера поддержки сохранён'
                  )
                }
              >
                Сохранить
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Обновления">
          <Row label="Версия приложения" hint="Обновления приходят с GitHub автоматически">
            <span className="font-mono text-sm text-text-secondary">
              {version ? `v${version}` : '—'}
            </span>
          </Row>
          <UpdaterControls />
        </Section>

        <Section title="Диагностика" hint="Пригодится, если пишете в поддержку.">
          <Row
            label="Подробный журнал (для поддержки)"
            hint="Записывать каждое соединение. Включайте только по просьбе поддержки — журнал растёт очень быстро. Применится при следующем подключении."
          >
            <Toggle checked={settings.verboseLog} onChange={(v) => void save({ verboseLog: v })} />
          </Row>
          <Button variant="secondary" size="sm" onClick={() => void copyDiagnostics()}>
            <CopyIcon width={14} height={14} />
            Скопировать диагностику
          </Button>
        </Section>
      </div>
    </div>
  )
}

function Section({
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
      <div className="mb-2.5 px-1">
        <div className="text-sm font-semibold text-text-primary">{title}</div>
        {hint && <div className="mt-0.5 text-[11px] text-text-muted">{hint}</div>}
      </div>
      <Card className="space-y-4 p-4">{children}</Card>
    </section>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm text-text-primary">{label}</div>
        {hint && <div className="text-[11px] text-text-faint">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function UpdaterControls() {
  const { phase, version, percent, error, check, download, install } = useUpdater()

  if (phase === 'available') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-accent-green/40 bg-accent-green/10 px-3 py-2.5">
        <span className="text-sm text-accent-green">
          Доступна версия {version ? `v${version}` : ''}
        </span>
        <Button size="sm" onClick={download}>
          Скачать
        </Button>
      </div>
    )
  }

  if (phase === 'downloading') {
    return (
      <div className="space-y-2">
        <div className="h-1.5 overflow-hidden rounded-pill bg-bg-elevated">
          <div
            className="h-full rounded-pill bg-accent-blue transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="font-mono text-xs text-text-muted">Загрузка… {percent}%</div>
      </div>
    )
  }

  if (phase === 'downloaded') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-accent-green/40 bg-accent-green/10 px-3 py-2.5">
        <span className="text-sm text-accent-green">
          Версия {version ? `v${version}` : ''} готова к установке
        </span>
        <Button size="sm" onClick={install}>
          Перезапустить и установить
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <Button variant="secondary" size="sm" onClick={check} disabled={phase === 'checking'}>
        {phase === 'checking' ? 'Проверка…' : 'Проверить обновления'}
      </Button>
      {phase === 'not-available' && (
        <span className="flex items-center gap-1 text-xs text-accent-green">
          <CheckIcon width={14} height={14} />
          Установлена последняя версия
        </span>
      )}
      {phase === 'error' && <span className="text-xs text-accent-red">{error}</span>}
    </div>
  )
}

const TUN_STATE_LABEL: Record<TunServiceInfo['state'], string> = {
  ok: 'установлена',
  missing: 'не установлена',
  outdated: 'нужно обновить (после обновления приложения)'
}

/** «Служба TUN»: one UAC prompt to install, then TUN connects without one. */
function TunServiceControls({ enabled }: { enabled: boolean }) {
  const state = useConnection((s) => s.state)
  const [info, setInfo] = useState<TunServiceInfo | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.tunService.status().then(setInfo)
  }, [])

  const run = async (op: 'install' | 'remove') => {
    setBusy(true)
    try {
      setInfo(await window.api.tunService[op]())
      toast(
        op === 'install'
          ? 'Служба TUN установлена — подключение без запроса прав'
          : 'Служба TUN удалена — права будут запрашиваться при каждом подключении',
        'success'
      )
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const connected = state === 'connected' || state === 'connecting'
  const hint = !enabled
    ? 'Выключена: Windows спрашивает права администратора при каждом подключении TUN.'
    : 'Задача Планировщика Windows запускает ядро с правами администратора без запроса. Файлы ядра хранятся в защищённой папке ProgramData\\CipherWay.'

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border-subtle bg-bg-panel-alt px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-sm text-text-primary">
          Служба TUN: {info ? TUN_STATE_LABEL[info.state] : '…'}
        </div>
        <div className="text-[11px] text-text-faint">{hint}</div>
      </div>
      {info?.state === 'ok' ? (
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          disabled={busy || connected}
          title={connected ? 'Сначала отключите VPN' : undefined}
          onClick={() => void run('remove')}
        >
          Удалить службу TUN
        </Button>
      ) : (
        <Button
          size="sm"
          className="shrink-0"
          disabled={busy || connected}
          title={connected ? 'Сначала отключите VPN' : undefined}
          onClick={() => void run('install')}
        >
          {info?.state === 'outdated' ? 'Обновить службу' : 'Установить службу'}
        </Button>
      )}
    </div>
  )
}

function ModeCard({
  active,
  onClick,
  title,
  desc
}: {
  active: boolean
  onClick: () => void
  title: string
  desc: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-2xl border p-4 text-left transition-all duration-200',
        active
          ? 'border-accent-green/50 bg-accent-green/[0.07]'
          : 'border-border-subtle bg-bg-panel-alt hover:border-border-default hover:bg-bg-elevated'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-full border-2 transition-colors',
            active ? 'border-accent-green' : 'border-text-faint'
          )}
        >
          {active && <span className="h-1.5 w-1.5 rounded-full bg-accent-green" />}
        </span>
        <span className="text-sm font-semibold text-text-primary">{title}</span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-text-muted">{desc}</p>
    </button>
  )
}
