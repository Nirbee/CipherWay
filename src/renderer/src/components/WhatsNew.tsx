import { useEffect, useRef, useState } from 'react'
import type { ChangelogEntry } from '@shared/changelog'
import { Button, Modal } from './ui'
import { CloseIcon } from './icons'

const AUTO_HIDE_MS = 15_000
const TICK_MS = 500
const CARD_ITEMS = 3

/** the user can actually see the card: the window is shown and in front */
const windowWatched = (): boolean => document.visibilityState === 'visible' && document.hasFocus()

/**
 * «Что нового» after an update: a small card in the top-right corner (below the
 * title bar, away from the toasts) with the first bullets. × or «Подробнее»
 * (the whole list) count it as seen. Otherwise it hides by itself after 15 s of
 * the window being visible AND in focus (not while the mouse is over it) — and
 * comes back on the next start, it may have gone unread. Shown only once the
 * window is visible — the app may start hidden in the tray.
 */
export function WhatsNew() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([])
  const [card, setCard] = useState(false)
  const [full, setFull] = useState(false)
  const hover = useRef(false)

  useEffect(() => {
    let cancelled = false
    let onVisible: (() => void) | null = null
    const show = (list: ChangelogEntry[]): void => {
      if (cancelled || list.length === 0) return
      setEntries(list)
      setCard(true)
    }
    void window.api.whatsNew.get().then((list) => {
      if (cancelled) return
      if (document.visibilityState === 'visible') return show(list)
      onVisible = (): void => {
        if (document.visibilityState !== 'visible') return
        if (onVisible) document.removeEventListener('visibilitychange', onVisible)
        onVisible = null
        show(list)
      }
      document.addEventListener('visibilitychange', onVisible)
    })
    return () => {
      cancelled = true
      if (onVisible) document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  useEffect(() => {
    if (!card) return
    // counts only while the user can see it (shown, focused, the mouse elsewhere)
    let left = AUTO_HIDE_MS
    const t = setInterval(() => {
      if (hover.current || !windowWatched()) return
      left -= TICK_MS
      if (left <= 0) setCard(false)
    }, TICK_MS)
    return () => clearInterval(t)
  }, [card])

  if (entries.length === 0) return null
  const newest = entries[0]
  const shown = newest.items.slice(0, CARD_ITEMS)
  const more = entries.reduce((n, e) => n + e.items.length, 0) - shown.length
  const seen = (): void => window.api.whatsNew.seen()

  return (
    <>
      {card && (
        <div
          role="status"
          className="animate-toast fixed right-5 top-14 z-[55] w-[340px] rounded-xl border border-accent-green/30 bg-bg-elevated/95 p-4 shadow-2xl backdrop-blur"
          onMouseEnter={() => (hover.current = true)}
          onMouseLeave={() => (hover.current = false)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="text-[13px] font-semibold text-text-primary">
              Что нового в версии {newest.version}
            </div>
            <button
              onClick={() => {
                setCard(false)
                seen()
              }}
              title="Закрыть"
              className="no-drag -mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-bg-panel hover:text-text-primary"
            >
              <CloseIcon width={14} height={14} />
            </button>
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] leading-snug text-text-secondary">
            {shown.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <button
            className="no-drag mt-2.5 text-[12px] font-medium text-accent-green hover:underline"
            onClick={() => {
              setCard(false)
              setFull(true)
              seen()
            }}
          >
            Подробнее{more > 0 ? ` (ещё ${more})` : ''}
          </button>
        </div>
      )}
      <ChangelogModal open={full} entries={entries} onClose={() => setFull(false)} />
    </>
  )
}

/** The list of versions and their bullets (after an update, and from «Настройки»). */
export function ChangelogModal({
  open,
  entries,
  onClose
}: {
  open: boolean
  entries: ChangelogEntry[]
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Что нового"
      width="max-w-md"
      footer={
        <Button size="sm" onClick={onClose}>
          Понятно
        </Button>
      }
    >
      <div className="space-y-4">
        {entries.map((e) => (
          <div key={e.version}>
            <div className="text-[13px] font-semibold text-text-primary">Версия {e.version}</div>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-text-muted">
              {e.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  )
}
