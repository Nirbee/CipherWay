import { useEffect, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Button, Card, Toggle } from '../components/ui'
import { useSettings } from '../store/settingsStore'
import { useLogs } from '../store/logsStore'
import { useUpdater } from '../store/updaterStore'
import { cn } from '../lib/cn'

export function SettingsPage() {
  const { settings, load, update } = useSettings()
  const logs = useLogs((s) => s.entries)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void load()
    void window.api.app.getVersion().then(setVersion)
  }, [load])

  if (!settings) return null

  const exportDiagnostics = () => {
    const blob = [
      `CipherWay VPN diagnostics`,
      `date: ${new Date().toISOString()}`,
      `settings: ${JSON.stringify(settings)}`,
      `--- last logs ---`,
      ...logs.slice(-200).map((e) => `${new Date(e.ts).toISOString()} [${e.source}/${e.level}] ${e.message}`)
    ].join('\n')
    void navigator.clipboard.writeText(blob)
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader overline="Конфигурация" title="Настройки" />

      <div className="space-y-5 px-6 pb-8">
        {/* proxy mode */}
        <Section title="Режим подключения">
          <div className="grid grid-cols-2 gap-3">
            <ModeCard
              active={settings.proxyMode === 'tun'}
              onClick={() => update({ proxyMode: 'tun' })}
              title="TUN"
              desc="Системный перехват, работают правила по процессам. Требует прав администратора (UAC) и драйвер wintun."
            />
            <ModeCard
              active={settings.proxyMode === 'system'}
              onClick={() => update({ proxyMode: 'system' })}
              title="System Proxy"
              desc="Проще, без прав администратора. Правила по процессам недоступны."
            />
          </div>
          {settings.proxyMode === 'tun' && (
            <p className="mt-2 text-[11px] text-accent-amber">
              При подключении появится запрос прав администратора (UAC).
            </p>
          )}
        </Section>

        {/* toggles */}
        <Section title="Запуск">
          <Row label="Автозапуск с Windows" hint="Запускать CipherWay при входе в систему">
            <Toggle checked={settings.autoLaunch} onChange={(v) => update({ autoLaunch: v })} />
          </Row>
          <Row label="Автоподключение" hint="Подключаться к VPN при старте приложения">
            <Toggle checked={settings.autoConnect} onChange={(v) => update({ autoConnect: v })} />
          </Row>
        </Section>

        {/* language */}
        <Section title="Язык интерфейса">
          <div className="flex w-fit rounded-pill border border-border-default p-0.5">
            {(['ru', 'en'] as const).map((l) => (
              <button
                key={l}
                onClick={() => update({ language: l })}
                className={cn(
                  'rounded-pill px-4 py-1.5 text-sm transition-colors',
                  settings.language === l
                    ? 'bg-accent-blue text-white'
                    : 'text-text-muted hover:text-text-primary'
                )}
              >
                {l === 'ru' ? 'Русский' : 'English'}
              </button>
            ))}
          </div>
        </Section>

        {/* updates */}
        <Section title="Обновления">
          <Row label="Версия приложения" hint="CipherWay VPN">
            <span className="font-mono text-sm text-text-secondary">{version ? `v${version}` : '—'}</span>
          </Row>
          <UpdaterControls />
        </Section>

        {/* diagnostics */}
        <Section title="Диагностика">
          <Button variant="secondary" size="sm" onClick={exportDiagnostics}>
            Скопировать диагностику
          </Button>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3 text-sm font-semibold text-text-primary">{title}</div>
      <Card className="space-y-3 p-4">{children}</Card>
    </div>
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
      <div className="space-y-2">
        <div className="rounded-xl border border-accent-blue bg-accent-blue/10 px-3 py-2 text-sm text-accent-blue-bright">
          Доступно обновление {version ? `v${version}` : ''}
        </div>
        <Button size="sm" onClick={download}>
          Скачать обновление
        </Button>
      </div>
    )
  }

  if (phase === 'downloading') {
    return (
      <div className="space-y-2">
        <div className="h-2 overflow-hidden rounded-pill bg-bg-elevated">
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
      <div className="space-y-2">
        <div className="rounded-xl border border-accent-green bg-accent-green/10 px-3 py-2 text-sm text-accent-green">
          Обновление {version ? `v${version}` : ''} загружено
        </div>
        <Button size="sm" onClick={install}>
          Перезапустить и установить
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Button variant="secondary" size="sm" onClick={check} disabled={phase === 'checking'}>
        {phase === 'checking' ? 'Проверка…' : 'Проверить обновления'}
      </Button>
      {phase === 'not-available' && (
        <div className="text-xs text-text-muted">У вас последняя версия.</div>
      )}
      {phase === 'error' && <div className="text-xs text-accent-red">{error}</div>}
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
        'rounded-card border p-4 text-left transition-colors',
        active ? 'border-accent-blue bg-accent-blue/10' : 'border-border-default bg-bg-panel-alt hover:bg-bg-elevated'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold text-text-primary">{title}</span>
        {active && <span className="h-2 w-2 rounded-full bg-accent-blue" />}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">{desc}</p>
    </button>
  )
}
