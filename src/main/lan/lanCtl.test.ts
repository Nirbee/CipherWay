import { describe, expect, it } from 'vitest'
import {
  foreignIps,
  isAccessError,
  isLanIp,
  LanCtl,
  NO_AUTO_UPDATE_ARGS,
  parsePing,
  parseStatus,
  pingArgs,
  upArgs
} from './lanCtl'
import { lanLogEntries } from './logLines'
import { redactLan } from './redact'

describe('cipherway-lanctl command lines (flags of tailscale 1.104.7)', () => {
  it('up: our login server, the key from a file, neutral name, no DNS / routes from the server', () => {
    expect(
      upArgs({
        loginServer: 'https://lan.cipherway.ru',
        authKeyFile: 'C:\\Users\\Иван\\AppData\\Roaming\\cipherway\\run\\lan-key.txt',
        hostname: 'cw-0a1b2c'
      })
    ).toEqual([
      'up',
      '--login-server=https://lan.cipherway.ru',
      '--auth-key=file:C:\\Users\\Иван\\AppData\\Roaming\\cipherway\\run\\lan-key.txt',
      '--hostname=cw-0a1b2c',
      '--accept-dns=false',
      '--accept-routes=false',
      '--exit-node=',
      '--advertise-exit-node=false',
      '--advertise-routes=',
      '--unattended',
      '--reset',
      '--timeout=60s'
    ])
  })

  it('up without a key (registered, only switched off)', () => {
    const a = upArgs({ loginServer: 'https://lan.cipherway.ru', hostname: 'cw-0a1b2c' })
    expect(a.some((x) => x.startsWith('--auth-key'))).toBe(false)
    // the same DNS / route / exit-node lock on every `up`
    for (const f of [
      '--accept-dns=false',
      '--accept-routes=false',
      '--exit-node=',
      '--advertise-exit-node=false',
      '--advertise-routes='
    ]) {
      expect(a).toContain(f)
    }
    expect(
      a.some((x) => /--ssh|--advertise-tags|--accept-routes=true|--accept-dns=true/.test(x))
    ).toBe(false)
  })

  it('refuses odd values instead of passing them to the CLI', () => {
    expect(() => upArgs({ loginServer: 'http://lan.cipherway.ru', hostname: 'cw-1' })).toThrow()
    expect(() =>
      upArgs({ loginServer: 'https://lan.cipherway.ru --ssh', hostname: 'cw-0a1b2c' })
    ).toThrow()
    expect(() => upArgs({ loginServer: 'https://lan.cipherway.ru', hostname: 'Мой ПК' })).toThrow()
    expect(() => pingArgs('8.8.8.8')).toThrow()
    expect(pingArgs('100.64.0.7')).toEqual([
      'ping',
      '--c=1',
      '--timeout=3s',
      '--until-direct=false',
      '100.64.0.7'
    ])
  })

  it('every call goes to OUR pipe, first argument', async () => {
    const calls: string[][] = []
    const ctl = new LanCtl({
      exe: 'C:\\x\\cipherway-lanctl.exe',
      pipe: '\\\\.\\pipe\\ProtectedPrefix\\Administrators\\CipherWay\\lan-S-1-5-21-1-2-3-1001',
      execFn: async (_exe, args) => {
        calls.push(args)
        return {
          code: 0,
          stdout: '{"BackendState":"Running","TailscaleIPs":["100.64.0.2"]}',
          stderr: ''
        }
      }
    })
    await ctl.status()
    await ctl.up({ loginServer: 'https://lan.cipherway.ru', hostname: 'cw-0a1b2c' })
    for (const c of calls) {
      expect(c[0]).toBe(
        '--socket=\\\\.\\pipe\\ProtectedPrefix\\Administrators\\CipherWay\\lan-S-1-5-21-1-2-3-1001'
      )
    }
    expect(calls[0].slice(1)).toEqual(['status', '--json'])
  })

  it('a failing call: its output, redacted', async () => {
    const ctl = new LanCtl({
      exe: 'x',
      pipe: 'p',
      execFn: async () => ({
        code: 1,
        stdout: '',
        stderr: 'backend error: invalid key: --auth-key=hskey-auth-abc_DEF-123 from 203.0.113.9'
      })
    })
    await expect(
      ctl.up({ loginServer: 'https://a.example', hostname: 'cw-000000' })
    ).rejects.toThrow(/invalid key: --auth-key=\[скрыто\] from x\.x\.x\.x/)
  })

  it('LAN addresses', () => {
    expect(isLanIp('100.64.0.1')).toBe(true)
    expect(isLanIp('100.127.255.254')).toBe(true)
    expect(isLanIp('100.128.0.1')).toBe(false)
    expect(isLanIp('100.63.0.1')).toBe(false)
    expect(isLanIp('fd7a:115c:a1e0::5')).toBe(true)
  })
})

describe('status / ping output', () => {
  const STATUS = JSON.stringify({
    BackendState: 'Running',
    TailscaleIPs: ['100.64.0.2', 'fd7a:115c:a1e0::2'],
    Self: { HostName: 'cw-0a1b2c', TailscaleIPs: ['100.64.0.2'] },
    Health: ['some warning'],
    Peer: {
      'nodekey:aa': {
        HostName: 'cw-ffffff',
        TailscaleIPs: ['100.64.0.3', 'fd7a:115c:a1e0::3'],
        Online: true,
        CurAddr: '203.0.113.9:41642',
        Relay: 'cw'
      },
      'nodekey:bb': {
        HostName: 'cw-eeeeee',
        TailscaleIPs: ['100.64.0.4'],
        Online: true,
        CurAddr: '',
        Relay: 'cw'
      },
      'nodekey:cc': { HostName: 'x', TailscaleIPs: ['100.64.0.5'], Online: false }
    }
  })

  it('status: self, peers, direct vs relay', () => {
    const s = parseStatus(STATUS)
    expect(s.backendState).toBe('Running')
    expect(s.selfIp).toBe('100.64.0.2')
    expect(s.selfName).toBe('cw-0a1b2c')
    expect(s.health).toEqual(['some warning'])
    expect(s.peers).toEqual([
      { ip: '100.64.0.3', name: 'cw-ffffff', online: true, direct: true, relay: 'cw' },
      { ip: '100.64.0.4', name: 'cw-eeeeee', online: true, direct: false, relay: 'cw' },
      { ip: '100.64.0.5', name: 'x', online: false, direct: false, relay: null }
    ])
    expect(parseStatus('{"BackendState":"NeedsLogin"}')).toMatchObject({
      backendState: 'NeedsLogin',
      selfIp: null,
      peers: []
    })
    expect(() => parseStatus('nope')).toThrow()
  })

  it('every address of the node and its peers is listed and checked against the LAN ranges', () => {
    const s = parseStatus(STATUS)
    expect(s.allIps).toEqual([
      '100.64.0.2',
      'fd7a:115c:a1e0::2',
      '100.64.0.2',
      '100.64.0.3',
      'fd7a:115c:a1e0::3',
      '100.64.0.4',
      '100.64.0.5'
    ])
    expect(foreignIps(s)).toEqual([])
    expect(
      foreignIps({ allIps: ['100.64.0.2', '192.168.1.7', '100.128.0.1', '2001:db8::1'] })
    ).toEqual(['192.168.1.7', '100.128.0.1', '2001:db8::1'])
  })

  it('self-update off: `set --auto-update=false` (up has no such flag in 1.104.7)', () => {
    expect([...NO_AUTO_UPDATE_ARGS]).toEqual(['set', '--auto-update=false'])
  })

  it('access errors of the daemon', () => {
    expect(isAccessError('Tailscale is in use by another user')).toBe(true)
    expect(isAccessError('not allowed to change preferences')).toBe(true)
    expect(isAccessError('connection refused')).toBe(false)
  })

  it('ping: direct / DERP / peer relay, ms and s', () => {
    expect(parsePing('pong from cw-ffffff (100.64.0.3) via 203.0.113.9:41642 in 23ms\n')).toEqual({
      latencyMs: 23,
      path: 'direct'
    })
    expect(parsePing('pong from cw-ffffff (100.64.0.3) via DERP(cw) in 1.2s')).toEqual({
      latencyMs: 1200,
      path: 'relay'
    })
    expect(
      parsePing('pong from a (100.64.0.3) via peer-relay(1.2.3.4:7:vni:1) in 40ms')?.path
    ).toBe('relay')
    expect(parsePing('pong from a (100.64.0.3) via 192.168.1.5:41642 in 0s')).toEqual({
      latencyMs: 1,
      path: 'direct'
    })
    expect(parsePing('timeout waiting for ping reply')).toBeNull()
  })
})

describe('redaction of the LAN log', () => {
  it('keys never reach «Логи»', () => {
    expect(redactLan('authkey tskey-auth-kAbc123-XYZ used')).toBe('authkey [скрыто] used')
    expect(redactLan('key hskey-auth-01234567_ABCD-efgh')).toBe('key [скрыто]')
    expect(redactLan('auth_key: "abcd1234"')).toBe('auth_key: "[скрыто]"')
    expect(redactLan(`k=${'0a'.repeat(24)}`)).toBe('k=[скрыто]')
    expect(redactLan('privkey:0123abcd')).toBe('[скрыто]')
    // the file: form is a path, kept
    expect(redactLan('--auth-key=file:C:\\run\\lan-key.txt')).toBe(
      '--auth-key=file:C:\\run\\lan-key.txt'
    )
  })

  it('public addresses hidden, LAN / private ones kept', () => {
    expect(
      redactLan(
        'endpoints: 203.0.113.9:41642 192.168.1.5:41642 100.64.0.3 10.0.0.1 [2a00:1450::1]:41642'
      )
    ).toBe('endpoints: x.x.x.x:41642 192.168.1.5:41642 100.64.0.3 10.0.0.1 [ipv6]:41642')
    expect(redactLan('fd7a:115c:a1e0::3 ok')).toBe('fd7a:115c:a1e0::3 ok')
  })

  it('log lines: timestamp dropped, chatter only with «Подробный журнал», errors as warnings', () => {
    const lines = [
      '2026/11/18 20:31:05 netcheck: report: udp=true v4=true',
      '2026/11/18 20:31:05.123 Switching ipn state Starting -> Running (WantRunning=true)',
      '2026/11/18 20:31:06 control: login failed: 403 --auth-key=tskey-x1'
    ]
    const quiet = lanLogEntries(lines, false, 1)
    expect(quiet.map((e) => [e.level, e.source, e.message])).toEqual([
      ['info', 'lan', 'Switching ipn state Starting -> Running (WantRunning=true)'],
      ['warn', 'lan', 'control: login failed: 403 --auth-key=[скрыто]']
    ])
    expect(lanLogEntries(lines, true, 1)).toHaveLength(3)
  })
})
