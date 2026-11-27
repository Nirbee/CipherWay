import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DPI_EXE, DPI_FAKE_QUIC, DPI_FAKE_TLS } from '../core/coreNames'
import {
  STRATEGIES,
  strategyById,
  tokenProblems,
  userIpTokens,
  WF_MAX_TESTS,
  wfAddressTests,
  windivertFilter,
  winwsTokens
} from './strategies'
import { SERVICE_DEFS } from './lists'

describe('strategy table', () => {
  it('8–14 different strategies with unique ids', () => {
    expect(STRATEGIES.length).toBeGreaterThanOrEqual(8)
    expect(STRATEGIES.length).toBeLessThanOrEqual(14)
    const ids = STRATEGIES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/)
    // no two strategies bend TLS the same way
    const tls = STRATEGIES.map((s) => s.tls.join(' '))
    expect(new Set(tls).size).toBe(tls.length)
    expect(strategyById('sniext')?.name).toBeTruthy()
    expect(strategyById('nope')).toBeUndefined()
  })

  it('every token is a plain option with known placeholders only (no paths, no quotes)', () => {
    for (const s of STRATEGIES) {
      for (const discord of [false, true]) {
        const t = winwsTokens(s, discord)
        expect(tokenProblems(t)).toEqual([])
        expect(t.join(' ')).not.toMatch(/["'\\/]/)
      }
      expect(tokenProblems(userIpTokens(s))).toEqual([])
    }
    expect(tokenProblems(['--x="a b"', '--hostlist=C:\\x', '--a=%EVIL%', '-x'])).toHaveLength(4)
  })

  it('every profile skips our servers; Discord profiles only when Discord is on', () => {
    const s = STRATEGIES[0]
    const off = winwsTokens(s, false)
    const on = winwsTokens(s, true)
    const profiles = (t: string[]): number => t.filter((x) => x === '--new').length + 1
    expect(off.filter((x) => x === '--ipset-exclude=%EXCL%')).toHaveLength(profiles(off))
    expect(on.filter((x) => x === '--ipset-exclude=%EXCL%')).toHaveLength(profiles(on))
    expect(off.join(' ')).not.toMatch(/discord/)
    expect(on).toContain('--filter-l7=discord,stun')
    // the voice profile acts on Discord's own ranges only, never on anyone's STUN
    const at = on.indexOf('--filter-l7=discord,stun')
    expect(on.slice(at, on.indexOf('--new', at))).toContain('--ipset=%DISCORD_IPS%')
    // 0.7.3: the packets winws gets come from the broker's filter file only
    expect(off[0]).toBe('--wf-raw-part=@%WF%')
    for (const t of [off, on]) expect(t.join(' ')).not.toMatch(/--wf-(tcp|udp|raw)=/)
    // the user's IP profiles: by address only, our servers skipped too
    const ip = userIpTokens(s)
    expect(ip[0]).toBe('--new')
    expect(ip.filter((x) => x === '--ipset=%USER_IPS%')).toHaveLength(3)
    expect(ip.filter((x) => x === '--ipset-exclude=%EXCL%')).toHaveLength(3)
    expect(ip.join(' ')).not.toContain('%HOSTS%')
    // UltimateFix v9.2: IP ID 0 in fake + multisplit (ts)
    expect(strategyById('fake-multisplit-ts')?.tls).toContain('--ip-id=zero')
    expect(on[0]).toBe('--wf-raw-part=@%WF%')
  })
})

describe('the WinDivert filter (0.7.3): our servers never reach winws', () => {
  it('an address / range → tests that leave it out, IPv6 printed in full by us', () => {
    expect(wfAddressTests('203.0.113.7/32', 'Dst')).toEqual({
      key: '203.0.113.7-203.0.113.7',
      n: 1,
      v6: false,
      text: 'ip.DstAddr!=203.0.113.7'
    })
    expect(wfAddressTests('198.51.100.8', 'Src').text).toBe('ip.SrcAddr!=198.51.100.8')
    // a range: masked to its network, both ends
    expect(wfAddressTests('198.51.100.77/24', 'Dst')).toEqual({
      key: '198.51.100.0-198.51.100.255',
      n: 2,
      v6: false,
      text: '(ip.DstAddr<198.51.100.0 or ip.DstAddr>198.51.100.255)'
    })
    expect(wfAddressTests('2001:DB8::7/128', 'Dst').text).toBe(
      'ipv6.DstAddr!=2001:db8:0:0:0:0:0:7'
    )
    expect(wfAddressTests('2001:db8:c0c:1::1', 'Src').text).toBe(
      'ipv6.SrcAddr!=2001:db8:c0c:1:0:0:0:1'
    )
    expect(wfAddressTests('2001:db8:1::/48', 'Src').text).toBe(
      '(ipv6.SrcAddr<2001:db8:1:0:0:0:0:0 or ipv6.SrcAddr>2001:db8:1:ffff:ffff:ffff:ffff:ffff)'
    )
  })

  it('TCP as winws builds it (+ SYN-ACK / RST / FIN back), UDP 443 only for a QUIC Initial, servers left out both ways', () => {
    const f = windivertFilter(false, ['203.0.113.7/32', '2001:db8::7/128', '203.0.113.7'])
    const [out, or, inb] = f.trim().split('\n')
    expect(or).toBe('or')
    expect(out).toBe(
      '(outbound and ((tcp and (tcp.DstPort==80 or tcp.DstPort==443) and (tcp.Syn or tcp.Rst or tcp.Fin or tcp.PayloadLength>0))' +
        ' or (udp and udp.DstPort==443 and udp.PayloadLength>=256 and udp.Payload[0]>=0xC0 and udp.Payload[0]<0xD0 and udp.Payload[1]==0 and udp.Payload16[1]==0 and udp.Payload[4]==1))' +
        ' and (ipv6 or (ip.DstAddr!=203.0.113.7)) and (ip or (ipv6.DstAddr!=2001:db8:0:0:0:0:0:7)))'
    )
    expect(inb).toBe(
      '(inbound and (tcp and (tcp.SrcPort==80 or tcp.SrcPort==443) and (tcp.Ack and tcp.Syn or tcp.Rst or tcp.Fin))' +
        ' and (ipv6 or (ip.SrcAddr!=203.0.113.7)) and (ip or (ipv6.SrcAddr!=2001:db8:0:0:0:0:0:7)))'
    )
    // Discord: its TLS ports both ways, its voice UDP ports out
    const d = windivertFilter(true, [])
    expect(d).toContain('tcp.DstPort==2083')
    expect(d).toContain('tcp.SrcPort==8443')
    expect(d).toContain(
      '(udp and (udp.DstPort>=19294 and udp.DstPort<=19344 or udp.DstPort>=50000 and udp.DstPort<=50100))'
    )
    // no servers known: nothing left out (as before 0.7.3)
    expect(d).not.toMatch(/Addr/)
    expect(windivertFilter(false, [])).not.toMatch(/Addr/)
  })

  it('too many for WinDivert: none left out (never a filter it refuses)', () => {
    const many = Array.from({ length: WF_MAX_TESTS + 1 }, (_, i) => `203.0.${i >> 8}.${i & 255}`)
    expect(windivertFilter(false, many)).not.toMatch(/Addr/)
    expect(windivertFilter(false, many.slice(0, WF_MAX_TESTS))).toContain(
      `ip.DstAddr!=203.0.0.${WF_MAX_TESTS - 1}`
    )
  })
})

// --- the official winws (zapret v72.13) checks every line itself ------------
// `--dry-run` = «verify parameters and exit with code 0 if successful». winws
// asks for admin rights in its manifest; RunAsInvoker lets the check run as the
// user (it opens no driver in --dry-run).

const BIN = resolve(__dirname, '../../../resources/bin')
const EXE = join(BIN, DPI_EXE)
const canRun = process.platform === 'win32' && existsSync(EXE)

describe.skipIf(!canRun)('cipherway-dpi.exe --dry-run accepts every strategy', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cw-dpi-dry-'))
  const hosts = join(tmp, 'hosts.txt')
  const excl = join(tmp, 'exclude.txt')
  const voice = join(tmp, 'discord-ips.txt')
  const userIps = join(tmp, 'ips.txt')
  writeFileSync(userIps, '198.51.100.0/24\n2001:db8:1::/48\n')
  writeFileSync(hosts, 'youtube.com\ngooglevideo.com\nexample.org\n')
  writeFileSync(excl, '10.0.0.0/8\n203.0.113.7/32\n2001:db8::/32\n')
  writeFileSync(voice, SERVICE_DEFS.discord.cidrs.join('\n') + '\n')
  const EXCL_SAMPLE = ['203.0.113.7/32', '2001:db8::7/128', '198.51.100.0/24']
  const wf = (discord: boolean): string => {
    const f = join(tmp, `wf${discord ? 1 : 0}.txt`)
    writeFileSync(f, windivertFilter(discord, EXCL_SAMPLE))
    return f
  }
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  const dryRun = (
    tokens: string[],
    discord = false,
    first = '--dry-run'
  ): { code: number; out: string } => {
    const args = [
      first,
      '--wf-iface=1',
      ...tokens.map((t) =>
        t
          .replace('%TLS%', join(BIN, DPI_FAKE_TLS))
          .replace('%QUIC%', join(BIN, DPI_FAKE_QUIC))
          .replace('%HOSTS%', hosts)
          .replace('%EXCL%', excl)
          .replace('%DISCORD_IPS%', voice)
          .replace('%USER_IPS%', userIps)
          .replace('%WF%', wf(discord))
      )
    ]
    try {
      const out = execFileSync(EXE, args, {
        cwd: BIN,
        env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' },
        windowsHide: true,
        timeout: 20_000,
        stdio: 'pipe'
      })
      return { code: 0, out: String(out) }
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  for (const s of STRATEGIES) {
    for (const discord of [false, true]) {
      it(`${s.id}${discord ? ' + Discord + IP rules' : ''}`, () => {
        const r = dryRun(
          [...winwsTokens(s, discord), ...(discord ? userIpTokens(s) : [])],
          discord
        )
        expect(r.out).toMatch(/command line parameters verified/)
        expect(r.code).toBe(0)
      })
    }
  }

  it('winws puts our filter between its prolog (the adapter) and its LAN filter (--wf-save)', () => {
    for (const discord of [false, true]) {
      const saved = join(tmp, `saved${discord ? 1 : 0}.txt`)
      const r = dryRun(winwsTokens(STRATEGIES[0], discord), discord, `--wf-save=${saved}`)
      expect(r.code).toBe(0)
      const f = readFileSync(saved, 'utf8')
      expect(f.startsWith('!impostor and !loopback and ifIdx=1 and subIfIdx=0 and\n(')).toBe(true)
      expect(f).toContain(windivertFilter(discord, EXCL_SAMPLE).trim())
      // nothing of winws' own port filter: only our parts
      expect(f).not.toMatch(/tcp\.DstPort == |udp\.DstPort == /)
      expect(f).toContain('ip.DstAddr < 10.0.0.0 or ip.DstAddr > 10.255.255.255')
    }
  })

  it('WinDivert itself compiles the whole filter (WinDivertHelperCompileFilter, no driver)', () => {
    // the shipped WinDivert.dll in user mode: its compiler is what the driver would get
    const files: string[] = []
    const cases: [boolean, string[]][] = [
      [false, EXCL_SAMPLE],
      [true, EXCL_SAMPLE],
      [true, []],
      // the most addresses we ever put in (half IPv6, as long as they get)
      [
        true,
        Array.from({ length: WF_MAX_TESTS }, (_, i) =>
          i % 2 ? `2001:db8:c0c:${i.toString(16)}:ffff:ffff:ffff:ffff/128` : `203.0.113.${i}/32`
        )
      ],
      // the longest text: all of them IPv6 of the full length, with Discord
      [
        true,
        Array.from(
          { length: WF_MAX_TESTS },
          (_, i) => `2001:db8:ffff:ffff:ffff:ffff:ffff:${(0xff00 + i).toString(16)}/128`
        )
      ]
    ]
    cases.forEach(([discord, ex], i) => {
      const part = join(tmp, `part${i}.txt`)
      writeFileSync(part, windivertFilter(discord, ex))
      const saved = join(tmp, `full${i}.txt`)
      const r = dryRun(
        winwsTokens(STRATEGIES[0], discord).map((t) => t.replace('%WF%', part)),
        discord,
        `--wf-save=${saved}`
      )
      expect(r.code).toBe(0)
      files.push(saved)
    })
    const script = join(tmp, 'compile.ps1')
    writeFileSync(
      script,
      [
        'param([string]$Dll, [string]$List)',
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -TypeDefinition @"',
        'using System; using System.Runtime.InteropServices;',
        'public static class WDC {',
        '  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibraryW(string p);',
        '  [DllImport("WinDivert.dll", CallingConvention=CallingConvention.Cdecl)] public static extern bool WinDivertHelperCompileFilter([MarshalAs(UnmanagedType.LPStr)] string f, int layer, IntPtr obj, uint len, out IntPtr err, out uint pos);',
        '}',
        '"@',
        "if ([WDC]::LoadLibraryW($Dll) -eq [IntPtr]::Zero) { throw 'no dll' }",
        "foreach ($f in ([IO.File]::ReadAllText($List) -split \"`n\")) {",
        '  if (-not $f) { continue }',
        '  $e = [IntPtr]::Zero; $p = 0',
        '  $ok = [WDC]::WinDivertHelperCompileFilter([IO.File]::ReadAllText($f), 0, [IntPtr]::Zero, 0, [ref]$e, [ref]$p)',
        "  if ($ok) { 'OK' } else { 'ERR ' + [Runtime.InteropServices.Marshal]::PtrToStringAnsi($e) + ' at ' + $p }",
        '}'
      ].join('\r\n')
    )
    const list = join(tmp, 'list.txt')
    writeFileSync(list, files.join('\n'))
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, join(BIN, 'WinDivert.dll'), list],
      { windowsHide: true, timeout: 60_000, encoding: 'utf8' }
    )
    expect(out.trim().split(/\r?\n/)).toEqual(files.map(() => 'OK'))
  }, 90_000)

  it('WinDivert decides packet by packet: the tunnel never reaches winws, YouTube / QUIC Initials do (WinDivertHelperEvalFilter)', () => {
    // the whole filter of winws for one IPv4 + one IPv6 server and a range, adapter 1 (--wf-iface=1)
    const part = join(tmp, 'eval-part.txt')
    writeFileSync(part, windivertFilter(true, EXCL_SAMPLE))
    const saved = join(tmp, 'eval-full.txt')
    const r = dryRun(
      winwsTokens(STRATEGIES[0], true).map((t) => t.replace('%WF%', part)),
      true,
      `--wf-save=${saved}`
    )
    expect(r.code).toBe(0)

    const ip4 = (s: string, d: string, proto: number, l4: Buffer): Buffer => {
      const h = Buffer.alloc(20)
      h[0] = 0x45
      h.writeUInt16BE(20 + l4.length, 2)
      h[8] = 64
      h[9] = proto
      s.split('.').forEach((o, i) => (h[12 + i] = Number(o)))
      d.split('.').forEach((o, i) => (h[16 + i] = Number(o)))
      return Buffer.concat([h, l4])
    }
    const v6bytes = (a: string): Buffer => {
      const [head, tail] = a.split('::')
      const hs = head ? head.split(':') : []
      const ts = tail ? tail.split(':') : []
      const g = [...hs, ...Array(8 - hs.length - ts.length).fill('0'), ...ts]
      const b = Buffer.alloc(16)
      g.forEach((x, i) => b.writeUInt16BE(parseInt(x, 16), 2 * i))
      return b
    }
    const ip6 = (s: string, d: string, proto: number, l4: Buffer): Buffer => {
      const h = Buffer.alloc(40)
      h.writeUInt32BE(6 << 28, 0)
      h.writeUInt16BE(l4.length, 4)
      h[6] = proto
      h[7] = 64
      v6bytes(s).copy(h, 8)
      v6bytes(d).copy(h, 24)
      return Buffer.concat([h, l4])
    }
    const tcp = (sp: number, dp: number, flags: number, payload = Buffer.alloc(0)): Buffer => {
      const h = Buffer.alloc(20)
      h.writeUInt16BE(sp, 0)
      h.writeUInt16BE(dp, 2)
      h.writeUInt32BE(1, 4)
      h[12] = 5 << 4
      h[13] = flags
      h.writeUInt16BE(65535, 14)
      return Buffer.concat([h, payload])
    }
    const udp = (sp: number, dp: number, payload: Buffer): Buffer => {
      const h = Buffer.alloc(8)
      h.writeUInt16BE(sp, 0)
      h.writeUInt16BE(dp, 2)
      h.writeUInt16BE(8 + payload.length, 4)
      return Buffer.concat([h, payload])
    }
    const [ACK, SYN, PSH, FIN] = [0x10, 0x02, 0x08, 0x01]
    // a QUIC v1 Initial (long header, type 0, version 1), padded; a short-header datagram
    const quic = Buffer.concat([Buffer.from([0xc3, 0, 0, 0, 1, 8]), Buffer.alloc(1200, 0x11)])
    const short = Buffer.concat([Buffer.from([0x41]), Buffer.alloc(1200, 0x33)])
    const hello = Buffer.concat([Buffer.from([0x16, 3, 1]), Buffer.alloc(200)])
    const [me4, me6] = ['192.0.2.10', '2001:db8:ffff::10']
    const [srv4, srv6, inRange] = ['203.0.113.7', '2001:db8::7', '198.51.100.200']
    const [yt4, yt6] = ['142.250.74.110', '2a00:1450:4001::1']
    // name, outbound, packet, does winws get it
    const cases: [string, boolean, Buffer, boolean][] = [
      ['tunnel TCP data → server v4:443', true, ip4(me4, srv4, 6, tcp(50000, 443, ACK | PSH, hello)), false],
      ['tunnel SYN → server v4:443', true, ip4(me4, srv4, 6, tcp(50000, 443, SYN)), false],
      ['SYN-ACK ← server v4:443', false, ip4(srv4, me4, 6, tcp(443, 50000, SYN | ACK)), false],
      ['tunnel TCP data → server v6:443', true, ip6(me6, srv6, 6, tcp(50000, 443, ACK | PSH, hello)), false],
      ['SYN-ACK ← server v6:443', false, ip6(srv6, me6, 6, tcp(443, 50000, SYN | ACK)), false],
      ['tunnel TCP → server in a range :2083', true, ip4(me4, inRange, 6, tcp(50000, 2083, ACK | PSH, hello)), false],
      ['Hysteria2 Initial-like → server v4:443', true, ip4(me4, srv4, 17, udp(50000, 443, quic)), false],
      ['Hysteria2 data → server v4:443', true, ip4(me4, srv4, 17, udp(50000, 443, short)), false],
      ['Hysteria2 data → server v6:443', true, ip6(me6, srv6, 17, udp(50000, 443, short)), false],
      ['ClientHello → YouTube v4:443', true, ip4(me4, yt4, 6, tcp(50001, 443, ACK | PSH, hello)), true],
      ['SYN → YouTube v4:443', true, ip4(me4, yt4, 6, tcp(50001, 443, SYN)), true],
      ['FIN → YouTube v4:443', true, ip4(me4, yt4, 6, tcp(50001, 443, FIN | ACK)), true],
      ['SYN-ACK ← YouTube v4:443 (autottl)', false, ip4(yt4, me4, 6, tcp(443, 50001, SYN | ACK)), true],
      ['empty ACK → YouTube v4:443', true, ip4(me4, yt4, 6, tcp(50001, 443, ACK)), false],
      ['ClientHello → YouTube v6:443', true, ip6(me6, yt6, 6, tcp(50001, 443, ACK | PSH, hello)), true],
      ['SYN-ACK ← YouTube v6:443', false, ip6(yt6, me6, 6, tcp(443, 50001, SYN | ACK)), true],
      ['QUIC Initial → YouTube v4:443', true, ip4(me4, yt4, 17, udp(50002, 443, quic)), true],
      ['QUIC Initial → YouTube v6:443', true, ip6(me6, yt6, 17, udp(50002, 443, quic)), true],
      ['QUIC short header (video) → YouTube v4:443', true, ip4(me4, yt4, 17, udp(50002, 443, short)), false],
      ['HTTP → a site v4:80', true, ip4(me4, yt4, 6, tcp(50003, 80, ACK | PSH, hello)), true],
      ['Discord TLS → discord.media v4:2083', true, ip4(me4, '162.159.130.234', 6, tcp(50004, 2083, ACK | PSH, hello)), true],
      ['Discord voice → v4:50010', true, ip4(me4, '66.22.200.1', 17, udp(50005, 50010, short)), true],
      ['some UDP → v4:3478', true, ip4(me4, yt4, 17, udp(50006, 3478, short)), false]
    ]
    const list = join(tmp, 'eval-cases.txt')
    writeFileSync(
      list,
      // + the IPv6 flag of the address, as the driver sets it (the version nibble)
      cases
        .map(([, out, p]) => `${out ? 1 : 0}|${p.toString('hex')}|${p[0] >> 4 === 6 ? 1 : 0}`)
        .join('\n')
    )
    const script = join(tmp, 'eval.ps1')
    writeFileSync(
      script,
      [
        'param([string]$Dll, [string]$Filter, [string]$Cases)',
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -TypeDefinition @"',
        'using System; using System.Runtime.InteropServices;',
        'public static class WDE {',
        '  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibraryW(string p);',
        '  [DllImport("WinDivert.dll", CallingConvention=CallingConvention.Cdecl)] public static extern bool WinDivertHelperEvalFilter([MarshalAs(UnmanagedType.LPStr)] string f, byte[] pkt, uint len, byte[] addr);',
        '}',
        '"@',
        "if ([WDE]::LoadLibraryW($Dll) -eq [IntPtr]::Zero) { throw 'no dll' }",
        '$f = [IO.File]::ReadAllText($Filter)',
        'foreach ($line in [IO.File]::ReadAllLines($Cases)) {',
        "  $p = $line.Split('|')",
        '  $pkt = New-Object byte[] ($p[1].Length / 2)',
        '  for ($i = 0; $i -lt $pkt.Length; $i++) { $pkt[$i] = [Convert]::ToByte($p[1].Substring(2 * $i, 2), 16) }',
        // WINDIVERT_ADDRESS: Timestamp, then Layer:8 Event:8 Sniffed:1 Outbound:1
        // Loopback:1 Impostor:1 IPv6:1 …; Network.IfIdx at 16
        '  $addr = New-Object byte[] 80',
        "  $flags = 0",
        "  if ($p[0] -eq '1') { $flags = $flags -bor (1 -shl 17) }",
        "  if ($p[2] -eq '1') { $flags = $flags -bor (1 -shl 20) }",
        '  [BitConverter]::GetBytes([uint32]$flags).CopyTo($addr, 8)',
        '  [BitConverter]::GetBytes([uint32]1).CopyTo($addr, 16)',
        "  $(if ([WDE]::WinDivertHelperEvalFilter($f, $pkt, [uint32]$pkt.Length, $addr)) { '1' } else { '0' })",
        '}'
      ].join('\r\n')
    )
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, join(BIN, 'WinDivert.dll'), saved, list],
      { windowsHide: true, timeout: 60_000, encoding: 'utf8' }
    )
    const got = out.trim().split(/\r?\n/)
    expect(Object.fromEntries(cases.map(([name], i) => [name, got[i] === '1']))).toEqual(
      Object.fromEntries(cases.map(([name, , , want]) => [name, want]))
    )
  }, 90_000)

  it('a wrong option is refused (the check is real)', () => {
    const r = dryRun(['--wf-tcp=443', '--filter-tcp=443', '--dpi-desync=no-such-mode'])
    expect(r.code).not.toBe(0)
  })
})
