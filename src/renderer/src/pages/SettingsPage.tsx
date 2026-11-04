import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
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

  useEffect(() => {
    void load()
    void window.api.app.getVersion().then(setVersion)
  }, [load])
  useEffect(() => {
    if (settings) setSupport(settings.supportUrl)
  }, [settings?.supportUrl]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const safe = { ...settings, supportUrl: settings.supportUrl ? 'задана' : '' }
    const blob = [
      'CipherWay VPN — диагностика',
      `версия: ${version}`,
      `дата: ${new Date().toISOString()}`,
      `состояние: ${state}`,
      `серверов в подписке: ${servers}`,
      `настройки: ${JSON.stringify(safe)}`,
      '--- последние записи журнала ---',
      ...logs
        .slice(-300)
        .map((e) => `${new Date(e.ts).toISOString()} [${e.source}/${e.level}] ${e.message}`)
    ].join('\n')
    await navigator.clipboard.writeText(blob)
    toast('Диагностика скопирована — адреса серверов и ссылка подписки в ней скрыты', 'success')
  }

  const supportDirty = support.trim() !== settings.supportUrl

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
              desc="Перехватывает трафик всех программ, включая игры. При подключении Windows спросит права администратора."
            />
          </div>
        </Section>

        <Section title="Запуск">
          <Row label="Запускать вместе с Windows" hint="CipherWay стартует при входе в систему и ждёт в трее">
            <Toggle checked={settings.autoLaunch} onChange={(v) => void save({ autoLaunch: v })} />
          </Row>
          <Row label="Подключаться при запуске" hint="Сразу включать VPN после старта приложения">
            <Toggle checked={settings.autoConnect} onChange={(v) => void save({ autoConnect: v })} />
          </Row>
        </Section>

        <Section
          title="Поддержка"
          hint="Ссылка для кнопки «Поддержка», если ваша подписка не передаёт свою. Подойдёт https:// или tg://."
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
              onClick={() => void save({ supportUrl: support.trim() }, 'Ссылка поддержки сохранена')}
            >
              Сохранить
            </Button>
          </div>
        </Section>

        <Section title="Обновления">
          <Row label="Версия приложения" hint="Обновления приходят с GitHub автоматически">
            <span className="font-mono text-sm text-text-secondary">{version ? `v${version}` : '—'}</span>
          </Row>
          <UpdaterControls />
        </Section>

        <Section title="Диагностика" hint="Пригодится, если пишете в поддержку.">
          <Button variant="secondary" size="sm" onClick={() => void copyDiagnostics()}>
            <CopyIcon width={14} height={14} />
            Скопировать диагностику
          </Button>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
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

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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
        <span className="text-sm text-accent-green">Доступна версия {version ? `v${version}` : ''}</span>
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
          <div className="h-full rounded-pill bg-accent-blue transition-all" style={{ width: `${percent}%` }} />
        </div>
        <div className="font-mono text-xs text-text-muted">Загрузка… {percent}%</div>
      </div>
    )
  }

  if (phase === 'downloaded') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-accent-green/40 bg-accent-green/10 px-3 py-2.5">
        <span className="text-sm text-accent-green">Версия {version ? `v${version}` : ''} готова к установке</span>
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
