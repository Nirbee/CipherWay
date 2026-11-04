import type {
  SupportMe,
  SupportPhoto,
  SupportSendResult,
  SupportThread,
  SupportView
} from '@shared/types'
import { latestSupportAt, SupportError, supportMessagesSince, type SupportClient } from './client'

// ---------------------------------------------------------------------------
// Polling + unread state of the support chat (main process).
//  - «Поддержка» open (and the window visible): every 10 s
//  - otherwise: every 60 s while there is an open ticket; without a ticket
//    nobody can answer, so only every 10 min (keeps the load on the cabinet low)
//  - 401: no background polling until the subscription changes; 429: wait 60 s
// A new support reply → Windows notification (unless the page is in front)
// and a badge on the menu item.
// ---------------------------------------------------------------------------

export const POLL_ACTIVE_MS = 10_000
export const POLL_BACKGROUND_MS = 60_000
export const POLL_IDLE_MS = 10 * 60_000

export interface SupportDeps {
  client: SupportClient
  hasSubscription: () => boolean
  getReadAt: () => string | null
  setReadAt: (iso: string | null) => void
  getNotifiedAt: () => string | null
  setNotifiedAt: (iso: string | null) => void
  publish: (view: SupportView) => void
  /** Windows notification for a new reply */
  notify: (text: string) => void
  /** window visible and focused (the page counts as «seen» only then) */
  isWindowFocused: () => boolean
}

function closedStatus(status: string | null): boolean {
  return !!status && /closed|resolved|закрыт/i.test(status)
}

export class SupportService {
  private thread: SupportThread | null = null
  private me: SupportMe | null = null
  private error: string | null = null
  private updatedAt: number | null = null
  private active = false
  private authFailed = false
  private rateLimitedUntil = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<SupportView> | null = null
  private stopped = true

  constructor(private d: SupportDeps) {}

  view(): SupportView {
    const readAt = this.d.getReadAt()
    return {
      available: this.d.hasSubscription(),
      thread: this.thread,
      me: this.me,
      unread: this.thread ? supportMessagesSince(this.thread.messages, readAt).length : 0,
      error: this.error,
      updatedAt: this.updatedAt
    }
  }

  start(firstDelayMs = 5000): void {
    this.stopped = false
    this.schedule(firstDelayMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** The subscription changed: forget the old user and the auth failure. */
  reset(): void {
    this.thread = null
    this.me = null
    this.error = null
    this.updatedAt = null
    this.authFailed = false
    this.d.publish(this.view())
    if (!this.stopped) this.schedule(1000)
  }

  /** «Поддержка» opened / closed (or the window hidden) in the renderer. */
  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    if (active) void this.refresh().catch(() => undefined)
    else if (!this.stopped) this.schedule(this.interval())
  }

  /** Everything up to now has been seen on the page. */
  markRead(): void {
    const latest = this.thread ? latestSupportAt(this.thread.messages) : null
    if (latest && latest !== this.d.getReadAt()) {
      this.d.setReadAt(latest)
      this.d.publish(this.view())
    }
  }

  private interval(): number {
    if (this.active) return POLL_ACTIVE_MS
    if (!this.thread?.ticketId || closedStatus(this.thread.status)) return POLL_IDLE_MS
    return POLL_BACKGROUND_MS
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.stopped) return
    const wait = Math.max(ms, this.rateLimitedUntil - Date.now())
    this.timer = setTimeout(() => void this.tick(), wait)
  }

  private async tick(): Promise<void> {
    this.timer = null
    // no subscription / rejected token: only poll while the page is open
    const canPoll = this.d.hasSubscription() && (!this.authFailed || this.active)
    if (canPoll) await this.refresh().catch(() => undefined)
    this.schedule(this.interval())
  }

  /** Fetches the thread now (shared by concurrent callers). */
  refresh(): Promise<SupportView> {
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doRefresh(): Promise<SupportView> {
    if (!this.d.hasSubscription()) {
      this.thread = null
      this.error = null
      this.d.publish(this.view())
      return this.view()
    }
    try {
      const thread = await this.d.client.getThread()
      this.thread = thread
      this.error = null
      this.authFailed = false
      this.updatedAt = Date.now()
      if (!this.me) this.me = await this.d.client.me().catch(() => null)
      this.handleNew(thread)
    } catch (e) {
      this.onError(e)
    }
    const v = this.view()
    this.d.publish(v)
    if (!this.stopped && this.active) this.schedule(this.interval())
    return v
  }

  private onError(e: unknown): void {
    if (e instanceof SupportError) {
      this.error = e.message
      if (e.kind === 'auth') this.authFailed = true
      if (e.kind === 'rate') this.rateLimitedUntil = Date.now() + 60_000
    } else {
      this.error = e instanceof Error ? e.message : String(e)
    }
  }

  /** New replies → notification (once per reply); the open page marks them read. */
  private handleNew(thread: SupportThread): void {
    const latest = latestSupportAt(thread.messages)
    const notifiedAt = this.d.getNotifiedAt()
    if (notifiedAt === null) {
      // first fetch ever on this machine: old history is no news
      this.d.setNotifiedAt(latest)
      if (this.d.getReadAt() === null) this.d.setReadAt(latest)
      return
    }
    const fresh = supportMessagesSince(thread.messages, notifiedAt)
    if (fresh.length) {
      this.d.setNotifiedAt(latest)
      const seen = this.active && this.d.isWindowFocused()
      if (!seen) {
        const last = fresh[fresh.length - 1]
        this.d.notify(last.text ? last.text.slice(0, 180) : 'Поддержка прислала картинку')
      }
    }
    if (this.active && this.d.isWindowFocused() && latest) this.d.setReadAt(latest)
  }

  async send(text: string): Promise<SupportSendResult> {
    const res = await this.withErrors(() => this.d.client.sendText(text))
    await this.refresh()
    return res
  }

  async sendPhoto(photo: SupportPhoto): Promise<SupportSendResult> {
    const res = await this.withErrors(() => this.d.client.sendPhoto(photo))
    await this.refresh()
    return res
  }

  image(url: string): Promise<string> {
    return this.d.client.image(url)
  }

  private async withErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof SupportError) {
        if (e.kind === 'auth') this.authFailed = true
        if (e.kind === 'rate') this.rateLimitedUntil = Date.now() + 60_000
      }
      throw e
    }
  }
}
