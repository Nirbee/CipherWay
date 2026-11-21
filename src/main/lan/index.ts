import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LanView, TunServiceInfo } from '@shared/types'
import { LAN_EXE, LAN_LOGIN_HOST, LANCTL_EXE } from '../core/coreNames'
import type { TunService } from '../core/tunService'
import { LanApi } from './api'
import { LanCtl } from './lanCtl'
import { lanPipeName, lanTaskName } from './lanBroker'
import { LanDaemon } from './LanDaemon'
import { LanService } from './LanService'
import type { SupportContext } from '../support/client'

// Builds the LanService with the real pieces (see LanService.ts for the flow).

export interface CreateLanOpts {
  binDir: string
  runDir: string
  service: TunService
  /** queued with the VPN operations (SidecarManager.installTunService) */
  install: () => Promise<'ok' | 'cancelled' | 'failed'>
  apiContext: () => Promise<SupportContext>
  hasSubscription: () => boolean
  getEnabled: () => boolean
  setEnabled: (on: boolean) => void
  getLoginServer: () => string | null
  /** the host name the bot gave (cw-xxxxxx), null before the first login */
  getHostname: () => string | null
  setHostname: (name: string) => void
  setLoginServer: (url: string) => void
  publish: (v: LanView) => void
  /** LAN goes on / off: the VPN config must (not) let its daemon bypass */
  onBypassChange: () => Promise<void>
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  daemonLog: (lines: string[]) => void
}

export function createLanService(o: CreateLanOpts): LanService {
  let daemon: LanDaemon | null = null
  let ctl: LanCtl | null = null
  const keyFile = join(o.runDir, 'lan-key.txt')
  // a key left by a crash right between `write` and `up` (single-use, 10 min anyway)
  void rm(keyFile, { force: true }).catch(() => undefined)
  const sidInfo = async (): Promise<{ sid: string; home: string }> => {
    const sid = await o.service.sid()
    return { sid, home: o.service.homeDir(sid) }
  }
  return new LanService({
    api: new LanApi(o.apiContext),
    available: existsSync(join(o.binDir, LAN_EXE)) && existsSync(join(o.binDir, LANCTL_EXE)),
    daemon: async () => {
      if (daemon) return daemon
      const { sid, home } = await sidInfo()
      daemon = new LanDaemon({ runDir: o.runDir, home, task: lanTaskName(sid), log: o.log })
      return daemon
    },
    ctl: async () => {
      if (ctl) return ctl
      const { sid } = await sidInfo()
      ctl = new LanCtl({ exe: join(o.binDir, LANCTL_EXE), pipe: lanPipeName(sid) })
      return ctl
    },
    service: {
      status: (): Promise<TunServiceInfo> => o.service.status(),
      install: o.install
    },
    getHostname: o.getHostname,
    setHostname: o.setHostname,
    keyFile,
    // the user's own run folder (only this user and admins can read it)
    writeKey: (path, key) => writeFile(path, key, { encoding: 'utf8', mode: 0o600 }),
    removeKey: (path) => rm(path, { force: true }),
    getEnabled: o.getEnabled,
    setEnabled: o.setEnabled,
    getLoginServer: () => o.getLoginServer() ?? `https://${LAN_LOGIN_HOST}`,
    setLoginServer: o.setLoginServer,
    hasSubscription: o.hasSubscription,
    publish: o.publish,
    log: o.log,
    daemonLog: o.daemonLog,
    onBypassChange: o.onBypassChange
  })
}
