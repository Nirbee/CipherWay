import { describe, expect, it } from 'vitest'
import type { OutboundConfig } from '@shared/types'
import { createMasker, maskUrl, maskValue } from './mask'

// made-up nodes (example.com / TEST-NET addresses), nothing real
const outbounds: OutboundConfig[] = [
  {
    id: 'ob_nl',
    name: 'Нидерланды',
    protocol: 'vless',
    server: 'nl.example.com',
    port: 443,
    uuid: '11111111-2222-4333-8444-555555555555'
  },
  { id: 'ob_de', name: 'Германия', protocol: 'vless', server: '203.0.113.10', port: 8443 },
  {
    id: 'ob_hy',
    name: 'Финляндия HY2',
    protocol: 'hysteria2',
    server: 'hy.example.com',
    port: 8443,
    password: 's3cr3t-pass'
  }
]
const SUB = 'https://sub.example.com/api/sub/AbCdEfGh123456'
const mask = createMasker({ outbounds, subscriptionUrl: SUB })

describe('maskValue / maskUrl', () => {
  it('keeps the first characters only', () => {
    expect(maskValue('nl.example.com')).toBe('nl.***')
    expect(maskUrl(SUB)).toBe('https://sub***')
    expect(maskUrl('sub.example.com/x')).toBe('sub***')
  })
})

describe('createMasker', () => {
  it('hides node domains and IPs together with the port', () => {
    const out = mask('dial tcp nl.example.com:443: i/o timeout; via 203.0.113.10:8443 ok')
    expect(out).toBe('dial tcp nl.***: i/o timeout; via 203*** ok')
    expect(out).not.toMatch(/example\.com|113\.10|:443|8443/)
  })

  it('does not touch look-alike addresses and user sites', () => {
    expect(mask('connect 203.0.113.100:443 and www.google.com:443')).toBe(
      'connect 203.0.113.100:443 and www.google.com:443'
    )
    expect(mask('sub-nl.example.com.evil.org')).toBe('sub-nl.example.com.evil.org')
  })

  it('hides the subscription link, also its token on its own', () => {
    expect(mask(`fetch ${SUB} failed`)).toBe('fetch https://sub*** failed')
    expect(mask('token AbCdEfGh123456 rejected')).toBe('token Ab*** rejected')
  })

  it('hides UUIDs and passwords', () => {
    const out = mask('user 11111111-2222-4333-8444-555555555555 auth s3cr3t-pass')
    expect(out).toBe('user 1111*** auth s3***')
    expect(mask('id 99999999-aaaa-4bbb-8ccc-dddddddddddd')).toBe('id 9999***')
  })

  it('replaces outbound tags with server names', () => {
    expect(mask('outbound/socks[ob_nl]: connection established')).toBe(
      'outbound/socks[«Нидерланды»]: connection established'
    )
  })

  it('works without a subscription', () => {
    const empty = createMasker({ outbounds: [] })
    expect(empty('plain text 1.2.3.4')).toBe('plain text 1.2.3.4')
    expect(empty('')).toBe('')
  })
})
