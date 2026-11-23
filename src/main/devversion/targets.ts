import type { ProcStats } from './aggregate'
import { isKnownGame } from './aggregate'

// What DevVersion checks directly and through the VPN every heavy run.

export interface Target {
  /** group name in the report */
  target: string
  host: string
  port: number
  /** TLS + HTTP after TCP (false: TCP only) */
  tls: boolean
  /** compare the system resolver with DoH */
  dns: boolean
  /** the program that used this address (game domains) */
  app?: string
}

const T = (target: string, host: string, port = 443, tls = true): Target => ({
  target,
  host,
  port,
  tls,
  dns: !/^\d/.test(host)
})

export const BASE_TARGETS: Target[] = [
  T('youtube', 'www.youtube.com'),
  T('googlevideo', 'redirector.googlevideo.com'),
  T('discord', 'discord.com'),
  T('discord', 'gateway.discord.gg'),
  T('discord', 'media.discordapp.net'),
  T('telegram', 'web.telegram.org'),
  T('telegram', 'api.telegram.org'),
  T('instagram', 'www.instagram.com'),
  T('x', 'x.com'),
  T('ubisoft', 'ubi.com'),
  T('ubisoft', 'ubisoft.com'),
  T('ubisoft', 'ubisoftconnect.com'),
  T('ubisoft', 'vivox.com'),
  T('steam', 'store.steampowered.com'),
  T('steam', 'steamcommunity.com'),
  T('riot', 'auth.riotgames.com'),
  T('epic', 'www.epicgames.com'),
  T('battlenet', 'battle.net'),
  T('cloudflare', '1.1.1.1'),
  T('google', '8.8.8.8')
]

const BROWSERS =
  /^(chrome|msedge|msedgewebview2|firefox|opera|opera_gx|brave|browser|vivaldi|arc)\.exe$/

/** Programs that look like games: known exes, or not a browser with UDP traffic. */
export function gameLike(p: ProcStats): boolean {
  if (isKnownGame(p.name)) return true
  if (BROWSERS.test(p.name)) return false
  for (const d of p.ips.values()) if (d.net === 'udp' && d.up + d.down > 64 * 1024) return true
  return false
}

/**
 * The domains games used most in this period (TCP ones — that's what can be
 * checked honestly), not already in the list. Port = the one they used most.
 */
export function gameTargets(procs: Iterable<ProcStats>, have: Set<string>, max = 8): Target[] {
  const hits = new Map<string, { bytes: number; port: number; app: string }>()
  for (const p of procs) {
    if (!gameLike(p)) continue
    for (const [domain, d] of p.domains) {
      if (d.net !== 'tcp' || have.has(domain)) continue
      const prev = hits.get(domain)
      const bytes = (prev?.bytes ?? 0) + d.up + d.down + d.conns * 4096
      hits.set(domain, { bytes, port: prev?.port ?? d.ports[0] ?? 443, app: prev?.app ?? p.name })
    }
  }
  return [...hits.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, max)
    .map(([host, h]) => ({
      target: 'game',
      host,
      port: h.port,
      tls: h.port === 443,
      dns: true,
      app: h.app
    }))
}
