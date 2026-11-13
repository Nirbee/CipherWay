import { describe, expect, it } from 'vitest'
import type { OutboundConfig } from '@shared/types'
import {
  connectionRule,
  describeRule,
  DirectFailures,
  exeOf,
  inCidr4,
  isTelegramIp,
  toConnItems,
  type RawConnection
} from './connections'

const outbounds: OutboundConfig[] = [
  { id: 'ob_fi', name: 'Финляндия', protocol: 'vless', server: 'fi.example.com', port: 443 },
  { id: 'ob_de', name: 'Германия', protocol: 'hysteria2', server: '203.0.113.10', port: 8443 }
]

// shape as returned by sing-box 1.13 Clash API /connections
function conn(
  p: Partial<RawConnection> & { host?: string; path?: string; ip?: string }
): RawConnection {
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
          conn({
            id: 'x',
            ip: '203.0.113.10',
            path: 'C:\\CipherWay\\resources\\bin\\cipherway-xray.exe'
          }),
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
      {
        connections: [
          conn({ host: 'x.org', rule: 'domain_suffix=[x.org] => route(ob_de)', chains: ['ob_de'] })
        ]
      },
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
    expect(describeRule('final')).toBe('Всё остальное')
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

describe('rule slots (0.4.2)', () => {
  const now = Date.parse('2026-11-05T00:00:10Z')
  const labels = { 'cw-0-p': 'программа discord.exe и ещё 2', 'cw-1-d': 'geoip:ru' }

  it('a slot rule shows what the user wrote, never the slot tag', () => {
    expect(describeRule('rule_set=cw-0-p => route(cw-0)', labels)).toBe(
      'программа discord.exe и ещё 2'
    )
    expect(describeRule('rule_set=[cw-1-d] => route(direct)', labels)).toBe('geoip:ru')
    expect(describeRule('rule_set=cw-7-x => reject', labels)).toBe('Правило')
  })

  it('the «Всё остальное» selector is not a server; direct via cw-final is direct', () => {
    const [a, b] = toConnItems(
      {
        connections: [
          conn({ id: 'a', host: 'x.org', chains: ['direct', 'cw-final'], rule: 'final' }),
          conn({
            id: 'b',
            host: 'y.org',
            chains: ['ob_fi', 'auto', 'proxy', 'cw-0'],
            rule: 'rule_set=cw-0-p => route(cw-0)'
          })
        ]
      },
      { outbounds, prev: new Map(), now, labels }
    )
    expect(a).toMatchObject({ route: 'direct', rule: 'Всё остальное' })
    expect(b).toMatchObject({
      route: 'proxy',
      serverName: 'Финляндия',
      rule: 'программа discord.exe и ещё 2'
    })
  })

  it('«Правила» mode tail rule (clash_mode=Rule → cw-final) is «Всё остальное», not a mode', () => {
    expect(describeRule('clash_mode=Rule => route(cw-final)')).toBe('Всё остальное')
    expect(describeRule('clash_mode=Global => route(proxy)')).toBe('Режим «Весь трафик через VPN»')
  })

  it('a run of programs: the connection names the program that matched (0.4.5)', () => {
    const programs = { 'cw-0-p': ['lyrebird.exe', 'Discord.exe', 'chrome.exe'] }
    const lbl = { 'cw-0-p': 'программа lyrebird.exe и ещё 2' }
    const rule = 'rule_set=cw-0-p => route(cw-0)'
    expect(connectionRule(rule, 'chrome.exe', lbl, programs)).toBe('программа chrome.exe')
    expect(connectionRule(rule, 'discord.exe', lbl, programs)).toBe('программа Discord.exe')
    // matched by another rule of the run (or no process known): the run label
    expect(connectionRule(rule, 'curl.exe', lbl, programs)).toBe('программа lyrebird.exe и ещё 2')
    expect(connectionRule(rule, undefined, lbl, programs)).toBe('программа lyrebird.exe и ещё 2')
    // a mode / final rule is never renamed after the program
    expect(connectionRule('final', 'chrome.exe', lbl, programs)).toBe('Всё остальное')
    const [item] = toConnItems(
      {
        connections: [
          conn({
            id: 'y',
            host: 'yoomoney.ru',
            path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            chains: ['ob_de', 'proxy', 'cw-0'],
            rule
          })
        ]
      },
      { outbounds, prev: new Map(), now, labels: lbl, programs }
    )
    expect(item).toMatchObject({ rule: 'программа chrome.exe', serverName: 'Германия' })
  })

  it('a direct connection with nothing received for a few seconds is «stalled»', () => {
    const items = toConnItems(
      {
        connections: [
          {
            ...conn({ id: 's', ip: '149.154.167.41', chains: ['direct'], download: 0 }),
            start: '2026-11-05T00:00:00Z'
          },
          {
            ...conn({ id: 'f', ip: '149.154.167.42', chains: ['direct'], download: 0 }),
            start: '2026-11-05T00:00:09Z'
          },
          {
            ...conn({ id: 'v', ip: '149.154.167.43', chains: ['ob_fi'], download: 0 }),
            start: '2026-11-05T00:00:00Z'
          }
        ]
      },
      { outbounds, prev: new Map(), now }
    )
    expect(items.map((i) => [i.id, !!i.stalled])).toEqual([
      ['s', true],
      ['f', false],
      ['v', false]
    ])
  })
})

describe('DirectFailures («не удалось подключиться напрямую»)', () => {
  const line = (ip: string, port = 443) =>
    `+0300 2026-11-05 01:40:21 ERROR [2798233218 5.0s] connection: open connection to ${ip}:${port} using outbound/direct[direct]: dial tcp ${ip}:${port}: i/o timeout`

  it('collects direct dial timeouts from the sing-box log, Telegram IPs flagged', () => {
    const f = new DirectFailures()
    f.noteLog(line('91.105.192.100'), 1000)
    f.noteLog(line('91.105.192.100'), 2000)
    f.noteLog(line('194.221.250.50', 80), 1500)
    f.noteLog(
      'ERROR connection: open connection to 1.2.3.4:443 using outbound/socks[ob_fi]: i/o timeout',
      1600
    )
    f.noteLog('ERROR connection: connection upload closed: raw-read tcp4 …', 1700)
    const list = f.list(new Set(), 3000)
    expect(list).toEqual([
      { host: '91.105.192.100', port: '443', count: 2, last: 2000, telegram: true },
      { host: '194.221.250.50', port: '80', count: 1, last: 1500 }
    ])
  })

  it('names the program from a live connection seen while it was dialing; hides node addresses', () => {
    const f = new DirectFailures()
    f.noteConnections(
      toConnItems(
        {
          connections: [
            conn({ ip: '149.154.167.41', path: 'C:\\T\\Telegram.exe', chains: ['direct'] })
          ]
        },
        { outbounds, prev: new Map(), now: 0 }
      ),
      0
    )
    f.noteLog(line('149.154.167.41'), 10)
    f.noteLog(line('203.0.113.10'), 11)
    expect(f.list(new Set(['203.0.113.10']), 20)).toEqual([
      {
        host: '149.154.167.41',
        port: '443',
        count: 1,
        last: 10,
        telegram: true,
        process: 'Telegram.exe'
      }
    ])
  })

  it('CIDR helpers', () => {
    expect(inCidr4('149.154.175.100', '149.154.160.0/20')).toBe(true)
    expect(inCidr4('149.154.176.1', '149.154.160.0/20')).toBe(false)
    expect(isTelegramIp('91.108.56.142')).toBe(true)
    expect(isTelegramIp('194.221.250.50')).toBe(false)
    expect(isTelegramIp('example.com')).toBe(false)
  })
})
