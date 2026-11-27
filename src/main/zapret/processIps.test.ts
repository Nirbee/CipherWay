import { describe, expect, it } from 'vitest'
import type { RoutingRule } from '@shared/types'
import {
  excluded,
  excludeList,
  LEARN_MAX,
  processConnAddress,
  ProcessIpLearner,
  publicAddress,
  ruleMatchesProcess,
  SEND_BATCH_MS,
  SEND_GAP_MS,
  zapretPort,
  type ProcConnection
} from './processIps'

const rule = (id: string, conditionType: RoutingRule['conditionType'], value: string) => ({
  id,
  conditionType,
  value
})

const conn = (p: Partial<NonNullable<ProcConnection['metadata']>> = {}, extra: Partial<ProcConnection> = {}): ProcConnection => ({
  rule: 'rule_set=[cw-2-d] => route(cw-2)',
  chains: ['direct', 'cw-2'],
  metadata: {
    network: 'tcp',
    destinationIP: '8.8.4.4',
    destinationPort: '443',
    processPath: 'C:\\Games\\Game.exe',
    ...p
  },
  ...extra
})

describe('publicAddress', () => {
  it('canonical form: IPv6 compressed lower case, IPv4-mapped as IPv4', () => {
    expect(publicAddress('1.1.1.1')).toBe('1.1.1.1')
    expect(publicAddress('2A00:1450:4010:0:0:0:0:200E')).toBe('2a00:1450:4010::200e')
    expect(publicAddress('[2a00:1450:4010::200e]')).toBe('2a00:1450:4010::200e')
    expect(publicAddress('::ffff:8.8.8.8')).toBe('8.8.8.8')
    expect(publicAddress('::ffff:808:808')).toBe('8.8.8.8')
  })

  it('never private / local / multicast / reserved, never a range', () => {
    for (const x of [
      '10.1.2.3',
      '172.19.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.1.1',
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.251',
      '239.255.255.250',
      '255.255.255.255',
      '0.0.0.0',
      '::',
      '::1',
      'fe80::1',
      'fd00::1',
      'ff02::fb',
      '::ffff:192.168.1.1',
      '1.2.3.0/24',
      '0.0.0.0/0',
      '::/0',
      '01.2.3.4',
      'example.com',
      '',
      undefined
    ]) {
      expect(publicAddress(x), String(x)).toBeNull()
    }
  })
})

describe('zapretPort', () => {
  it('TCP 80 / 443 and QUIC (UDP 443) only', () => {
    expect(zapretPort('tcp', '443')).toBe(true)
    expect(zapretPort('tcp', '80')).toBe(true)
    expect(zapretPort('udp', '443')).toBe(true)
    expect(zapretPort('udp', '80')).toBe(false)
    expect(zapretPort('udp', '27015')).toBe(false)
    expect(zapretPort('tcp', '8443')).toBe(false)
  })
})

describe('processConnAddress', () => {
  const rules = [rule('a', 'ProcessName', 'game.exe'), rule('b', 'ProcessPath', 'd:\\apps\\tool.exe')]

  it('a direct connection of the program on 443: its address and the rule', () => {
    expect(processConnAddress(conn(), rules)).toEqual({ ip: '8.8.4.4', rule: 'a' })
    expect(
      processConnAddress(conn({ processPath: 'D:/Apps/Tool.exe', network: 'udp' }), rules)
    ).toEqual({ ip: '8.8.4.4', rule: 'b' })
  })

  it('another program, another port, a private address: nothing', () => {
    expect(processConnAddress(conn({ processPath: 'C:\\x\\other.exe' }), rules)).toBeNull()
    expect(processConnAddress(conn({ processPath: 'C:\\x\\game.exe.bak' }), rules)).toBeNull()
    expect(processConnAddress(conn({ destinationPort: '27015', network: 'udp' }), rules)).toBeNull()
    expect(processConnAddress(conn({ destinationIP: '192.168.0.10' }), rules)).toBeNull()
    expect(processConnAddress(conn({ destinationIP: '' }), rules)).toBeNull()
    expect(processConnAddress(conn({ processPath: undefined }), rules)).toBeNull()
  })

  it('not through a direct slot of the user rules / through the VPN: nothing', () => {
    expect(processConnAddress(conn({}, { rule: 'final' }), rules)).toBeNull()
    expect(processConnAddress(conn({}, { rule: 'rule_set=[cw-2-p] => route(cw-2)' }), rules)).toBeNull()
    expect(processConnAddress(conn({}, { chains: ['ob_1', 'proxy'] }), rules)).toBeNull()
  })

  it('a «программа» rule matches the file name in any case, a «путь» one the whole path', () => {
    expect(ruleMatchesProcess(rule('a', 'ProcessName', 'GAME.EXE'), 'c:\\games\\game.exe')).toBe(true)
    expect(ruleMatchesProcess(rule('b', 'ProcessPath', 'C:\\Games\\Game.exe'), 'c:/games//game.exe')).toBe(true)
    expect(ruleMatchesProcess(rule('b', 'ProcessPath', 'C:\\Games\\Game.exe'), 'D:\\Games\\Game.exe')).toBe(false)
    expect(ruleMatchesProcess(rule('c', 'Domain', 'game.exe'), 'C:\\game.exe')).toBe(false)
  })
})

describe('our servers', () => {
  it('an address of our VPN servers (IP or range) is left out', () => {
    const ours = excludeList(['8.8.4.4', '2a00:1450::/32', 'bad', '1.1.1.0/24'])
    expect(excluded(ours, '8.8.4.4')).toBe(true)
    expect(excluded(ours, '1.1.1.9')).toBe(true)
    expect(excluded(ours, '2a00:1450:4010::200e')).toBe(true)
    expect(excluded(ours, '9.9.9.9')).toBe(false)
  })
})

describe('ProcessIpLearner', () => {
  it('new addresses are due after a short batch; one seen again is not new', () => {
    const l = new ProcessIpLearner()
    expect(l.dueIn(0)).toBeNull()
    expect(l.note('1.1.1.1', 'a', 1000)).toBe(true)
    expect(l.note('1.1.1.1', 'a', 1500)).toBe(false)
    expect(l.dueIn(1000)).toBe(SEND_BATCH_MS)
    expect(l.dueIn(1000 + SEND_BATCH_MS)).toBe(0)
  })

  it('at most once per SEND_GAP_MS, and only when something new came', () => {
    const l = new ProcessIpLearner()
    l.note('1.1.1.1', 'a', 0)
    l.sent(5000)
    expect(l.dueIn(6000)).toBeNull()
    // the same address again: still nothing to send
    l.note('1.1.1.1', 'a', 7000)
    expect(l.dueIn(7000)).toBeNull()
    l.note('9.9.9.9', 'a', 10_000)
    expect(l.dueIn(10_000)).toBe(5000 + SEND_GAP_MS - 10_000)
    expect(l.dueIn(5000 + SEND_GAP_MS)).toBe(0)
  })

  it('a limit: the least recently seen go first, newest first in the list', () => {
    const l = new ProcessIpLearner(3)
    l.note('1.0.0.1', 'a', 0)
    l.note('1.0.0.2', 'a', 1)
    l.note('1.0.0.3', 'a', 2)
    l.note('1.0.0.1', 'a', 3) // seen again: the newest now
    l.note('1.0.0.4', 'a', 4)
    expect(l.addresses()).toEqual(['1.0.0.4', '1.0.0.1', '1.0.0.3'])
    expect(l.size).toBe(3)
  })

  it('the default limit is the broker’s (512)', () => {
    const l = new ProcessIpLearner()
    for (let i = 0; i < 600; i++) l.note(`2.0.${i >> 8}.${i & 255}`, 'a', i)
    expect(l.size).toBe(LEARN_MAX)
    expect(LEARN_MAX).toBe(512)
    expect(l.addresses()[0]).toBe('2.0.2.87')
  })

  it('a rule gone: its addresses leave and a new list is due', () => {
    const l = new ProcessIpLearner()
    l.note('1.1.1.1', 'a', 0)
    l.note('2.2.2.2', 'b', 0)
    l.sent(1000)
    expect(l.keepRules(new Set(['a']), 2000)).toBe(true)
    expect(l.addresses()).toEqual(['1.1.1.1'])
    expect(l.dueIn(2000)).not.toBeNull()
    expect(l.keepRules(new Set(['a']), 3000)).toBe(false)
  })

  it('clear: a new session', () => {
    const l = new ProcessIpLearner()
    l.note('1.1.1.1', 'a', 0)
    l.sent(10)
    l.clear()
    expect(l.size).toBe(0)
    l.note('1.1.1.1', 'a', 20)
    expect(l.dueIn(20)).toBe(SEND_BATCH_MS)
  })
})
