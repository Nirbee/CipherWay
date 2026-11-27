// ---------------------------------------------------------------------------
// zapret strategies of «Ускорение без VPN»: how winws (cipherway-dpi.exe,
// zapret v72.13) bends the provider's DPI. A digest of the ~100 presets of
// zapret-discord-youtube (pre-configs\*.bat, Nov 2026): most of them repeat a
// handful of desync recipes for TLS (TCP 443) with different list files —
// these are the different ones, most widely used first. Only the parameters
// are taken (no paths, no files of that build).
//
// Tokens hold placeholders the SYSTEM broker fills in with ITS OWN paths
// (dpiBroker.ts) — nothing of the command line comes from the user:
//   %TLS%   the fake ClientHello (tls_clienthello_www_google_com.bin, from the zapret release)
//   %QUIC%  the fake QUIC Initial (quic_initial_www_google_com.bin)
//   %HOSTS% the hostlist the broker wrote (built-in services + validated own domains)
//   %EXCL%  the ipset of addresses zapret must never touch (our VPN servers + LAN ranges)
//   %DISCORD_IPS%  the ipset of Discord's voice servers (lists.ts, baked into the broker)
//   %USER_IPS%  the ipset of the user's «Напрямую + zapret» IP rules (0.7.2; parsed
//               by the broker like the exclusions, only lines of a file)
// Every combination is checked with `cipherway-dpi.exe --dry-run` in
// strategies.test.ts (the official build accepts all of them).
// Stage 2 (presets from the server, a strategy per domain) adds entries here /
// per-list profiles in winwsTokens — the broker takes any strategy of the table
// it was installed with.
// ---------------------------------------------------------------------------

export interface DpiStrategy {
  /** stable id: remembered per network, sent to the broker */
  id: string
  /** shown in «Настройки» */
  name: string
  /** the presets it comes from (for us) */
  from: string
  /** desync of TLS (TCP 443, Discord's extra TLS ports) */
  tls: readonly string[]
  /** desync of QUIC (UDP 443) */
  quic: readonly string[]
}

const QUIC6 = ['--dpi-desync=fake', '--dpi-desync-repeats=6', '--dpi-desync-fake-quic=@%QUIC%']
const QUIC11 = ['--dpi-desync=fake', '--dpi-desync-repeats=11', '--dpi-desync-fake-quic=@%QUIC%']

export const STRATEGIES: readonly DpiStrategy[] = [
  // 0.7.1 — first: a FAKE ClientHello / fake SNI (www.google.com) in front of the
  // real one. On Beeline the video nodes answer a ClientHello with SNI
  // www.google.com and drop one with *.googlevideo.com: the DPI must see the
  // fake first. From the YoutubeFix presets of zapret-discord-youtube.
  {
    id: 'yt-fake-autottl-md5sig',
    name: 'YouTube: fake ClientHello (autottl, md5sig)',
    from: 'YoutubeFix (для МГТС)',
    tls: [
      '--dpi-desync=fake',
      '--dpi-desync-autottl=2',
      '--dpi-desync-repeats=6',
      '--dpi-desync-fooling=md5sig',
      '--dpi-desync-fake-tls=@%TLS%'
    ],
    quic: QUIC6
  },
  {
    id: 'yt-fake-split-badseq',
    name: 'YouTube: fake + split (autottl, badseq)',
    from: 'YoutubeFix, YoutubeFix_ALT',
    tls: [
      '--dpi-desync=fake,split',
      '--dpi-desync-autottl=2',
      '--dpi-desync-repeats=6',
      '--dpi-desync-fooling=badseq',
      '--dpi-desync-fake-tls=@%TLS%'
    ],
    quic: QUIC6
  },
  {
    id: 'yt-fake-multisplit-sni',
    name: 'YouTube: fake SNI www.google.com + multisplit',
    from: 'general (FAKE TLS AUTO ALT3)',
    tls: [
      '--dpi-desync=fake,multisplit',
      '--dpi-desync-split-seqovl=681',
      '--dpi-desync-split-pos=1',
      '--dpi-desync-fooling=ts',
      '--dpi-desync-repeats=8',
      '--dpi-desync-split-seqovl-pattern=@%TLS%',
      '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com'
    ],
    quic: QUIC11
  },
  {
    id: 'yt-fake-split2-ttl',
    name: 'YouTube: fake + split2 (ttl 1)',
    from: 'YoutubeFix (для ТТК)',
    tls: [
      '--dpi-desync=fake,split2',
      '--dpi-desync-ttl=1',
      '--dpi-desync-autottl=5',
      '--dpi-desync-repeats=6',
      '--dpi-desync-fake-tls=@%TLS%'
    ],
    quic: QUIC6
  },
  {
    id: 'fake-fakedsplit-ts',
    name: 'Fake + fakedsplit (ts)',
    from: 'general (ALT)',
    tls: [
      '--dpi-desync=fake,fakedsplit',
      '--dpi-desync-repeats=6',
      '--dpi-desync-fooling=ts',
      '--dpi-desync-fakedsplit-pattern=0x00',
      '--dpi-desync-fake-tls=@%TLS%'
    ],
    quic: QUIC6
  },
  {
    id: 'multisplit-seqovl',
    name: 'Multisplit + seqovl',
    from: 'general, YoutubeFix v9.2',
    tls: [
      '--dpi-desync=multisplit',
      '--dpi-desync-split-seqovl=681',
      '--dpi-desync-split-pos=1',
      '--dpi-desync-split-seqovl-pattern=@%TLS%'
    ],
    quic: QUIC6
  },
  {
    id: 'fake-multisplit-ts',
    name: 'Fake + multisplit (ts)',
    from: 'general (ALT11), general v9.2 (ALT), UltimateFix v9.2',
    // 0.7.2: as UltimateFix v9.2 — the fakes carry IP ID 0 (some DPI keys on it)
    tls: [
      '--ip-id=zero',
      '--dpi-desync=fake,multisplit',
      '--dpi-desync-split-seqovl=681',
      '--dpi-desync-split-pos=1',
      '--dpi-desync-fooling=ts',
      '--dpi-desync-repeats=8',
      '--dpi-desync-split-seqovl-pattern=@%TLS%',
      '--dpi-desync-fake-tls=@%TLS%'
    ],
    quic: QUIC11
  },
  {
    id: 'fake-tls-auto',
    name: 'Fake TLS auto (badseq)',
    from: 'general (FAKE TLS AUTO ALT), general (ALT14)',
    tls: [
      '--dpi-desync=fake,fakedsplit',
      '--dpi-desync-split-pos=1',
      '--dpi-desync-fooling=badseq',
      '--dpi-desync-badseq-increment=2',
      '--dpi-desync-repeats=8',
      '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com'
    ],
    quic: QUIC11
  },
  {
    id: 'fake-badseq',
    name: 'Fake (badseq)',
    from: 'general (BADSEQ ALT), general (ALT13)',
    tls: [
      '--dpi-desync=fake',
      '--dpi-desync-fake-tls-mod=none',
      '--dpi-desync-repeats=6',
      '--dpi-desync-fooling=badseq',
      '--dpi-desync-badseq-increment=2'
    ],
    quic: QUIC6
  },
  {
    id: 'multidisorder-auto',
    name: 'Fake + multidisorder',
    from: 'general (FAKE TLS AUTO), general (MULTIDISORDER AUTO)',
    tls: [
      '--dpi-desync=fake,multidisorder',
      '--dpi-desync-split-pos=1,midsld',
      '--dpi-desync-repeats=11',
      '--dpi-desync-fooling=badseq',
      '--dpi-desync-fake-tls=0x00000000',
      '--dpi-desync-fake-tls=!',
      '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com'
    ],
    quic: QUIC11
  },
  {
    id: 'simple-fake-ts',
    name: 'Простой fake (ts)',
    from: 'general (SIMPLE FAKE), general (ALT10)',
    tls: [
      '--dpi-desync=fake',
      '--dpi-desync-repeats=6',
      '--dpi-desync-fooling=ts',
      '--dpi-desync-fake-tls=@%TLS%'
    ],
    quic: QUIC6
  },
  {
    id: 'hostfakesplit',
    name: 'Hostfakesplit',
    from: 'general (ALT9), general (HOSTFAKESPLIT)',
    tls: [
      '--dpi-desync=hostfakesplit',
      '--dpi-desync-repeats=4',
      '--dpi-desync-fooling=ts',
      '--dpi-desync-hostfakesplit-mod=host=www.google.com'
    ],
    quic: QUIC6
  },
  {
    id: 'sniext',
    name: 'Multisplit по SNI',
    from: 'general (ALT7), general (SNIEXT), general (ALT12)',
    tls: [
      '--dpi-desync=multisplit',
      '--dpi-desync-split-pos=2,sniext+1',
      '--dpi-desync-split-seqovl=679',
      '--dpi-desync-split-seqovl-pattern=@%TLS%'
    ],
    quic: QUIC6
  },
  {
    id: 'md5sig-multidisorder',
    name: 'Fake + multidisorder (md5sig)',
    from: 'general v9.2 (Beeline-Rostelecom), UltimateFix_ALT, Zapret_base',
    tls: [
      '--dpi-desync=fake,multidisorder',
      '--dpi-desync-split-pos=1,midsld',
      '--dpi-desync-repeats=8',
      '--dpi-desync-fooling=md5sig,badseq',
      '--dpi-desync-fake-tls=@%TLS%'
    ],
    quic: QUIC6
  }
]

export function strategyById(id: string | null | undefined): DpiStrategy | undefined {
  return STRATEGIES.find((s) => s.id === id)
}

/** HTTP (TCP 80) — the same for every strategy (most presets agree) */
const HTTP_DESYNC = [
  '--dpi-desync=fake,multisplit',
  '--dpi-desync-autottl=2',
  '--dpi-desync-fooling=md5sig'
]

/** Discord voice: its own UDP ports, recognized by the protocol (no domain in it) */
export const DISCORD_UDP = '19294-19344,50000-50100'
/** Discord's media servers also speak TLS on these ports (discord.media) */
export const DISCORD_TCP = '2053,2083,2087,2096,8443'

/** placeholders the broker fills in; nothing else may appear in a token */
export const PLACEHOLDERS = [
  '%TLS%',
  '%QUIC%',
  '%HOSTS%',
  '%EXCL%',
  '%DISCORD_IPS%',
  '%USER_IPS%',
  '%WF%'
] as const

// --- what WinDivert hands to winws at all (0.7.3) ----------------------------
// winws v72.13 (nfq/nfqws.c wf_make_filter) turns --wf-tcp=80,443 / --wf-udp=443
// into «outbound and (!tcp or tcp.Syn or tcp.Rst or tcp.Fin or
// tcp.PayloadLength>0) and (tcp.DstPort == 443 … or udp.DstPort == 443)» —
// EVERY data packet of every TCP connection to those ports and every UDP
// datagram to 443 goes through winws in user mode, with no address filter:
// our own VPN tunnel to a server on 443 (VLESS Reality over TCP, Hysteria2
// over UDP) included. --ipset-exclude only stops the desync, not the trip
// through winws (delay, jitter of the whole tunnel; packets in flight are lost
// when winws restarts during a pick). So the kernel filter is ours
// (--wf-raw-part, a file the broker writes): the same packets the constructor
// takes for TCP (non-empty outbound + the incoming SYN-ACK / RST / FIN that
// autottl needs), UDP 443 only for a QUIC v1 Initial (the layout of
// zapret's windivert_part.quic_initial_ietf.txt — the only QUIC packet winws
// acts on), and our servers' addresses left out IN THE KERNEL. winws still adds
// its prolog (!impostor, !loopback, ifIdx of --wf-iface) and the LAN filter.
// WinDivert 2.2: `!` negates ONE test only (not a group), and a test of a field
// the packet does not have is false whatever the operator (`!ip.DstAddr==A` is
// false for an IPv6 packet too — checked with WinDivertHelperEvalFilter) — so
// each family's address tests sit behind a guard: `(ipv6 or (ip.DstAddr!=A …))`.

/** outbound TCP to `ports`: the packets winws' own constructor takes (empty ACKs skipped) */
const wfTcpOut = (ports: string): string =>
  `(tcp and (${ports
    .split(',')
    .map((p) => `tcp.DstPort==${p}`)
    .join(' or ')}) and (tcp.Syn or tcp.Rst or tcp.Fin or tcp.PayloadLength>0))`

/** incoming SYN-ACK / RST / FIN from `ports` (autottl reads the server's TTL from the SYN-ACK) */
const wfTcpIn = (ports: string): string =>
  `(tcp and (${ports
    .split(',')
    .map((p) => `tcp.SrcPort==${p}`)
    .join(' or ')}) and (tcp.Ack and tcp.Syn or tcp.Rst or tcp.Fin))`

/** a QUIC v1 Initial to UDP 443: long header, type Initial, version 1, ≥ 256 bytes */
export const WF_QUIC_INITIAL =
  '(udp and udp.DstPort==443 and udp.PayloadLength>=256 and udp.Payload[0]>=0xC0 and udp.Payload[0]<0xD0 and udp.Payload[1]==0 and udp.Payload16[1]==0 and udp.Payload[4]==1)'

/** Discord voice: its UDP ports as before (winws recognizes the protocol itself) */
const wfDiscordUdp = (): string =>
  `(udp and (${DISCORD_UDP.split(',')
    .map((r) => {
      const [a, b] = r.split('-')
      return b ? `udp.DstPort>=${a} and udp.DstPort<=${b}` : `udp.DstPort==${a}`
    })
    .join(' or ')}))`

/**
 * The fixed parts of our WinDivert filter: `out` (outbound packets winws gets)
 * and `in` (incoming ones). The broker appends the address tests of our servers
 * to both; nothing else is ever added.
 */
export function wfParts(discord: boolean): { out: string; in: string } {
  const tcp = `80,443${discord ? `,${DISCORD_TCP}` : ''}`
  const out = [wfTcpOut(tcp), WF_QUIC_INITIAL, ...(discord ? [wfDiscordUdp()] : [])]
  return { out: `outbound and (${out.join(' or ')})`, in: `inbound and ${wfTcpIn(tcp)}` }
}

/**
 * The most address tests (a single address = 1, a range = 2) per direction:
 * WinDivert 2.2 refuses a longer filter (checked with WinDivertHelperCompileFilter
 * on the shipped WinDivert.dll: 80 single addresses still compile, 88 do not).
 * More → no exclusion in the kernel (the filter as before 0.7.3, --ipset-exclude only).
 */
export const WF_MAX_TESTS = 64

const v4Num = (s: string): bigint =>
  s.split('.').reduce((n, o) => (n << 8n) | BigInt(Number(o)), 0n)

function v6Num(s: string): bigint {
  // expanded by hand: «::» → the missing zero groups
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined]
  const h = head ? head.split(':') : []
  const t = tail === undefined ? [] : tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n)
}

const v4Text = (n: bigint): string =>
  [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 0xffn)).join('.')
const v6Text = (n: bigint): string =>
  [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((s) => ((n >> s) & 0xffffn).toString(16)).join(':')

/**
 * One excluded address / range as the WinDivert tests for `dir` (Dst / Src)
 * that are true for every OTHER address of its family; `key` = the range, for
 * dropping duplicates. The broker does the same in PowerShell (Wf-Tests) —
 * this one is for the tests and documentation. Input: plain IPv4 / IPv6 (no
 * IPv4-in-IPv6 dots), optional /prefix.
 */
export function wfAddressTests(
  cidr: string,
  dir: 'Dst' | 'Src'
): { key: string; n: number; v6: boolean; text: string } {
  const [addr, mask] = cidr.split('/')
  const v6 = addr.includes(':')
  const width = v6 ? 128n : 32n
  const bits = BigInt(mask === undefined ? Number(width) : Number(mask))
  const n = v6 ? v6Num(addr.toLowerCase()) : v4Num(addr)
  const all = (1n << width) - 1n
  const host = (1n << (width - bits)) - 1n
  const lo = n & (all ^ host)
  const hi = lo | host
  const text = v6 ? v6Text : v4Text
  const f = `${v6 ? 'ipv6' : 'ip'}.${dir}Addr`
  const key = `${text(lo)}-${text(hi)}`
  if (lo === hi) return { key, n: 1, v6, text: `${f}!=${text(lo)}` }
  return { key, n: 2, v6, text: `(${f}<${text(lo)} or ${f}>${text(hi)})` }
}

/**
 * The address part of the filter: each family's tests behind a guard — an
 * IPv4 test is false for an IPv6 packet (a missing field fails, `!=` too), so
 * `(ipv6 or (…IPv4 tests…)) and (ip or (…IPv6 tests…))`. '' = nothing excluded.
 */
function wfExclusion(tests: { v6: boolean; text: string }[]): string {
  const v4 = tests.filter((t) => !t.v6).map((t) => t.text)
  const v6 = tests.filter((t) => t.v6).map((t) => t.text)
  return [
    ...(v4.length ? [`(ipv6 or (${v4.join(' and ')}))`] : []),
    ...(v6.length ? [`(ip or (${v6.join(' and ')}))`] : [])
  ].join(' and ')
}

/**
 * The --wf-raw-part file of the broker (Wf-Filter): our parts, our servers'
 * addresses left out of both directions; too many → none left out.
 */
export function windivertFilter(discord: boolean, exclude: readonly string[]): string {
  const p = wfParts(discord)
  const seen = new Set<string>()
  const dst: { v6: boolean; text: string }[] = []
  const src: { v6: boolean; text: string }[] = []
  let tests = 0
  for (const x of exclude) {
    const d = wfAddressTests(x, 'Dst')
    if (seen.has(d.key)) continue
    seen.add(d.key)
    tests += d.n
    dst.push(d)
    src.push(wfAddressTests(x, 'Src'))
  }
  const tooMany = tests > WF_MAX_TESTS
  const out = dst.length && !tooMany ? `${p.out} and ${wfExclusion(dst)}` : p.out
  const inb = src.length && !tooMany ? `${p.in} and ${wfExclusion(src)}` : p.in
  return `(${out})\nor\n(${inb})\n`
}

/** a token: `--option` or `--option=value`, value without spaces / quotes / shell syntax */
export const TOKEN_RE = /^--[a-z0-9-]+(=[A-Za-z0-9@%.,:+!=_-]+)?$/

/**
 * The whole winws command line of a strategy, as tokens with placeholders.
 * `discord`: the Discord profiles (voice UDP, extra TLS ports) are added.
 * The interface (--wf-iface) is added by the broker: it finds the adapter.
 * The packets winws gets: the broker's filter file %WF% (windivertFilter —
 * the Discord ports in it follow the same switch).
 */
export function winwsTokens(s: DpiStrategy, discord: boolean): string[] {
  const excl = '--ipset-exclude=%EXCL%'
  const hosts = '--hostlist=%HOSTS%'
  const t: string[] = [
    '--wf-raw-part=@%WF%',
    // QUIC (YouTube in the browser)
    '--filter-udp=443',
    hosts,
    excl,
    ...s.quic,
    '--new',
    // plain HTTP (redirects)
    '--filter-tcp=80',
    hosts,
    excl,
    ...HTTP_DESYNC,
    '--new',
    // TLS — the main one
    '--filter-tcp=443',
    hosts,
    excl,
    ...s.tls
  ]
  if (discord) {
    t.push(
      '--new',
      `--filter-udp=${DISCORD_UDP}`,
      '--filter-l7=discord,stun',
      // only Discord's voice servers — never anyone else's STUN / UDP
      '--ipset=%DISCORD_IPS%',
      excl,
      '--dpi-desync=fake',
      '--dpi-desync-repeats=6',
      '--dpi-desync-fake-discord=@%QUIC%',
      '--dpi-desync-fake-stun=@%QUIC%',
      '--new',
      `--filter-tcp=${DISCORD_TCP}`,
      '--hostlist-domains=discord.media',
      excl,
      ...s.tls
    )
  }
  return t
}

/**
 * 0.7.2: the profiles of the user's «Напрямую + zapret» IP rules — the same
 * desync as the hostlist profiles, by address (QUIC, HTTP, TLS). Appended by
 * the broker only when that ipset is not empty (an empty ipset would not
 * filter at all). Starts with `--new`: it follows winwsTokens.
 */
export function userIpTokens(s: DpiStrategy): string[] {
  const excl = '--ipset-exclude=%EXCL%'
  const ips = '--ipset=%USER_IPS%'
  return [
    '--new',
    '--filter-udp=443',
    ips,
    excl,
    ...s.quic,
    '--new',
    '--filter-tcp=80',
    ips,
    excl,
    ...HTTP_DESYNC,
    '--new',
    '--filter-tcp=443',
    ips,
    excl,
    ...s.tls
  ]
}

/** Every token of every strategy is a plain option (checked by the tests and the broker build). */
export function tokenProblems(tokens: string[]): string[] {
  return tokens.filter((t) => {
    if (!TOKEN_RE.test(t)) return true
    const marks = t.match(/%[A-Z_]+%/g) ?? []
    return marks.some((m) => !(PLACEHOLDERS as readonly string[]).includes(m))
  })
}
