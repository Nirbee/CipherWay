import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { OutboundConfig, RoutingRule, TunServiceInfo } from '@shared/types'
import type { ZapretSettings, ZapretView } from '@shared/zapret'
import { DPI_ALL, DPI_EXE } from '../core/coreNames'
import type { TunService } from '../core/tunService'
import { dpiTaskName } from '../core/serviceScripts'
import { TUN_ADDRESS4 } from '../core/configGen'
import type { ZapretRouting } from '../rules/compile'
import { runningProcessNames } from '../system/processes'
import { normalizeHost, resolveServers, toExcludeCidrs } from '../system/resolve'
import { checkTarget, currentNetwork, dohResolve, pickDoh } from './checks'
import { findVideoNodes, getDirect } from './videoNodes'
import { DpiDaemon } from './DpiDaemon'
import { ZapretService, type StrategyMemo } from './ZapretService'

// Builds the ZapretService with the real pieces (see ZapretService.ts for the flow).

export interface CreateZapretOpts {
  binDir: string
  runDir: string
  service: TunService
  /** queued with the VPN operations (SidecarManager.installTunService) */
  install: () => Promise<'ok' | 'cancelled' | 'failed'>
  getSettings: () => ZapretSettings
  setSettings: (s: ZapretSettings) => void
  getMemory: () => Record<string, StrategyMemo>
  setMemory: (m: Record<string, StrategyMemo>) => void
  vpn: () => { running: boolean; tun: boolean }
  /** the current subscription's servers (their addresses are never touched by zapret) */
  outbounds: () => OutboundConfig[]
  /** extra names an own domain may not be (the subscription host…) */
  reservedHosts: () => string[]
  applyRouting: (r: ZapretRouting) => Promise<void>
  /** the user's rules (their «Напрямую + zapret» ones) */
  rules?: () => readonly RoutingRule[]
  /** a «Напрямую + zapret» rule changed its way: apply the rules again */
  rulesChanged?: () => void
  publish: (v: ZapretView) => void
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/** «winws.exe», «goodbyedpi.exe»… in the process list (ours is cipherway-dpi.exe) */
const FOREIGN = ['winws.exe', 'goodbyedpi.exe', 'zapret.exe']

export function createZapretService(o: CreateZapretOpts): ZapretService {
  let daemon: DpiDaemon | null = null
  return new ZapretService({
    available: DPI_ALL.every((f) => existsSync(join(o.binDir, f))),
    getSettings: o.getSettings,
    setSettings: o.setSettings,
    getMemory: o.getMemory,
    setMemory: o.setMemory,
    vpn: o.vpn,
    service: {
      status: (): Promise<TunServiceInfo> => o.service.status(),
      install: o.install
    },
    daemon: async () => {
      if (daemon) return daemon
      const sid = await o.service.sid()
      daemon = new DpiDaemon({
        runDir: o.runDir,
        home: o.service.homeDir(sid),
        task: dpiTaskName(sid),
        log: o.log
      })
      return daemon
    },
    // our TUN's own address is never «the physical adapter»
    network: () => currentNetwork([TUN_ADDRESS4]),
    pickDoh: (path) => pickDoh(path),
    checkTarget: (t, doh, path, timeoutMs) => checkTarget(t, doh, path, timeoutMs),
    // a real video node of this client (the watch page, else report_mapping)
    videoNodes: async (doh, path) =>
      (
        await findVideoNodes({
          get: (host, urlPath, maxBytes, timeoutMs) =>
            getDirect(host, urlPath, doh, path, maxBytes, timeoutMs),
          resolves: async (host) => (await dohResolve(host, doh, path)).length > 0
        })
      ).nodes,
    excludeIps: async () => toExcludeCidrs(await resolveServers(o.outbounds())),
    hasServers: () => o.outbounds().length > 0,
    reserved: () => [...o.outbounds().map((x) => normalizeHost(x.server)), ...o.reservedHosts()],
    applyRouting: o.applyRouting,
    ...(o.rules ? { rules: o.rules } : {}),
    ...(o.rulesChanged ? { rulesChanged: o.rulesChanged } : {}),
    foreignDpi: async () => {
      const names = (await runningProcessNames()).map((n) => n.toLowerCase())
      return FOREIGN.find((f) => names.includes(f)) ?? null
    },
    orphanRunning: async () =>
      (await runningProcessNames()).some((n) => n.toLowerCase() === DPI_EXE),
    publish: o.publish,
    log: o.log
  })
}
