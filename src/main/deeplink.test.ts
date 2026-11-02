import { describe, expect, it } from 'vitest'
import { findDeepLinkArg, parseDeepLink } from './deeplink'

const SUB = 'https://sub.example.com/api/sub/AbCdEf123?x=1&y=2'
const enc = encodeURIComponent(SUB)

describe('parseDeepLink', () => {
  it('accepts cipherway://import?url=<https>', () => {
    expect(parseDeepLink(`cipherway://import?url=${enc}`)).toEqual({
      url: SUB,
      host: 'sub.example.com'
    })
  })

  it('accepts the Clash/Koala-style install-config alias and trailing slash', () => {
    expect(parseDeepLink(`cipherway://install-config?url=${enc}`)?.url).toBe(SUB)
    expect(parseDeepLink(`cipherway://import/?url=${enc}`)?.url).toBe(SUB)
    expect(parseDeepLink(`CIPHERWAY://IMPORT?url=${enc}`)?.url).toBe(SUB)
  })

  it('handles a double-encoded url parameter', () => {
    expect(parseDeepLink(`cipherway://import?url=${encodeURIComponent(enc)}`)?.url).toBe(SUB)
  })

  it('rejects non-https subscriptions', () => {
    expect(
      parseDeepLink(`cipherway://import?url=${encodeURIComponent('http://sub.example.com/x')}`)
    ).toBeNull()
    expect(parseDeepLink(`cipherway://import?url=${encodeURIComponent('file:///C:/x')}`)).toBeNull()
    expect(
      parseDeepLink(`cipherway://import?url=${encodeURIComponent('javascript:alert(1)')}`)
    ).toBeNull()
  })

  it('rejects credentials, unknown actions, other schemes and junk', () => {
    expect(
      parseDeepLink(`cipherway://import?url=${encodeURIComponent('https://u:p@sub.example.com/x')}`)
    ).toBeNull()
    expect(parseDeepLink(`cipherway://connect?url=${enc}`)).toBeNull()
    expect(parseDeepLink(`cipherway://import/extra?url=${enc}`)).toBeNull()
    expect(parseDeepLink(`clash://install-config?url=${enc}`)).toBeNull()
    expect(parseDeepLink('cipherway://import')).toBeNull()
    expect(parseDeepLink('cipherway://import?url=')).toBeNull()
    expect(parseDeepLink('not a url')).toBeNull()
    expect(parseDeepLink(undefined)).toBeNull()
    expect(parseDeepLink(`cipherway://import?url=${'a'.repeat(5000)}`)).toBeNull()
  })
})

describe('findDeepLinkArg', () => {
  it('finds the link in a second-instance argv', () => {
    const argv = [
      'C:\\Program Files\\CipherWay VPN\\CipherWay VPN.exe',
      '--allow-file-access-from-files',
      `cipherway://import?url=${enc}`
    ]
    expect(findDeepLinkArg(argv)).toBe(`cipherway://import?url=${enc}`)
    expect(findDeepLinkArg(['app.exe', '--flag'])).toBeNull()
  })
})
