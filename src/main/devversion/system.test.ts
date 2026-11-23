import { describe, expect, it } from 'vitest'
import { devAcceptSchema, devProcessSchema } from './consent'
import { findNetTools, parseWinVersion, teredoState } from './system'
import { gameTargets } from './targets'
import { ConnAggregator } from './aggregate'
import { canEnableDev, DEV_CONSENT, DEV_CONSENT_VERSION } from '@shared/devversion'

describe('DevVersion system section', () => {
  it('reads EditionID / DisplayVersion / build.UBR from reg query', () => {
    const out = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion
    CurrentBuild    REG_SZ    19045
    DisplayVersion    REG_SZ    22H2
    EditionID    REG_SZ    Professional
    UBR    REG_DWORD    0x1408
`
    expect(parseWinVersion(out)).toEqual({
      edition: 'Professional',
      display: '22H2',
      build: '19045.5128'
    })
    expect(parseWinVersion('')).toEqual({ edition: '', display: '', build: '' })
  })

  it('Teredo from the adapters', () => {
    expect(
      teredoState({
        'Teredo Tunneling Pseudo-Interface': [{ address: '2001:0:2851:782c::1', family: 'IPv6' }]
      })
    ).toBe('active')
    expect(
      teredoState({ 'Teredo Tunneling Pseudo-Interface': [{ address: 'fe80::1', family: 'IPv6' }] })
    ).toBe('present')
    expect(teredoState({ Ethernet: [{ address: '192.168.1.5', family: 'IPv4' }] })).toBe('none')
  })

  it('other VPN / proxy / DPI tools among the processes', () => {
    expect(
      findNetTools(['explorer.exe', 'Happ.exe', 'winws.exe', 'GoodbyeDPI.exe', 'happ.exe'])
    ).toEqual(['GoodbyeDPI', 'Happ', 'zapret'])
  })
})

describe('DevVersion consent', () => {
  it('«Включить» only with the box ticked and the current text', () => {
    expect(canEnableDev(false)).toBe(false)
    expect(canEnableDev(true)).toBe(true)
    expect(canEnableDev(true, '0')).toBe(false)
  })

  it('main refuses anything but {accepted: true, consentVersion: current}', () => {
    expect(
      devAcceptSchema.safeParse({ accepted: true, consentVersion: DEV_CONSENT_VERSION }).success
    ).toBe(true)
    expect(
      devAcceptSchema.safeParse({ accepted: false, consentVersion: DEV_CONSENT_VERSION }).success
    ).toBe(false)
    expect(devAcceptSchema.safeParse({ consentVersion: DEV_CONSENT_VERSION }).success).toBe(false)
    expect(devAcceptSchema.safeParse({ accepted: true, consentVersion: '0' }).success).toBe(false)
    expect(devAcceptSchema.safeParse(true).success).toBe(false)
    expect(
      devAcceptSchema.safeParse({ accepted: true, consentVersion: DEV_CONSENT_VERSION, extra: 1 })
        .success
    ).toBe(false)
  })

  it('the text is the one from the plan (key phrases)', () => {
    expect(DEV_CONSENT_VERSION).toBe('1')
    expect(DEV_CONSENT.items).toHaveLength(5)
    const all = [DEV_CONSENT.intro, ...DEV_CONSENT.items, ...DEV_CONSENT.after].join(' ')
    expect(all).toContain(
      'не дольше 90 дней, не продаются и не передаются третьим лицам для их собственных целей'
    )
    expect(all).toContain('в том числе ИИ-ассистентов')
    expect(all).toContain('сам IP-адрес не сохраняется')
    expect(all).toContain('Сбор сразу прекращается, данные на компьютере удаляются')
  })

  it('«Тест игры» takes a bare exe name only', () => {
    expect(devProcessSchema.safeParse('RainbowSix.exe').success).toBe(true)
    expect(devProcessSchema.safeParse('C:\\x\\a.exe').success).toBe(false)
    expect(devProcessSchema.safeParse('').success).toBe(false)
  })
})

describe('DevVersion targets from games', () => {
  it('the TCP domains games used most join the checks', () => {
    const a = new ConnAggregator()
    const c = (
      id: string,
      exe: string,
      host: string,
      net: 'tcp' | 'udp',
      port: number,
      b: number
    ) => ({
      id,
      metadata: {
        network: net,
        destinationIP: '1.2.3.4',
        destinationPort: String(port),
        host,
        processPath: `C:\\G\\${exe}`
      },
      upload: b,
      download: b,
      chains: ['direct']
    })
    a.ingest(
      {
        connections: [
          c('1', 'RainbowSix.exe', 'public-ubiservices.ubi.com', 'tcp', 443, 5000),
          c('2', 'RainbowSix.exe', 'dedicated.example', 'udp', 6015, 900_000),
          c('3', 'chrome.exe', 'news.example.com', 'tcp', 443, 9_000_000),
          c('4', 'RainbowSix.exe', 'ubi.com', 'tcp', 443, 100)
        ]
      },
      [],
      new Set(),
      1000
    )
    const t = gameTargets(a.procs.values(), new Set(['ubi.com']))
    expect(t.map((x) => x.host)).toEqual(['public-ubiservices.ubi.com'])
    expect(t[0]).toMatchObject({ target: 'game', port: 443, tls: true })
  })
})
