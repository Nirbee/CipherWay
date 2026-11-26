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
    tls: [
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
export const PLACEHOLDERS = ['%TLS%', '%QUIC%', '%HOSTS%', '%EXCL%', '%DISCORD_IPS%'] as const
/** a token: `--option` or `--option=value`, value without spaces / quotes / shell syntax */
export const TOKEN_RE = /^--[a-z0-9-]+(=[A-Za-z0-9@%.,:+!=_-]+)?$/

/**
 * The whole winws command line of a strategy, as tokens with placeholders.
 * `discord`: the Discord profiles (voice UDP, extra TLS ports) are added.
 * The interface (--wf-iface) is added by the broker: it finds the adapter.
 */
export function winwsTokens(s: DpiStrategy, discord: boolean): string[] {
  const excl = '--ipset-exclude=%EXCL%'
  const hosts = '--hostlist=%HOSTS%'
  const t: string[] = [
    `--wf-tcp=80,443${discord ? `,${DISCORD_TCP}` : ''}`,
    `--wf-udp=443${discord ? `,${DISCORD_UDP}` : ''}`,
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

/** Every token of every strategy is a plain option (checked by the tests and the broker build). */
export function tokenProblems(tokens: string[]): string[] {
  return tokens.filter((t) => {
    if (!TOKEN_RE.test(t)) return true
    const marks = t.match(/%[A-Z_]+%/g) ?? []
    return marks.some((m) => !(PLACEHOLDERS as readonly string[]).includes(m))
  })
}
