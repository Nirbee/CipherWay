import { useMemo, useRef, useState } from 'react'
import { parseRulesText, toClashLines, type ImportPosition } from '@shared/rulesText'
import { Button, Modal } from '../ui'
import { AlertIcon, CheckIcon, CopyIcon, FileIcon, TrashIcon, UpdateIcon } from '../icons'
import { useRules } from '../../store/rulesStore'
import { toast } from '../../store/toastStore'
import { DEFAULT_BEHAVIOR_LABEL } from '../../lib/ruleMeta'
import { errorText, plural } from '../../lib/format'
import { cn } from '../../lib/cn'

const LINE_H = 20 // px — gutter, error stripes and the textarea share it
const PAD_Y = 10

const PLACEHOLDER = `# Вставьте правила из Koala Clash / Clash Verge / mihomo:
DOMAIN-SUFFIX,youtube.com,PROXY
DOMAIN-KEYWORD,torrent,DIRECT
PROCESS-NAME,Telegram.exe,PROXY
GEOIP,RU,DIRECT,no-resolve
MATCH,PROXY

# …или целиком YAML с prepend: / append: / rules:, или JSON-экспорт CipherWay`

const FORMAT_LABEL = {
  empty: '—',
  clash: 'строки Clash',
  yaml: 'YAML (Koala / Clash Verge)',
  json: 'JSON CipherWay'
} as const

export function RulesTextEditor({ onApplied }: { onApplied: () => void }) {
  const { rules, defaultBehavior, importParsed } = useRules()
  const [text, setText] = useState('')
  const [confirmReplace, setConfirmReplace] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const parsed = useMemo(() => parseRulesText(text), [text])
  const lines = useMemo(() => text.split('\n'), [text])
  const errorLines = useMemo(() => new Set(parsed.skipped.map((s) => s.line)), [parsed])
  const okLines = useMemo(() => new Set(parsed.items.map((i) => i.line)), [parsed])
  const widthCh = Math.max(40, ...lines.map((l) => l.length)) + 4

  const pre = parsed.items.filter((i) => i.section === 'prepend').length
  const post = parsed.items.filter((i) => i.section === 'append').length
  const count = parsed.items.length
  const canApply = count > 0 || parsed.deletions.length > 0 || !!parsed.defaultBehavior

  const goto = (line: number) => {
    scrollRef.current?.scrollTo({ top: Math.max(0, (line - 3) * LINE_H), behavior: 'smooth' })
    const area = areaRef.current
    if (!area) return
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    area.focus({ preventScroll: true })
    area.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0))
  }

  const apply = async (position: ImportPosition) => {
    setConfirmReplace(false)
    const n = await importParsed(parsed, position)
    const parts = [`Добавлено ${n} ${plural(n, 'правило', 'правила', 'правил')}`]
    if (parsed.deletions.length) parts.push(`удаление: ${parsed.deletions.length}`)
    if (parsed.defaultBehavior) parts.push(`по умолчанию — ${DEFAULT_BEHAVIOR_LABEL[parsed.defaultBehavior].toLowerCase()}`)
    toast(parts.join(', '), 'success')
    setText('')
    onApplied()
  }

  const openFile = async () => {
    try {
      const t = await window.api.rules.openText()
      if (t !== null) setText(t)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const exportCurrent = () => setText(toClashLines({ rules, defaultBehavior }))

  const saveFile = async () => {
    try {
      const path = await window.api.rules.saveText(text || toClashLines({ rules, defaultBehavior }))
      if (path) toast('Файл сохранён', 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const copy = async () => {
    await navigator.clipboard.writeText(text || toClashLines({ rules, defaultBehavior }))
    toast('Скопировано', 'success')
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4 px-7 pb-6">
      {/* editor */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-card border border-border-default bg-bg-panel-alt">
        <div className="flex items-center gap-0.5 overflow-hidden border-b border-border-subtle px-2 py-1.5">
          <ToolButton onClick={() => void openFile()} icon={<FileIcon width={14} height={14} />}>
            Файл…
          </ToolButton>
          <ToolButton onClick={exportCurrent} icon={<UpdateIcon width={14} height={14} className="rotate-180" />}>
            Текущие правила
          </ToolButton>
          <div className="flex-1" />
          <ToolButton onClick={() => void copy()} icon={<CopyIcon width={14} height={14} />} title="Скопировать текст (или текущие правила, если пусто)">
            Копировать
          </ToolButton>
          <ToolButton onClick={() => void saveFile()} icon={<FileIcon width={14} height={14} />} title="Сохранить как Clash-строки">
            Экспорт…
          </ToolButton>
          <ToolButton onClick={() => setText('')} icon={<TrashIcon width={14} height={14} />} disabled={!text}>
            Очистить
          </ToolButton>
        </div>

        <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
          <div className="flex min-h-full" style={{ minWidth: `calc(${widthCh}ch + 56px)` }}>
            {/* gutter */}
            <div
              className="sticky left-0 z-10 w-12 shrink-0 select-none border-r border-border-subtle bg-bg-panel-alt text-right font-mono text-[11px] text-text-faint"
              style={{ paddingTop: PAD_Y, paddingBottom: PAD_Y }}
            >
              {lines.map((_, i) => (
                <div
                  key={i}
                  style={{ height: LINE_H, lineHeight: `${LINE_H}px` }}
                  className={cn(
                    'pr-2',
                    errorLines.has(i + 1) && 'text-accent-red',
                    okLines.has(i + 1) && 'text-accent-green/70'
                  )}
                >
                  {errorLines.has(i + 1) ? '●' : i + 1}
                </div>
              ))}
            </div>
            {/* text + error stripes */}
            <div className="relative flex-1">
              <div aria-hidden className="pointer-events-none absolute inset-x-0" style={{ top: PAD_Y }}>
                {parsed.skipped.map((s) => (
                  <div
                    key={`${s.line}-${s.reason}`}
                    className="absolute inset-x-0 border-l-2 border-accent-red bg-accent-red/10"
                    style={{ top: (s.line - 1) * LINE_H, height: LINE_H }}
                  />
                ))}
              </div>
              <textarea
                ref={areaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                wrap="off"
                placeholder={PLACEHOLDER}
                className="relative block w-full resize-none overflow-hidden bg-transparent px-3 font-mono text-[12.5px] text-text-primary outline-none placeholder:text-text-faint select-text"
                style={{
                  lineHeight: `${LINE_H}px`,
                  paddingTop: PAD_Y,
                  paddingBottom: PAD_Y,
                  height: Math.max(lines.length, 12) * LINE_H + PAD_Y * 2,
                  tabSize: 2
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* preview */}
      <div className="flex w-[290px] shrink-0 flex-col overflow-hidden rounded-card border border-border-default bg-bg-panel">
        <div className="border-b border-border-subtle px-4 py-3">
          <div className="text-[11px] text-text-muted">Формат: {FORMAT_LABEL[parsed.format]}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={cn('text-3xl font-bold tabular-nums', count ? 'text-accent-green' : 'text-text-faint')}>
              {count}
            </span>
            <span className="text-sm text-text-muted">{plural(count, 'правило', 'правила', 'правил')} будет добавлено</span>
          </div>
          <ul className="mt-2 space-y-1 text-[11px] text-text-muted">
            {(pre > 0 || post > 0) && (
              <li>
                из них всегда в начало: {pre}, в конец: {post}
              </li>
            )}
            {parsed.deletions.length > 0 && <li>будет удалено существующих: {parsed.deletions.length}</li>}
            {parsed.defaultBehavior && (
              <li>
                по умолчанию: <span className="text-text-secondary">{DEFAULT_BEHAVIOR_LABEL[parsed.defaultBehavior]}</span>
              </li>
            )}
          </ul>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {parsed.skipped.length > 0 ? (
            <>
              <div className="flex items-center gap-1.5 px-2 pb-1.5 text-xs font-medium text-accent-amber">
                <AlertIcon width={14} height={14} />
                Пропущено {parsed.skipped.length} {plural(parsed.skipped.length, 'строка', 'строки', 'строк')}
              </div>
              {parsed.skipped.map((s) => (
                <button
                  key={`${s.line}-${s.reason}`}
                  onClick={() => goto(s.line)}
                  className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-bg-elevated"
                >
                  <div className="truncate font-mono text-[11px] text-text-secondary">
                    <span className="text-accent-red">{s.line}</span> {s.text}
                  </div>
                  <div className="text-[10.5px] text-text-faint">{s.reason}</div>
                </button>
              ))}
            </>
          ) : count > 0 ? (
            <div className="flex items-center gap-1.5 px-2 text-xs text-accent-green">
              <CheckIcon width={14} height={14} />
              Все строки распознаны
            </div>
          ) : (
            <p className="px-2 text-[11px] leading-relaxed text-text-faint">
              Поддерживаются DOMAIN, DOMAIN-SUFFIX, DOMAIN-KEYWORD, DOMAIN-REGEX, GEOSITE, GEOIP,
              IP-CIDR, IP-CIDR6, PROCESS-NAME, PROCESS-PATH, DST-PORT и MATCH. DIRECT — напрямую,
              REJECT — блок, PROXY и любое имя группы или сервера — через VPN.
            </p>
          )}
        </div>

        <div className="space-y-2 border-t border-border-subtle p-3">
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" disabled={!canApply} onClick={() => void apply('start')}>
              В начало
            </Button>
            <Button size="sm" disabled={!canApply} onClick={() => void apply('end')}>
              В конец
            </Button>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            disabled={count === 0}
            onClick={() => setConfirmReplace(true)}
          >
            Заменить все правила
          </Button>
        </div>
      </div>

      <Modal
        open={confirmReplace}
        onClose={() => setConfirmReplace(false)}
        title="Заменить все правила?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReplace(false)}>
              Отмена
            </Button>
            <Button variant="danger" onClick={() => void apply('replace')}>
              Заменить
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          Текущие правила ({rules.length}) будут удалены, вместо них появятся {count} новых. Сохранить
          старые можно кнопкой «Экспорт…» перед заменой.
        </p>
      </Modal>
    </div>
  )
}

function ToolButton({
  children,
  icon,
  onClick,
  disabled,
  title
}: {
  children: React.ReactNode
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
    >
      {icon}
      {children}
    </button>
  )
}
