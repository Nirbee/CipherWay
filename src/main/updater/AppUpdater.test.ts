import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdaterState } from '@shared/updater'
import { AppUpdater, type UpdaterBackend } from './AppUpdater'

/** A controllable electron-updater stand-in. */
function fakeBackend() {
  const h = {
    check: vi.fn<() => Promise<string | null>>(async () => null),
    download: vi.fn<() => Promise<void>>(async () => undefined),
    quitAndInstall: vi.fn<() => void>(),
    installOnQuit: null as boolean | null,
    progress: (_p: number) => undefined as void,
    downloaded: (_v: string) => undefined as void,
    error: (_e: unknown) => undefined as void
  }
  const backend: UpdaterBackend = {
    check: () => h.check(),
    download: () => h.download(),
    quitAndInstall: () => h.quitAndInstall(),
    setInstallOnQuit: (on) => {
      h.installOnQuit = on
    },
    onProgress: (cb) => {
      h.progress = cb
    },
    onDownloaded: (cb) => {
      h.downloaded = cb
    },
    onError: (cb) => {
      h.error = cb
    }
  }
  return { h, backend }
}

function make(opts: { enabled?: boolean; autoDownload?: boolean } = {}) {
  const { h, backend } = fakeBackend()
  const states: UpdaterState[] = []
  const logs: string[] = []
  const order: string[] = []
  const onReady = vi.fn()
  const u = new AppUpdater({
    backend,
    enabled: opts.enabled ?? true,
    autoDownload: opts.autoDownload,
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    onState: (s) => states.push(s),
    onReady,
    beforeInstall: async () => {
      order.push('cores stopped')
    }
  })
  h.quitAndInstall.mockImplementation(() => void order.push('installer'))
  return { u, h, states, logs, order, onReady }
}

describe('AppUpdater', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('installs on quit by default (the installer runs after «Выход»)', () => {
    const { h } = make()
    expect(h.installOnQuit).toBe(true)
  })

  it('nothing new: «Версия актуальна»', async () => {
    const { u } = make()
    await u.check()
    expect(u.state.phase).toBe('not-available')
    expect(u.state.checkedAt).not.toBeNull()
  })

  it('found → downloads in the background → ready, one onReady', async () => {
    const { u, h, onReady } = make()
    h.check.mockResolvedValue('0.4.5')
    h.download.mockImplementation(async () => {
      h.progress(42.4)
      expect(u.state).toMatchObject({ phase: 'downloading', percent: 42 })
      h.downloaded('0.4.5')
    })
    await u.checkInBackground()
    await vi.waitFor(() => expect(u.state.phase).toBe('downloaded'))
    expect(u.state.version).toBe('0.4.5')
    expect(u.readyToInstall).toBe(true)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith('0.4.5')
  })

  it('without autoDownload the button waits at «available»', async () => {
    const { u, h } = make({ autoDownload: false })
    h.check.mockResolvedValue('0.4.5')
    await u.checkInBackground()
    expect(u.state.phase).toBe('available')
    expect(h.download).not.toHaveBeenCalled()
  })

  it('background check failure: no error on screen, only the journal', async () => {
    const { u, h, logs } = make()
    await u.check() // «Версия актуальна»
    h.check.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'))
    await u.checkInBackground()
    expect(u.state.phase).toBe('not-available')
    expect(u.state.errorSeq).toBe(0)
    expect(logs.some((l) => l.startsWith('warn:') && l.includes('ERR_INTERNET'))).toBe(true)
  })

  it('manual check failure: phase error + errorSeq for one toast', async () => {
    const { u, h } = make()
    h.check.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'))
    await u.check()
    expect(u.state.phase).toBe('error')
    expect(u.state.errorSeq).toBe(1)
    expect(u.state.error).toMatch(/Не удалось проверить/)
    await u.check()
    expect(u.state.errorSeq).toBe(2)
  })

  it('background download failure falls back to «available» silently', async () => {
    const { u, h } = make()
    h.check.mockResolvedValue('0.4.5')
    h.download.mockRejectedValue(new Error('socket hang up'))
    await u.checkInBackground()
    await vi.waitFor(() => expect(u.state.phase).toBe('available'))
    expect(u.state.errorSeq).toBe(0)
  })

  it('a pressed download that fails shows the error', async () => {
    const { u, h } = make({ autoDownload: false })
    h.check.mockResolvedValue('0.4.5')
    await u.checkInBackground()
    h.download.mockRejectedValue(new Error('socket hang up'))
    await u.download()
    expect(u.state).toMatchObject({ phase: 'error', version: '0.4.5', errorSeq: 1 })
  })

  it('no background checks while an update is in hand', async () => {
    const { u, h } = make()
    h.check.mockResolvedValue('0.4.5')
    h.download.mockImplementation(async () => h.downloaded('0.4.5'))
    await u.checkInBackground()
    await vi.waitFor(() => expect(u.state.phase).toBe('downloaded'))
    h.check.mockClear()
    await u.checkInBackground()
    await u.check()
    expect(h.check).not.toHaveBeenCalled()
  })

  it('install: cores stopped first, then the installer', async () => {
    const { u, h, order } = make()
    h.check.mockResolvedValue('0.4.5')
    h.download.mockImplementation(async () => h.downloaded('0.4.5'))
    await u.checkInBackground()
    await vi.waitFor(() => expect(u.state.phase).toBe('downloaded'))
    await u.install()
    expect(order).toEqual(['cores stopped', 'installer'])
    expect(u.state.phase).toBe('installing')
  })

  it('install before the download is done does nothing', async () => {
    const { u, order } = make()
    await u.install()
    expect(order).toEqual([])
  })

  it('installer refused: back to «Перезапустить и обновить» with a toast', async () => {
    const { u, h } = make()
    h.check.mockResolvedValue('0.4.5')
    h.download.mockImplementation(async () => h.downloaded('0.4.5'))
    h.quitAndInstall.mockImplementation(() => h.error(new Error('No update filepath')))
    await u.checkInBackground()
    await vi.waitFor(() => expect(u.state.phase).toBe('downloaded'))
    await u.install()
    expect(u.state).toMatchObject({ phase: 'downloaded', errorSeq: 1 })
  })

  it('dev / unpacked: a manual check says «актуальна», no requests', async () => {
    const { u, h } = make({ enabled: false })
    u.start()
    await u.check()
    await u.checkInBackground()
    expect(u.state.phase).toBe('not-available')
    expect(h.check).not.toHaveBeenCalled()
    expect(u.schedule.armed).toBe(false)
  })

  it('start() plans the first check', async () => {
    const { u, h } = make()
    u.start()
    expect(u.schedule.armed).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.check).toHaveBeenCalledTimes(1)
    u.stop()
  })

  it('Windows shutdown turns install-on-quit off', () => {
    const { u, h } = make()
    u.setInstallOnQuit(false)
    expect(h.installOnQuit).toBe(false)
  })
})
