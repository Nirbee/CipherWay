import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { SupportImageMime, SupportMessage } from '@shared/types'
import { buildDiagnostics } from '@shared/diagnostics'
import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/EmptyState'
import { Button } from '../components/ui'
import {
  AlertIcon,
  CardIcon,
  CloseIcon,
  ExternalIcon,
  PaperclipIcon,
  RefreshIcon,
  SendIcon,
  StethoscopeIcon,
  SupportIcon
} from '../components/icons'
import { useSupport } from '../store/supportStore'
import { useNav } from '../store/navStore'
import { useLogs } from '../store/logsStore'
import { useSettings } from '../store/settingsStore'
import { useConnection } from '../store/connectionStore'
import { useSubscription } from '../store/subscriptionStore'
import { openLink, useLinks } from '../hooks/useLinks'
import { toast } from '../store/toastStore'
import { formatBytes } from '../lib/format'
import { cn } from '../lib/cn'

const TEXT_MAX = 4096
const CAPTION_MAX = 1000
const IMAGE_MAX = 10 * 1024 * 1024
const MIMES: SupportImageMime[] = ['image/png', 'image/jpeg', 'image/webp']

interface Attachment {
  data: Uint8Array
  mime: SupportImageMime
  name: string
  preview: string
}

// TicketStatus values the bot sends (src/core/enums.py in the bot repo)
const STATUS_TEXT: Record<string, string> = {
  open: 'ждёт ответа поддержки',
  waiting: 'есть ответ',
  closed: 'закрыто'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${time}`
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

async function toAttachment(file: File): Promise<Attachment | string> {
  if (!MIMES.includes(file.type as SupportImageMime))
    return 'Можно приложить картинку PNG, JPG или WebP'
  if (file.size > IMAGE_MAX) return `Картинка ${formatBytes(file.size)} — больше 10 МБ`
  const data = new Uint8Array(await file.arrayBuffer())
  return {
    data,
    mime: file.type as SupportImageMime,
    name: file.name || 'скриншот.png',
    preview: await readAsDataUrl(file)
  }
}

/** Images of the thread come from main as data: URLs (cached for the session). */
const imageCache = new Map<string, Promise<string>>()
function loadImage(url: string): Promise<string> {
  let p = imageCache.get(url)
  if (!p) {
    p = window.api.support.image(url)
    p.catch(() => imageCache.delete(url))
    imageCache.set(url, p)
  }
  return p
}

function ThreadImage({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    loadImage(url).then(
      (s) => alive && setSrc(s),
      () => alive && setFailed(true)
    )
    return () => {
      alive = false
    }
  }, [url])
  if (failed) return <div className="text-[11px] italic opacity-70">картинка не загрузилась</div>
  if (!src) return <div className="h-32 w-48 animate-pulse rounded-lg bg-black/20" />
  return <img src={src} alt="" className="max-h-72 max-w-full rounded-lg object-contain" />
}

export function SupportPage() {
  const { view, loading, sending, sendError, refresh, sendText, sendPhoto, clearSendError } =
    useSupport()
  const setPage = useNav((s) => s.setPage)
  const { supportUrl } = useLinks()
  const [text, setText] = useState('')
  const [att, setAtt] = useState<Attachment | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // on screen → main polls every 10 s and counts replies as read
  useEffect(() => {
    const sync = () => window.api.support.setActive(document.visibilityState === 'visible')
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      window.api.support.setActive(false)
    }
  }, [])

  const unread = view?.unread ?? 0
  useEffect(() => {
    if (unread > 0 && document.visibilityState === 'visible') window.api.support.markRead()
  }, [unread])

  const messages = view?.thread?.messages ?? []
  const last = messages.at(-1)?.key
  // stick to the bottom while the user hasn't scrolled up (images load later)
  const stickRef = useRef(true)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
    stickRef.current = true
  }, [last])
  useEffect(() => {
    const el = listRef.current
    const content = contentRef.current
    if (!el || !content) return
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [messages.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickFile = async (file: File | undefined | null) => {
    if (!file) return
    const res = await toAttachment(file)
    if (typeof res === 'string') toast(res, 'error')
    else setAtt(res)
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const item = [...e.clipboardData.items].find(
      (i) => i.kind === 'file' && i.type.startsWith('image/')
    )
    if (!item) return
    e.preventDefault()
    void pickFile(item.getAsFile())
  }

  const trimmed = text.trim()
  const canSend = !sending && (trimmed.length > 0 || !!att) && trimmed.length <= TEXT_MAX

  const send = async () => {
    if (!canSend) return
    let ok = true
    if (att) {
      // a long text goes as its own message, the screenshot right after it
      if (trimmed.length > CAPTION_MAX) ok = await sendText(trimmed)
      if (ok) ok = await sendPhoto(att.data, att.mime, trimmed.length > CAPTION_MAX ? '' : trimmed)
    } else {
      ok = await sendText(trimmed)
    }
    if (ok) {
      setText('')
      setAtt(null)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const sendDiagnostics = async () => {
    const [version, settings] = await Promise.all([
      window.api.app.getVersion(),
      Promise.resolve(useSettings.getState().settings)
    ])
    const blob = buildDiagnostics(
      {
        version,
        state: useConnection.getState().state,
        servers: useSubscription.getState().data?.servers.length ?? 0,
        settings,
        logs: useLogs.getState().entries
      },
      TEXT_MAX - 100
    )
    if (await sendText(blob))
      toast('Диагностика отправлена — адреса серверов и ссылка подписки в ней скрыты', 'success')
  }

  if (view && !view.available) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Поддержка" />
        <EmptyState
          className="flex-1"
          icon={<CardIcon width={24} height={24} />}
          title="Сначала добавьте подписку"
          text="Чат поддержки работает по вашей подписке CipherWay — так мы сразу видим ваш аккаунт."
          action={
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setPage('subscription')}>
                Добавить подписку
              </Button>
              {supportUrl && (
                <Button size="sm" variant="secondary" onClick={() => openLink(supportUrl)}>
                  Написать в Telegram
                  <ExternalIcon width={13} height={13} />
                </Button>
              )}
            </div>
          }
        />
      </div>
    )
  }

  const thread = view?.thread
  const status = thread?.status ? (STATUS_TEXT[thread.status.toLowerCase()] ?? thread.status) : null
  const error = sendError ?? view?.error ?? null

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Поддержка"
        subtitle="Опишите проблему — ответ придёт сюда, а Windows покажет уведомление."
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              disabled={loading}
              title="Проверить новые сообщения"
            >
              <RefreshIcon width={14} height={14} className={cn(loading && 'animate-spin')} />
              Обновить
            </Button>
            {supportUrl && (
              <Button variant="secondary" size="sm" onClick={() => openLink(supportUrl)}>
                Написать в Telegram
                <ExternalIcon width={13} height={13} />
              </Button>
            )}
          </>
        }
      />

      {(thread?.ticketId || view?.me?.username) && (
        <div className="mx-7 mb-2 flex items-center gap-2 text-[11.5px] text-text-muted">
          {thread?.ticketId && <span>Обращение №{thread.ticketId}</span>}
          {status && (
            <span className="rounded-pill bg-accent-green/15 px-2 py-0.5 text-[11px] font-medium text-accent-green">
              {status}
            </span>
          )}
          {view?.me?.username && (
            <span className="ml-auto truncate">
              Аккаунт: <span className="text-text-secondary">@{view.me.username}</span>
            </span>
          )}
        </div>
      )}

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="mx-7 min-h-0 flex-1 overflow-y-auto rounded-card border border-border-default bg-bg-panel-alt p-4"
      >
        {messages.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<SupportIcon width={24} height={24} />}
            title={view ? 'Здесь пока пусто' : 'Загружаем переписку…'}
            text="Напишите, что случилось: какой сервер, что не открывается, с какого времени. Скриншот можно вставить через Ctrl+V."
          />
        ) : (
          <div ref={contentRef} className="flex flex-col gap-2.5">
            {messages.map((m) => (
              <Bubble key={m.key} m={m} />
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="animate-fade mx-7 mt-3 flex items-center gap-2.5 rounded-xl bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
          <AlertIcon width={15} height={15} className="shrink-0" />
          <span className="flex-1">{error}</span>
          {sendError && (
            <button
              onClick={clearSendError}
              className="opacity-70 hover:opacity-100"
              title="Скрыть"
            >
              <CloseIcon width={13} height={13} />
            </button>
          )}
        </div>
      )}

      <div className="mx-7 mb-6 mt-3 rounded-card border border-border-default bg-bg-panel p-3">
        {att && (
          <div className="animate-fade mb-2.5 flex items-center gap-3 rounded-xl bg-bg-panel-alt p-2">
            <img src={att.preview} alt="" className="h-12 w-16 rounded-lg object-cover" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-text-primary">{att.name}</div>
              <div className="text-[11px] text-text-faint">
                {formatBytes(att.data.byteLength)} · текст сообщения станет подписью
              </div>
            </div>
            <button
              onClick={() => setAtt(null)}
              className="rounded-md p-1 text-text-muted hover:bg-bg-elevated hover:text-text-primary"
              title="Убрать картинку"
            >
              <CloseIcon width={14} height={14} />
            </button>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={2}
          maxLength={TEXT_MAX}
          placeholder="Сообщение в поддержку… Enter — отправить, Shift+Enter — новая строка"
          className="no-drag w-full resize-none bg-transparent px-1.5 py-1 text-sm text-text-primary outline-none placeholder:text-text-faint select-text"
        />
        <div className="mt-2 flex items-center gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept={MIMES.join(',')}
            className="hidden"
            onChange={(e) => {
              void pickFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={sending}
          >
            <PaperclipIcon width={15} height={15} />
            Скриншот
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void sendDiagnostics()}
            disabled={sending}
          >
            <StethoscopeIcon width={15} height={15} />
            Приложить диагностику
          </Button>
          <span
            className={cn(
              'ml-auto font-mono text-[11px] tabular-nums',
              trimmed.length > (att ? CAPTION_MAX : TEXT_MAX) * 0.9
                ? 'text-accent-amber'
                : 'text-text-faint'
            )}
          >
            {trimmed.length > 0 ? `${trimmed.length}/${TEXT_MAX}` : ''}
          </span>
          <Button size="sm" onClick={() => void send()} disabled={!canSend}>
            <SendIcon width={14} height={14} />
            {sending ? 'Отправляем…' : 'Отправить'}
          </Button>
        </div>
      </div>
    </div>
  )
}

const DIAG_HEAD = 'CipherWay VPN — диагностика'

function Bubble({ m }: { m: SupportMessage }) {
  const mine = m.from === 'you'
  const diag = m.text.startsWith(DIAG_HEAD)
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('animate-fade flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed',
          mine
            ? 'rounded-br-md bg-accent-blue/90 text-white'
            : 'rounded-bl-md border border-border-subtle bg-bg-elevated text-text-secondary'
        )}
      >
        {!mine && (
          <div className="mb-0.5 text-[11px] font-semibold text-accent-green">
            Поддержка CipherWay
          </div>
        )}
        {m.image && (
          <div className={cn(m.text && 'mb-1.5')}>
            <ThreadImage url={m.image} />
          </div>
        )}
        {m.text && diag ? (
          <div>
            <button
              onClick={() => setOpen((v) => !v)}
              className="flex items-center gap-1.5 font-medium underline-offset-2 hover:underline"
            >
              <StethoscopeIcon width={14} height={14} />
              Диагностика · {m.text.split('\n').length} строк {open ? '▴' : '▾'}
            </button>
            {open && (
              <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug opacity-90 select-text">
                {m.text}
              </pre>
            )}
          </div>
        ) : (
          m.text && <div className="whitespace-pre-wrap break-words select-text">{m.text}</div>
        )}
        <div
          className={cn(
            'mt-1 text-right text-[10.5px]',
            mine ? 'text-white/65' : 'text-text-faint'
          )}
        >
          {formatTime(m.at)}
        </div>
      </div>
    </div>
  )
}
