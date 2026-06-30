import { describe, expect, it } from 'vitest'
import {
  decodeBase64,
  parseHysteria2,
  parseOutbounds,
  parseUri,
  parseVless,
  parseVmess
} from './parsers'

describe('decodeBase64', () => {
  it('decodes standard base64', () => {
    expect(decodeBase64('aGVsbG8=')).toBe('hello')
  })
  it('decodes url-safe base64 without padding', () => {
    const b64 = Buffer.from('a+b/c').toString('base64url')
    expect(decodeBase64(b64)).toBe('a+b/c')
  })
})

describe('parseVless (REALITY)', () => {
  const uri =
    'vless://550e8400-e29b-41d4-a716-446655440000@example.com:443' +
    '?security=reality&encryption=none&flow=xtls-rprx-vision' +
    '&pbk=PUBKEY123&sid=ab12&sni=www.microsoft.com&fp=chrome&type=tcp#My%20Node'

  it('parses core fields', () => {
    const o = parseVless(uri)!
    expect(o).not.toBeNull()
    expect(o.protocol).toBe('vless')
    expect(o.server).toBe('example.com')
    expect(o.port).toBe(443)
    expect(o.uuid).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(o.name).toBe('My Node')
  })

  it('parses REALITY params', () => {
    const o = parseVless(uri)!
    expect(o.security).toBe('reality')
    expect(o.publicKey).toBe('PUBKEY123')
    expect(o.shortId).toBe('ab12')
    expect(o.serverName).toBe('www.microsoft.com')
    expect(o.fingerprint).toBe('chrome')
    expect(o.flow).toBe('xtls-rprx-vision')
  })

  it('rejects non-vless uris', () => {
    expect(parseVless('hysteria2://x@y:1')).toBeNull()
  })

  it('produces a stable id across calls', () => {
    expect(parseVless(uri)!.id).toBe(parseVless(uri)!.id)
  })
})

describe('parseHysteria2', () => {
  it('parses password from userinfo + params', () => {
    const o = parseHysteria2('hysteria2://s3cret@vpn.example.com:8443?sni=example.com&obfs=salamander&obfs-password=foo&insecure=1#HY2')!
    expect(o.protocol).toBe('hysteria2')
    expect(o.server).toBe('vpn.example.com')
    expect(o.port).toBe(8443)
    expect(o.password).toBe('s3cret')
    expect(o.sni).toBe('example.com')
    expect(o.obfs).toBe('salamander')
    expect(o.obfsPassword).toBe('foo')
    expect(o.insecure).toBe(true)
    expect(o.name).toBe('HY2')
  })

  it('accepts the hy2:// alias', () => {
    expect(parseHysteria2('hy2://pw@h:443')!.protocol).toBe('hysteria2')
  })
})

describe('parseVmess', () => {
  it('parses base64 json', () => {
    const json = { ps: 'vm', add: 'a.com', port: '443', id: 'uuid-x', net: 'ws', path: '/p', tls: 'tls' }
    const uri = 'vmess://' + Buffer.from(JSON.stringify(json)).toString('base64')
    const o = parseVmess(uri)!
    expect(o.protocol).toBe('vmess')
    expect(o.server).toBe('a.com')
    expect(o.network).toBe('ws')
    expect(o.path).toBe('/p')
    expect(o.security).toBe('tls')
  })
})

describe('parseUri dispatch', () => {
  it('routes to the right parser', () => {
    expect(parseUri('vless://u@h:443')!.protocol).toBe('vless')
    expect(parseUri('hysteria2://p@h:443')!.protocol).toBe('hysteria2')
    expect(parseUri('garbage')).toBeNull()
  })
})

describe('parseOutbounds', () => {
  const links = [
    'vless://550e8400-e29b-41d4-a716-446655440000@a.com:443?security=reality&pbk=K#A',
    'hysteria2://pw@b.com:8443?sni=b.com#B'
  ].join('\n')

  it('parses a newline-separated plaintext list', () => {
    const out = parseOutbounds(links)
    expect(out).toHaveLength(2)
    expect(out[0].protocol).toBe('vless')
    expect(out[1].protocol).toBe('hysteria2')
  })

  it('parses a base64-encoded list', () => {
    const b64 = Buffer.from(links).toString('base64')
    const out = parseOutbounds(b64)
    expect(out).toHaveLength(2)
  })

  it('skips invalid lines', () => {
    const out = parseOutbounds(links + '\n\nnot-a-uri\n#comment')
    expect(out).toHaveLength(2)
  })
})
