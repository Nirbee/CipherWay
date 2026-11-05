import { describe, expect, it } from 'vitest'
import { findOtherVpnClients, parseTasklist } from './processes'

describe('other VPN clients', () => {
  it('recognised by the exe name, any case; each once', () => {
    expect(
      findOtherVpnClients([
        'explorer.exe',
        'Happ.exe',
        'HAPP.EXE',
        'Koala Clash.exe',
        'koala-clash.exe',
        'FlClash.exe',
        'FlClashHelperService.exe',
        'v2rayN.exe'
      ])
    ).toEqual(['Happ', 'Koala Clash', 'FlClash', 'v2rayN'])
  })

  it('our own processes and look-alikes do not count', () => {
    expect(
      findOtherVpnClients([
        'CipherWay VPN.exe',
        'cipherway-core.exe',
        'cipherway-xray.exe',
        'happd.exe',
        'unhapp.exe',
        'sing-box.exe'
      ])
    ).toEqual([])
  })
})

describe('parseTasklist', () => {
  it('takes the first column of `tasklist /fo csv /nh`', () => {
    const csv = [
      '"System Idle Process","0","Services","0","8 КБ"',
      '"Koala Clash.exe","12912","Console","1","64 068 КБ"',
      '',
      'INFO: nothing'
    ].join('\r\n')
    expect(parseTasklist(csv)).toEqual(['System Idle Process', 'Koala Clash.exe'])
  })
})
