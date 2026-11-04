import { describe, expect, it } from 'vitest'
import type { OutboundConfig } from '@shared/types'
import { describeRule, exeOf, toConnItems, type RawConnection } from './connections'

const outbounds: OutboundConfig[] = [
  { id: 'ob_fi', name: 'Финляндия', protocol: 'vless', server: 'fi.example.com', port: 443 },
  { id: 'ob_de', name: 'Германия', protocol: 'hysteria2', server: '203.0.113.10', port: 8443 }
]

// shape as returned by sing-box 1.13 Clash API /connections
function conn(p: Partial<RawConnection> & { host?: string; path?: string; ip?: string }): RawConnection {
  return {
    id: p.id ?? 'c1',
    metadata: {
      network: 'tcp',
      type: 'tun/tun-in',
      sourceIP: '172.19.0.1',
      sourcePort: '50000',
      destinationIP: p.ip ?? '',
      destinationPort: '443',
      host: p.host ?? '',
      processPath: p.path
    },
    upload: p.upload ?? 100,
    download: p.download ?? 1000,
    start: '2026-11-04T20:57:28.2185761+03:00',
    chains: p.chains ?? ['ob_fi', 'proxy'],
    rule: p.rule ?? 'final'
  }
}

describe('toConnItems', () => {
  const now = Date.parse('2026-11-04T18:00:00Z')

  it('maps the chain to a server name and the process to its exe', () => {
    const [item] = toConnItems(
      {
        connections: [
          conn({
            host: 'www.youtube.com',
            path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe',
            chains: ['ob_fi', 'auto', 'proxy'],
            rule: 'clash_mode=Global => route(proxy)'
          })
        ]
      },
      { outbounds, prev: new Map(), now }
    )
    expect(item).toMatchObject({
      process: 'chrome.exe',
      host: 'www.youtube.com',
      port: '443',
      route: 'proxy',
      serverName: 'Финляндия',
      rule: 'Режим «Весь трафик через VPN»'
    })
    expect(item.start).toBe(Date.parse('2026-11-04T20:57:28.218+03:00'))
  })

  it('direct connections have no server', () => {
    const [item] = toConnItems(
      {
        connections: [
          conn({ host: 'ya.ru', chains: ['direct'], rule: 'rule_set=[geoip-ru] => route(direct)' })
        ]
      },
      { outbounds, prev: new Map(), now }
    )
    expect(item.route).toBe('direct')
    expect(item.serverName).toBeUndefined()
    expect(item.rule).toBe('набор geoip:ru')
  })

  it('drops our own cores and anything aimed at a node address', () => {
    const items = toConnItems(
      {
        connections: [
          conn({ id: 'x', ip: '203.0.113.10', path: 'C:\\CipherWay\\resources\\bin\\xray.exe' }),
          conn({ id: 'y', host: 'fi.example.com', path: 'C:\\x\\curl.exe' }),
          conn({ id: 'z', ip: '203.0.113.10', path: 'C:\\x\\curl.exe' }),
          conn({ id: 'ok', host: 'example.org' })
        ]
      },
      { outbounds, prev: new Map(), now }
    )
    expect(items.map((i) => i.id)).toEqual(['ok'])
  })

  it('never leaks node ids or addresses into the rule text', () => {
    const [item] = toConnItems(
      { connections: [conn({ host: 'x.org', rule: 'domain_suffix=[x.org] => route(ob_de)', chains: ['ob_de'] })] },
      { outbounds, prev: new Map(), now }
    )
    expect(item.rule).toBe('домен x.org')
    expect(JSON.stringify(item)).not.toMatch(/ob_de|203\.0\.113/)
    expect(item.serverName).toBe('Германия')
  })

  it('computes per-connection speed from the previous snapshot', () => {
    const prev = new Map([['c1', { upload: 0, download: 0, ts: now - 2000 }]])
    const [item] = toConnItems(
      { connections: [conn({ host: 'a.org', upload: 200, download: 4000 })] },
      { outbounds, prev, now }
    )
    expect(item.uploadSpeed).toBe(100)
    expect(item.downloadSpeed).toBe(2000)
  })

  it('falls back to the destination IP and handles an empty list', () => {
    const [item] = toConnItems(
      { connections: [conn({ ip: '198.51.100.7' })] },
      { outbounds, prev: new Map(), now }
    )
    expect(item.host).toBe('198.51.100.7')
    expect(item.process).toBeUndefined()
    expect(toConnItems({ connections: null }, { outbounds, prev: new Map(), now })).toEqual([])
  })
})

describe('describeRule / exeOf', () => {
  it('humanises sing-box rule strings', () => {
    expect(describeRule('final')).toBe('По умолчанию')
    expect(describeRule('clash_mode=Direct => route(direct)')).toBe('Режим «Напрямую»')
    expect(describeRule('ip_is_private=true => route(direct)')).toBe('Локальная сеть')
    expect(describeRule('process_name=[telegram.exe] => route(proxy)')).toBe('процесс telegram.exe')
    expect(describeRule('rule_set=[geosite-youtube] => route(proxy)')).toBe('набор geosite:youtube')
    expect(describeRule('port_range=[6881:6889] => route(direct)')).toBe('порт 6881:6889')
  })

  it('takes the file name from Windows and POSIX paths', () => {
    expect(exeOf('C:\\a\\b\\Telegram.exe')).toBe('Telegram.exe')
    expect(exeOf('/usr/bin/curl')).toBe('curl')
    expect(exeOf(undefined)).toBeUndefined()
  })
})
