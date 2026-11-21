import { execFile } from 'node:child_process'
import { redactLan } from './redact'

// ---------------------------------------------------------------------------
// cipherway-lanctl.exe (tailscale.exe, official build 1.104.7) — runs as the
// user and talks only to OUR daemon: every call starts with
// --socket=\\.\pipe\ProtectedPrefix\Administrators\CipherWay\lan-<SID>, never
// the default pipe of the user's own Tailscale. Flags checked against
// `tailscale up --help` of the pinned build (cmd/tailscale/cli/up.go):
//   --auth-key (there is no --authkey any more; "file:<path>" reads it from a
//   file — the key never shows up in a command line / process list / log),
//   --login-server, --hostname, --accept-dns, --accept-routes (default TRUE on
//   Windows — routes pushed by the server would change ours), --unattended
//   (Windows: keep running with no GUI connected — we have none), --reset,
//   --timeout. Builders / parsers are pure — unit tested in lanCtl.test.ts.
// ---------------------------------------------------------------------------

export interface UpParams {
  loginServer: string
  /** a file holding the single-use pre-auth key (deleted right after `up`) */
  authKeyFile?: string
  hostname: string
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export function upArgs(p: UpParams): string[] {
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(p.loginServer)) {
    throw new Error('bad login server')
  }
  if (!HOSTNAME_RE.test(p.hostname)) throw new Error('bad hostname')
  return [
    'up',
    `--login-server=${p.loginServer}`,
    ...(p.authKeyFile ? [`--auth-key=file:${p.authKeyFile}`] : []),
    `--hostname=${p.hostname}`,
    // nothing the coordination server says may change DNS or routes of this PC,
    // and this PC never routes for others (security review): set explicitly,
    // not left to defaults (--accept-routes is TRUE by default on Windows)
    '--accept-dns=false',
    '--accept-routes=false',
    '--exit-node=',
    '--advertise-exit-node=false',
    '--advertise-routes=',
    '--unattended',
    '--reset',
    '--timeout=60s'
  ]
}

export const STATUS_ARGS = ['status', '--json'] as const
export const NO_AUTO_UPDATE_ARGS = ['set', '--auto-update=false'] as const

/** Addresses outside 100.64.0.0/10 and fd7a:115c:a1e0::/48 (a server gone wrong). */
export function foreignIps(s: Pick<DaemonStatus, 'allIps'>): string[] {
  return [...new Set(s.allIps.filter((ip) => !isLanIp(ip)))]
}

/** The daemon refuses this Windows user (another one owns it) / the action. */
export function isAccessError(msg: string): boolean {
  return /in use by|not allowed|access denied|permission denied|forbidden/i.test(msg)
}

/** a LAN address of a peer: 100.64.0.0/10 or fd7a:115c:a1e0::/48 */
export function isLanIp(ip: string): boolean {
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (m) {
    const b = Number(m[1])
    return b >= 64 && b <= 127 && Number(m[2]) <= 255 && Number(m[3]) <= 255
  }
  return /^fd7a:115c:a1e0:[0-9a-f:]*$/i.test(ip)
}

export function pingArgs(ip: string): string[] {
  if (!isLanIp(ip)) throw new Error('not a LAN address')
  return ['ping', '--c=1', '--timeout=3s', '--until-direct=false', ip]
}

export interface DaemonPeer {
  ip: string
  name: string
  online: boolean
  /** a direct UDP path is in use (CurAddr set) */
  direct: boolean
  /** DERP region of the relay, if any */
  relay: string | null
}

export interface DaemonStatus {
  /** NoState | NeedsLogin | NeedsMachineAuth | Stopped | Starting | Running */
  backendState: string
  selfIp: string | null
  selfName: string | null
  peers: DaemonPeer[]
  health: string[]
  /** every address of this node and its peers (checked against the LAN ranges) */
  allIps: string[]
}

const firstV4 = (ips: unknown): string | null => {
  if (!Array.isArray(ips)) return null
  const v4 = ips.find((x) => typeof x === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(x))
  return typeof v4 === 'string' ? v4 : null
}

/** `status --json` (ipnstate.Status) → what the LAN tab needs. */
export function parseStatus(text: string): DaemonStatus {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('непонятный ответ LAN')
  }
  const self = (o.Self ?? {}) as Record<string, unknown>
  const peerMap = (o.Peer && typeof o.Peer === 'object' ? o.Peer : {}) as Record<string, unknown>
  const peers: DaemonPeer[] = []
  for (const raw of Object.values(peerMap)) {
    if (!raw || typeof raw !== 'object') continue
    const p = raw as Record<string, unknown>
    const ip = firstV4(p.TailscaleIPs)
    if (!ip) continue
    const curAddr = typeof p.CurAddr === 'string' ? p.CurAddr : ''
    const relay = typeof p.Relay === 'string' && p.Relay ? p.Relay : null
    peers.push({
      ip,
      name: typeof p.HostName === 'string' ? p.HostName : '',
      online: p.Online === true,
      direct: curAddr !== '',
      relay
    })
  }
  return {
    backendState: typeof o.BackendState === 'string' ? o.BackendState : 'NoState',
    selfIp: firstV4(o.TailscaleIPs) ?? firstV4(self.TailscaleIPs),
    selfName: typeof self.HostName === 'string' ? self.HostName : null,
    peers,
    allIps: [
      o.TailscaleIPs,
      self.TailscaleIPs,
      ...Object.values(peerMap).map((p) =>
        p && typeof p === 'object' ? (p as Record<string, unknown>).TailscaleIPs : null
      )
    ].flatMap((l) => (Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string') : [])),
    health: Array.isArray(o.Health)
      ? o.Health.filter((h): h is string => typeof h === 'string')
      : []
  }
}

export interface PingResult {
  latencyMs: number
  path: 'direct' | 'relay'
}

/**
 * `ping --c=1` prints «pong from <name> (<ip>) via <how> in <duration>»;
 * <how> = <ip:port> (direct), DERP(<region>) or peer-relay(<…>).
 */
export function parsePing(out: string): PingResult | null {
  const m = /pong from .* via (\S+) in (\d+(?:\.\d+)?)(µs|us|ms|s)\b/.exec(out)
  if (!m) return null
  const n = Number(m[2])
  const ms = m[3] === 's' ? n * 1000 : m[3] === 'ms' ? n : n / 1000
  const via = m[1]
  return {
    latencyMs: Math.max(1, Math.round(ms)),
    path: /^DERP\(|^peer-relay\(/.test(via) ? 'relay' : 'direct'
  }
}

export interface LanCtlOpts {
  exe: string
  pipe: string
  /** tests */
  execFn?: (
    exe: string,
    args: string[],
    timeoutMs: number
  ) => Promise<{ code: number; stdout: string; stderr: string }>
}

function execCtl(
  exe: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? -1
              : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

/** The CLI, bound to our daemon's pipe. Its error text is redacted. */
export class LanCtl {
  constructor(private o: LanCtlOpts) {}

  private async run(args: string[], timeoutMs: number): Promise<string> {
    const exec = this.o.execFn ?? execCtl
    const r = await exec(this.o.exe, [`--socket=${this.o.pipe}`, ...args], timeoutMs)
    if (r.code !== 0) {
      const why = redactLan(`${r.stderr}\n${r.stdout}`.trim()).split(/\r?\n/).slice(-3).join(' ')
      throw new Error(why || `код ${r.code}`)
    }
    return r.stdout
  }

  async status(): Promise<DaemonStatus> {
    return parseStatus(await this.run([...STATUS_ARGS], 10_000))
  }

  async up(p: UpParams): Promise<void> {
    await this.run(upArgs(p), 75_000)
  }

  /**
   * Never update itself: on Windows that installs the official Tailscale MSI.
   * (`up` has no --auto-update in 1.104.7, `set` has; the policy file of the
   * broker says «never» too.)
   */
  async noAutoUpdate(): Promise<void> {
    await this.run([...NO_AUTO_UPDATE_ARGS], 15_000)
  }

  async ping(ip: string): Promise<PingResult | null> {
    try {
      return parsePing(await this.run(pingArgs(ip), 8_000))
    } catch {
      return null
    }
  }
}
