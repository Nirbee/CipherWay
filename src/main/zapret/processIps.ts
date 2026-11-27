import { BlockList, isIP } from 'node:net'
import type { RoutingRule } from '@shared/types'
import { zapretCidr } from '@shared/zapret'

// ---------------------------------------------------------------------------
// «Напрямую + zapret» for a program (0.7.4). winws can't see which program
// sent a packet, so the addresses that program talks to (its direct
// connections in the core's /connections, TCP 80/443 and QUIC 443 — the only
// ones zapret's profiles touch) go into the ipset of the user's IP rules
// (DpiRequest.ips → the broker's ips.txt → %USER_IPS%). A new list restarts
// winws, so new addresses are gathered and sent at most once per SEND_GAP_MS,
// only when there are new ones; ≤ LEARN_MAX, the least recently seen go first.
// Never: private / local / multicast / documentation ranges (our servers are
// left out where the request is made — ZapretService.request). Pure but for
// the clock the caller passes — unit tested in processIps.test.ts.
// ---------------------------------------------------------------------------

/** addresses kept per session (the broker takes ≤ 512 ips in all) */
export const LEARN_MAX = 512
/** a new list (= a winws restart) at most this often */
export const SEND_GAP_MS = 45_000
/** the first new addresses wait this long for the rest of a program's burst */
export const SEND_BATCH_MS = 3_000

/** what zapret acts on: TCP 80 / 443, UDP 443 (strategies.ts userIpTokens) */
export function zapretPort(network: string | undefined, port: string | number | undefined): boolean {
  const p = String(port ?? '')
  if ((network ?? 'tcp') === 'udp') return p === '443'
  return p === '443' || p === '80'
}

// two lists: Node's BlockList matches IPv4 against IPv4-mapped IPv6 rules too
const NOT_PUBLIC4 = new BlockList()
const NOT_PUBLIC6 = new BlockList()
for (const [a, b] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  NOT_PUBLIC4.addSubnet(a, b, 'ipv4')
}
for (const [a, b] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
] as const) {
  NOT_PUBLIC6.addSubnet(a, b, 'ipv6')
}

/**
 * One public address in the broker's canonical form (zapretCidr: no leading
 * zeros, IPv6 compressed lower case, an IPv4-mapped IPv6 as IPv4) — or null:
 * not an address, a range, private / local / multicast / reserved.
 */
export function publicAddress(raw: string | undefined): string | null {
  let s = (raw ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (!s || s.includes('/') || s.includes('%')) return null
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (mapped) s = mapped[1]
  const fam = isIP(s)
  if (fam === 0) return null
  const v = zapretCidr(s)
  if (!v || v.includes('/')) return null
  if (fam === 6) {
    // ::ffff:a.b.c.d in its hex spelling
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v)
    if (hex) {
      const hi = parseInt(hex[1], 16)
      const lo = parseInt(hex[2], 16)
      return publicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
  }
  const bad = fam === 6 ? NOT_PUBLIC6.check(v, 'ipv6') : NOT_PUBLIC4.check(v, 'ipv4')
  return bad ? null : v
}

/** an address against our servers' addresses (IP / CIDR as excludeIps gives them) */
export function excludeList(exclude: readonly string[]): BlockList {
  const list = new BlockList()
  for (const e of exclude) {
    const [addr, mask] = e.trim().split('/')
    const fam = isIP(addr)
    if (fam === 0) continue
    const type = fam === 6 ? 'ipv6' : 'ipv4'
    const bits = mask === undefined ? (fam === 6 ? 128 : 32) : Number(mask)
    try {
      list.addSubnet(addr, bits, type)
    } catch {
      /* not a range: nothing to leave out */
    }
  }
  return list
}

export function excluded(list: BlockList, ip: string): boolean {
  return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')
}

/** the part of a Clash API connection read here */
export interface ProcConnection {
  rule?: string
  chains?: string[]
  metadata?: {
    network?: string
    destinationIP?: string
    destinationPort?: string
    processPath?: string
  }
}

const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const normPath = (p: string): string => p.trim().split(/[\\/]+/).join('\\').toLowerCase()

/** a «Напрямую + zapret» rule for a program matches this exe path (as compile.ts does, any case) */
export function ruleMatchesProcess(rule: Pick<RoutingRule, 'conditionType' | 'value'>, path: string): boolean {
  if (!path) return false
  if (rule.conditionType === 'ProcessName') return fileName(path).toLowerCase() === rule.value.trim().toLowerCase()
  if (rule.conditionType === 'ProcessPath') return normPath(path) === normPath(rule.value)
  return false
}

/**
 * The address of a direct connection of a «Напрямую + zapret» program on a
 * port zapret acts on, and that rule's id — else null.
 */
export function processConnAddress(
  c: ProcConnection,
  rules: readonly Pick<RoutingRule, 'id' | 'conditionType' | 'value'>[]
): { ip: string; rule: string } | null {
  const md = c.metadata ?? {}
  // the rule slot of the user's direct rules (rules/compile.ts), routed direct
  if (!/cw-\d+-d\b/.test(c.rule ?? '')) return null
  if (c.chains?.length && !c.chains.includes('direct')) return null
  if (!zapretPort(md.network, md.destinationPort)) return null
  const path = md.processPath ?? ''
  const rule = rules.find((r) => ruleMatchesProcess(r, path))
  if (!rule) return null
  const ip = publicAddress(md.destinationIP)
  return ip ? { ip, rule: rule.id } : null
}

/** The addresses learned this session + when the next list may go to winws. */
export class ProcessIpLearner {
  /** address → rule id; the Map's order = last seen (oldest first) */
  private seen = new Map<string, string>()
  /** when the first not-yet-sent address came (null = nothing new) */
  private pendingSince: number | null = null
  private lastSent = -Infinity

  constructor(
    private readonly max = LEARN_MAX,
    private readonly gapMs = SEND_GAP_MS,
    private readonly batchMs = SEND_BATCH_MS
  ) {}

  /** a connection's address; true = new (a list is due) */
  note(ip: string, rule: string, now: number): boolean {
    const had = this.seen.has(ip)
    this.seen.delete(ip)
    this.seen.set(ip, rule)
    if (had) return false
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    this.pendingSince ??= now
    return true
  }

  /** newest first, ≤ max */
  addresses(): string[] {
    return [...this.seen.keys()].reverse()
  }

  get size(): number {
    return this.seen.size
  }

  /** the rules gone / changed: their addresses leave; true = some left (a list is due) */
  keepRules(ids: ReadonlySet<string>, now: number): boolean {
    let gone = false
    for (const [ip, rule] of this.seen) {
      if (!ids.has(rule)) {
        this.seen.delete(ip)
        gone = true
      }
    }
    if (gone) this.pendingSince ??= now
    return gone
  }

  /** ms until the list may go (0 = now), null = nothing new to send */
  dueIn(now: number): number | null {
    if (this.pendingSince === null) return null
    return Math.max(0, this.lastSent + this.gapMs - now, this.pendingSince + this.batchMs - now)
  }

  /** the current addresses went to winws */
  sent(now: number): void {
    this.lastSent = now
    this.pendingSince = null
  }

  clear(): void {
    this.seen.clear()
    this.pendingSince = null
    this.lastSent = -Infinity
  }
}
