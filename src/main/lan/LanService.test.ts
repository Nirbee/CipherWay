import { describe, expect, it, vi } from 'vitest'
import type { LanView, TunServiceInfo } from '@shared/types'
import { LanApiError } from './api'
import type { DaemonStatus, UpParams } from './lanCtl'
import type { LanBrokerState } from './lanBroker'
import { LanStartError } from './LanDaemon'
import { LanService, type LanServiceDeps } from './LanService'

const KEY = 'hskey-auth-SECRET_never_logged_123'

function setup(over: Partial<LanServiceDeps> = {}, opts: { backend?: string[] } = {}) {
  const logs: string[] = []
  const views: LanView[] = []
  const ups: UpParams[] = []
  const keyFiles: Record<string, string> = {}
  let enabled = false
  let hostname: string | null = null
  // the daemon's BackendState over time (first answers), then Running
  const backend = [...(opts.backend ?? ['NeedsLogin'])]
  let running = false
  const state: LanBrokerState = { session: 's', status: 'running' }
  const daemon = {
    start: vi.fn(async () => {
      running = true
    }),
    stop: vi.fn(async () => {
      running = false
    }),
    running: vi.fn(async () => (running ? state : { ...state, status: 'stopped' as const })),
    isMine: () => true,
    readLog: vi.fn(async () => [])
  }
  const ctl = {
    status: vi.fn(async (): Promise<DaemonStatus> => {
      const b = backend.length ? backend.shift()! : 'Running'
      return {
        backendState: b,
        selfIp: b === 'Running' || b === 'Stopped' ? '100.64.0.2' : null,
        selfName: 'cw-1a2b3c',
        peers: [],
        health: [],
        allIps: b === 'Running' || b === 'Stopped' ? ['100.64.0.2', 'fd7a:115c:a1e0::2'] : []
      }
    }),
    up: vi.fn(async (p: UpParams) => {
      ups.push(p)
      if (p.authKeyFile) expect(keyFiles[p.authKeyFile]).toBe(KEY)
      backend.length = 0
    }),
    ping: vi.fn(async () => null),
    noAutoUpdate: vi.fn(async () => undefined)
  }
  const api = {
    status: vi.fn(async () => ({
      enabled: true,
      loginServer: 'https://lan.cipherway.ru',
      maxRoomMembers: 8,
      maxRoomsOwned: 3,
      maxRoomsJoined: 10,
      maxDevices: 5
    })),
    registerDevice: vi.fn(async () => ({
      loginServer: 'https://lan.cipherway.ru',
      authKey: KEY,
      expiresAt: null,
      hostname: 'cw-1a2b3c'
    })),
    devices: vi.fn(async () => [
      { nodeId: '1', name: 'cw-old', ip: '100.64.0.9', online: false, lastSeen: null }
    ]),
    deleteDevice: vi.fn(async () => undefined),
    rooms: vi.fn(async () => []),
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    kick: vi.fn(),
    regenerateCode: vi.fn()
  }
  const service = {
    status: vi.fn(async (): Promise<TunServiceInfo> => ({ state: 'ok', lan: true })),
    install: vi.fn(async () => 'ok' as const)
  }
  const deps: LanServiceDeps = {
    api: api as never,
    available: true,
    daemon: async () => daemon,
    ctl: async () => ctl,
    service,
    getHostname: () => hostname,
    setHostname: (h) => {
      hostname = h
    },
    keyFile: 'C:\\run\\lan-key.txt',
    writeKey: async (p, k) => {
      keyFiles[p] = k
    },
    removeKey: async (p) => {
      delete keyFiles[p]
    },
    getEnabled: () => enabled,
    setEnabled: (on) => {
      enabled = on
    },
    setLoginServer: () => undefined,
    getLoginServer: () => 'https://lan.cipherway.ru',
    hasSubscription: () => true,
    publish: (v) => views.push(v),
    log: (_l, m) => logs.push(m),
    daemonLog: () => undefined,
    waitMs: 500,
    pollActiveMs: 20,
    pollIdleMs: 20,
    ...over
  }
  const svc = new LanService(deps)
  return {
    svc,
    api,
    ctl,
    daemon,
    service,
    logs,
    views,
    ups,
    keyFiles,
    get enabled() {
      return enabled
    },
    get hostname() {
      return hostname
    }
  }
}

describe('LanService: switching LAN on', () => {
  it('first time: key from the bot → `up` with the key file and the bot’s host name → on', async () => {
    const t = setup()
    const v = await t.svc.setEnabled(true)
    expect(v.phase).toBe('on')
    expect(v.selfIp).toBe('100.64.0.2')
    expect(t.enabled).toBe(true)
    expect(t.api.registerDevice).toHaveBeenCalledWith(null)
    expect(t.ups).toEqual([
      {
        loginServer: 'https://lan.cipherway.ru',
        authKeyFile: 'C:\\run\\lan-key.txt',
        hostname: 'cw-1a2b3c'
      }
    ])
    expect(t.hostname).toBe('cw-1a2b3c')
    // the key file is gone, the key is nowhere in the log / the views
    expect(t.keyFiles).toEqual({})
    expect(t.logs.join('\n')).not.toContain('SECRET')
    expect(JSON.stringify(t.views)).not.toContain('SECRET')
    await t.svc.shutdown()
  })

  it('already logged in (the daemon kept its state): no new key', async () => {
    const t = setup({}, { backend: ['Running'] })
    expect((await t.svc.setEnabled(true)).phase).toBe('on')
    expect(t.api.registerDevice).not.toHaveBeenCalled()
    expect(t.ups).toEqual([])
    await t.svc.shutdown()
  })

  it('switched off before (Stopped): `up` without a key, with the stored host name', async () => {
    const t = setup({}, { backend: ['Stopped'] })
    t.svc['d'].setHostname('cw-1a2b3c')
    expect((await t.svc.setEnabled(true)).phase).toBe('on')
    expect(t.api.registerDevice).not.toHaveBeenCalled()
    expect(t.ups).toEqual([{ loginServer: 'https://lan.cipherway.ru', hostname: 'cw-1a2b3c' }])
    await t.svc.shutdown()
  })

  it('inactive subscription → plain Russian error, the daemon is not even started', async () => {
    const t = setup()
    t.api.status.mockRejectedValueOnce(new LanApiError('inactive'))
    const v = await t.svc.setEnabled(true)
    expect(v.phase).toBe('error')
    expect(v.error?.kind).toBe('inactive')
    expect(v.error?.text).toMatch(/Подписка не активна/)
    expect(t.daemon.start).not.toHaveBeenCalled()
  })

  it('LAN off on the server', async () => {
    const t = setup()
    t.api.status.mockResolvedValueOnce({
      enabled: false,
      loginServer: null,
      maxRoomMembers: 8,
      maxRoomsOwned: 3,
      maxRoomsJoined: 10,
      maxDevices: 5
    } as never)
    expect((await t.svc.setEnabled(true)).error?.kind).toBe('disabled')
  })

  it('device limit → the device list is loaded; deleting one retries', async () => {
    const t = setup()
    t.api.registerDevice.mockRejectedValueOnce(new LanApiError('device_limit'))
    const v = await t.svc.setEnabled(true)
    expect(v.error?.kind).toBe('device_limit')
    expect(v.devices).toHaveLength(1)
    expect(t.daemon.stop).toHaveBeenCalled()
    const after = await t.svc.deleteDevice('1')
    expect(t.api.deleteDevice).toHaveBeenCalledWith('1')
    expect(after.phase).toBe('on')
    await t.svc.shutdown()
  })

  it('the user’s Tailscale is running → says how to stop it', async () => {
    const t = setup()
    t.daemon.start.mockRejectedValueOnce(
      new LanStartError('tailscale_running', 'x', 'служба Tailscale')
    )
    const v = await t.svc.setEnabled(true)
    expect(v.error?.kind).toBe('tailscale_running')
    expect(v.error?.text).toMatch(/остановите службу Tailscale/)
  })

  it('no LAN task yet: the user’s switch installs the service (one prompt); a refusal is explained', async () => {
    const t = setup()
    t.service.status.mockResolvedValueOnce({ state: 'missing', lan: false })
    t.service.install.mockResolvedValueOnce('cancelled' as never)
    const v = await t.svc.setEnabled(true)
    expect(t.service.install).toHaveBeenCalledTimes(1)
    expect(v.error?.kind).toBe('uac')
  })

  it('after an app update the installed LAN task is used as it is — no prompt', async () => {
    const t = setup({}, { backend: ['Running'] })
    t.service.status.mockResolvedValue({ state: 'outdated', lan: true })
    expect((await t.svc.setEnabled(true)).phase).toBe('on')
    expect(t.service.install).not.toHaveBeenCalled()
    await t.svc.shutdown()
  })

  it('at app start: never a UAC prompt — no LAN task = an error to click', async () => {
    const t = setup()
    t.svc['d'].setEnabled(true)
    t.service.status.mockResolvedValue({ state: 'missing', lan: false })
    t.svc.init(0)
    await vi.waitFor(() => expect(t.views.at(-1)?.phase).toBe('error'))
    expect(t.views.at(-1)?.error?.kind).toBe('service')
    expect(t.service.install).not.toHaveBeenCalled()
  })

  it('switch off stops the daemon and remembers it; app quit stops it but keeps the switch', async () => {
    const t = setup({}, { backend: ['Running'] })
    await t.svc.setEnabled(true)
    await t.svc.shutdown()
    expect(t.daemon.stop).toHaveBeenCalledTimes(1)
    expect(t.enabled).toBe(true)
    await t.svc.setEnabled(true)
    const v = await t.svc.setEnabled(false)
    expect(v.phase).toBe('off')
    expect(t.enabled).toBe(false)
  })

  it('the VPN gets the LAN bypass before the daemon dials, and loses it after the stop', async () => {
    const order: string[] = []
    const t = setup(
      {
        onBypassChange: async () => {
          order.push('bypass')
        }
      },
      { backend: ['Running'] }
    )
    t.daemon.start.mockImplementationOnce(async () => {
      order.push('start')
    })
    t.daemon.stop.mockImplementation(async () => {
      order.push('stop')
    })
    await t.svc.setEnabled(true)
    await t.svc.setEnabled(false)
    expect(order).toEqual(['bypass', 'start', 'stop', 'bypass'])
  })

  it('self-update of the daemon is switched off on every start', async () => {
    const t = setup({}, { backend: ['Running'] })
    await t.svc.setEnabled(true)
    expect(t.ctl.noAutoUpdate).toHaveBeenCalledTimes(1)
    await t.svc.shutdown()
  })

  it('«in use by» / «not allowed» from the daemon → a clear Russian error', async () => {
    const t = setup()
    t.ctl.up.mockRejectedValueOnce(new Error('Tailscale is in use by another user: DESKTOP\\Anna'))
    const v = await t.svc.setEnabled(true)
    expect(v.error?.kind).toBe('in_use')
    expect(v.error?.text).toMatch(/другим пользователем Windows/)
    const t2 = setup()
    t2.ctl.status.mockRejectedValue(new Error('Access denied: not allowed'))
    expect((await t2.svc.setEnabled(true)).error?.kind).toBe('in_use')
  })

  it('no subscription → nosub, nothing else happens', async () => {
    const t = setup({ hasSubscription: () => false })
    expect((await t.svc.setEnabled(true)).error?.kind).toBe('nosub')
    expect(t.api.status).not.toHaveBeenCalled()
  })
})

describe('LanService: polling', () => {
  it('peers: direct / relay from the daemon, ping only room peers that are online', async () => {
    const t = setup({}, { backend: ['Running'] })
    t.api.rooms.mockResolvedValue([
      {
        id: '5',
        code: null,
        name: 'r',
        isOwner: false,
        members: [
          { memberId: '1', label: 'Игрок 1', isSelf: true, devices: [] },
          {
            memberId: '2',
            label: 'Игрок 2',
            isSelf: false,
            devices: [{ name: 'cw-ffffff', ip: '100.64.0.3', online: true }]
          }
        ]
      }
    ] as never)
    t.ctl.status.mockImplementation(async () => ({
      backendState: 'Running',
      selfIp: '100.64.0.2',
      selfName: 'cw-1a2b3c',
      peers: [
        { ip: '100.64.0.3', name: 'cw-ffffff', online: true, direct: false, relay: 'cw' },
        { ip: '100.64.0.4', name: 'cw-eeeeee', online: false, direct: false, relay: null }
      ],
      health: [],
      allIps: ['100.64.0.2', '100.64.0.3', '100.64.0.4']
    }))
    // the peer is behind a strict NAT: via the relay (CurAddr empty, DERP ping)
    t.ctl.ping.mockResolvedValue({ latencyMs: 25, path: 'relay' } as never)
    t.svc.setActive(true)
    await t.svc.setEnabled(true)
    await vi.waitFor(() => expect(t.views.at(-1)?.links['100.64.0.3']?.latencyMs).toBe(25))
    const links = t.views.at(-1)!.links
    expect(links['100.64.0.3']).toEqual({
      ip: '100.64.0.3',
      online: true,
      path: 'relay',
      latencyMs: 25
    })
    expect(links['100.64.0.4']).toMatchObject({ online: false, path: 'unknown', latencyMs: null })
    expect(t.ctl.ping).toHaveBeenCalledWith('100.64.0.3')
    expect(t.ctl.ping).not.toHaveBeenCalledWith('100.64.0.4')
    await t.svc.shutdown()
  })

  it('the link was reset (node expired → NeedsLogin): a new key and `up`, silently', async () => {
    const t = setup({}, { backend: ['Running'] })
    await t.svc.setEnabled(true)
    expect(t.api.registerDevice).not.toHaveBeenCalled()
    // pretend the start was long ago, then the server expires the node
    t.svc['lastLogin'] = 0
    t.ctl.status.mockResolvedValueOnce({
      backendState: 'NeedsLogin',
      selfIp: null,
      selfName: null,
      peers: [],
      health: [],
      allIps: []
    })
    await vi.waitFor(() => expect(t.api.registerDevice).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(t.ups).toHaveLength(1))
    expect(t.ups[0].authKeyFile).toBe('C:\\run\\lan-key.txt')
    expect(t.views.at(-1)?.phase).toBe('on')
    expect(t.keyFiles).toEqual({})
    await t.svc.shutdown()
  })

  it('the server hands out an address outside the LAN → LAN stopped, plain error', async () => {
    const t = setup({}, { backend: ['Running'] })
    await t.svc.setEnabled(true)
    expect(t.views.at(-1)?.phase).toBe('on')
    t.ctl.status.mockResolvedValue({
      backendState: 'Running',
      selfIp: '100.64.0.2',
      selfName: 'cw-1a2b3c',
      peers: [{ ip: '100.64.0.3', name: 'x', online: true, direct: true, relay: null }],
      health: [],
      // a peer «in» 8.8.8.0/24 — a real internet range on the LAN adapter
      allIps: ['100.64.0.2', '100.64.0.3', '8.8.8.8']
    })
    await vi.waitFor(() => expect(t.views.at(-1)?.error?.kind).toBe('unsafe_address'))
    expect(t.views.at(-1)?.error?.text).toMatch(/вне сети LAN/)
    expect(t.daemon.stop).toHaveBeenCalled()
  })

  it('an address outside the LAN right at the start: never «on»', async () => {
    const t = setup({}, { backend: ['Running'] })
    t.ctl.status.mockResolvedValue({
      backendState: 'Running',
      selfIp: '10.1.2.3',
      selfName: 'cw-1a2b3c',
      peers: [],
      health: [],
      allIps: ['10.1.2.3']
    })
    const v = await t.svc.setEnabled(true)
    expect(v.error?.kind).toBe('unsafe_address')
    expect(t.views.some((x) => x.phase === 'on')).toBe(false)
  })

  it('the daemon yields to a starting Tailscale → error, no restart loop', async () => {
    const t = setup({}, { backend: ['Running'] })
    await t.svc.setEnabled(true)
    t.daemon.running.mockResolvedValue({
      session: 's',
      status: 'stopped',
      error: 'tailscale_running',
      detail: 'служба Tailscale'
    })
    await vi.waitFor(() => expect(t.views.at(-1)?.error?.kind).toBe('tailscale_running'))
    expect(t.daemon.start).toHaveBeenCalledTimes(1)
  })
})
