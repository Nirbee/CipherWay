import { gunzip, gzip } from 'node:zlib'
import { promisify } from 'node:util'
import type { DevLastUpload } from '@shared/devversion'
import { TelemetryError, type TelemetryApi } from './api'
import { Backoff, type DiskQueue } from './queue'
import { fitReport, jsonBytes } from './report'

// ---------------------------------------------------------------------------
// DevVersion: sends the queued reports, oldest first.
//   202 → removed · 413 → cut in half and kept (dropped if it can't shrink) ·
//   400 / 422 (this report breaks the contract) → dropped, the reason shown ·
//   429 (6/h, 60/day, 20 MB/day) → wait Retry-After (or 15 min) ·
//   network / 5xx / 503 → backoff 1…60 min ·
//   403 (inactive / trial_not_allowed / not_allowed) / 404 telemetry_disabled /
//   404 / 401 / 415 → paused with a status on «Статистика» until the config is
//   fetched again (daily) or the user presses «Отправить сейчас».
// gzip / gunzip run in libuv's thread pool (async). Unit tested in
// uploader.test.ts with a fake API.
// ---------------------------------------------------------------------------

export const gzipAsync = promisify(gzip)
export const gunzipAsync = promisify(gunzip)

export type PauseKind =
  | 'server_off'
  | 'inactive'
  | 'trial'
  | 'not_allowed'
  | 'forbidden'
  | 'auth'
  | 'not_found'
  | 'unsupported'
  | 'consent'
  | 'nosub'

export const PAUSE_TEXT: Record<PauseKind, string> = {
  server_off: 'Сбор выключен на сервере CipherWay — отчёты не отправляются.',
  inactive: 'Подписка не активна — отчёты не отправляются, пока её не продлят.',
  trial: 'DevVersion недоступна на пробном периоде — отчёты не отправляются.',
  not_allowed: 'DevVersion пока доступна не всем подпискам — отчёты не отправляются.',
  forbidden: 'Сервер CipherWay отказал в приёме отчётов.',
  auth: 'Не удалось войти — обновите подписку на странице «Подписка».',
  not_found: 'Сервер CipherWay пока не принимает отчёты DevVersion.',
  unsupported: 'Сервер CipherWay не принимает формат отчёта этой версии — обновите приложение.',
  consent: 'Обновились условия DevVersion — выключите и снова включите режим, чтобы принять их.',
  nosub: 'Нет подписки — отчёты некому отправить.'
}

const RATE_WAIT_MS = 15 * 60_000
/** at most this many reports per run: the server allows 6 an hour */
const MAX_PER_RUN = 3

export interface UploaderDeps {
  api: Pick<TelemetryApi, 'upload'>
  queue: DiskQueue
  maxBytes: () => number
  log?: (msg: string) => void
  now?: () => number
}

export interface UploadRun {
  sent: number
  dropped: number
  /** the queue stopped because of this */
  stop?: 'paused' | 'backoff' | 'rate'
}

export class Uploader {
  readonly backoff = new Backoff()
  paused: PauseKind | null = null
  last: DevLastUpload | null = null
  private running: Promise<UploadRun> | null = null

  constructor(private d: UploaderDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  /** One pass over the queue (concurrent calls share it). */
  run(force = false): Promise<UploadRun> {
    this.running ??= this.doRun(force).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async doRun(force: boolean): Promise<UploadRun> {
    const res: UploadRun = { sent: 0, dropped: 0 }
    if (this.paused && !force) return { ...res, stop: 'paused' }
    if (!force && !this.backoff.ready(this.now())) return { ...res, stop: 'backoff' }
    const items = await this.d.queue.list()
    let shrinks = 0
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (res.sent >= MAX_PER_RUN) break
      const gz = await this.d.queue.read(item.name).catch(() => null)
      if (!gz) continue
      try {
        await this.d.api.upload(gz)
        await this.d.queue.remove(item.name)
        res.sent++
        this.paused = null
        this.backoff.succeed()
        this.last = { at: this.now(), ok: true, text: 'Отчёт принят сервером' }
        shrinks = 0
      } catch (e) {
        const err = e instanceof TelemetryError ? e : new TelemetryError('network')
        if (err.kind === 'rejected') {
          // this report breaks the contract: sending it again won't help
          await this.d.queue.remove(item.name)
          res.dropped++
          shrinks = 0
          const why = `${err.status ?? ''}${err.detail ? `: ${err.detail}` : ''}`
          this.last = {
            at: this.now(),
            ok: false,
            text: `Сервер отклонил отчёт (${why}) — он пропущен`
          }
          this.d.log?.(`DevVersion: отчёт отклонён (${why})`)
          continue
        }
        if (err.kind === 'too_large') {
          // cut in half and the same report again (a few times at most)
          if (shrinks++ < 6 && (await this.shrink(item.name, gz))) {
            i--
            continue
          }
          await this.d.queue.remove(item.name)
          res.dropped++
          shrinks = 0
          this.last = {
            at: this.now(),
            ok: false,
            text: 'Отчёт слишком большой даже после сокращения — пропущен'
          }
          continue
        }
        const stop = this.onError(err)
        return { ...res, stop }
      }
    }
    return res
  }

  /** 413: the same report, about half the size; false = nothing left to cut. */
  private async shrink(name: string, gz: Buffer): Promise<boolean> {
    try {
      const report = JSON.parse((await gunzipAsync(gz)).toString('utf8')) as Record<string, unknown>
      const size = jsonBytes(report)
      const target = Math.min(this.d.maxBytes(), Math.floor(size / 2))
      if (target < 4096) return false
      const smaller = fitReport(report, target)
      if (!smaller) return false
      await this.d.queue.replace(
        name,
        await gzipAsync(Buffer.from(JSON.stringify(smaller), 'utf8'))
      )
      this.d.log?.(`DevVersion: отчёт сокращён до ${Math.round(target / 1024)} КБ (413)`)
      return true
    } catch {
      return false
    }
  }

  private onError(err: TelemetryError): UploadRun['stop'] {
    const now = this.now()
    switch (err.kind) {
      case 'rate':
        this.backoff.fail(now, err.retryAfterMs ?? RATE_WAIT_MS)
        this.last = { at: now, ok: false, text: 'Сервер просит отправлять реже — повторим позже' }
        return 'rate'
      case 'disabled':
        this.paused = 'server_off'
        this.last = { at: now, ok: false, text: PAUSE_TEXT.server_off }
        return 'paused'
      case 'inactive':
      case 'trial':
      case 'not_allowed':
      case 'forbidden':
      case 'auth':
      case 'not_found':
      case 'unsupported':
      case 'nosub':
        this.paused = err.kind
        this.last = { at: now, ok: false, text: PAUSE_TEXT[err.kind] }
        return 'paused'
      default: {
        const wait = this.backoff.fail(now)
        this.last = {
          at: now,
          ok: false,
          text:
            err.kind === 'network'
              ? `Нет связи с сервером CipherWay — повтор через ${Math.max(1, Math.round(wait / 60_000))} мин`
              : `Сервер CipherWay ответил ошибкой${err.status ? ` (${err.status})` : ''} — повтор через ${Math.max(1, Math.round(wait / 60_000))} мин`
        }
        return 'backoff'
      }
    }
  }

  reset(): void {
    this.paused = null
    this.last = null
    this.backoff.succeed()
  }
}
