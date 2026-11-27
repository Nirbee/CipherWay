import { createSocket } from 'node:dgram'
import { describe, expect, it } from 'vitest'
import {
  buildInitial,
  hkdfExpandLabel,
  hkdfExtract,
  initialKeys,
  isServerReply,
  probeQuic,
  protectPacket,
  varint
} from './quic'
import { A2_CRYPTO_FRAME, A2_PROTECTED, A3_PAYLOAD, A3_PROTECTED } from './quic.vectors'

// RFC 9001 Appendix A: DCID 0x8394c8f03e515708
const DCID = Buffer.from('8394c8f03e515708', 'hex')
const hex = (b: Buffer): string => b.toString('hex')

describe('QUIC Initial keys (RFC 9001 A.1)', () => {
  it('initial secret, client and server keys', () => {
    const initial = hkdfExtract(
      Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex'),
      DCID
    )
    expect(hex(initial)).toBe('7db5df06e7a69e432496adedb00851923595221596ae2ae9fb8115c1e9ed0a44')
    const c = initialKeys(DCID, 'client')
    expect(hex(c.secret)).toBe('c00cf151ca5be075ed0ebfb5c80323c42d6b7db67881289af4008f1f6c357aea')
    expect(hex(c.key)).toBe('1f369613dd76d5467730efcbe3b1a22d')
    expect(hex(c.iv)).toBe('fa044b2f42a3fd3b46fb255c')
    expect(hex(c.hp)).toBe('9f50449e04a0e810283a1e9933adedd2')
    const s = initialKeys(DCID, 'server')
    expect(hex(s.secret)).toBe('3c199828fd139efd216c155ad844cc81fb82fa8d7446fa7d78be803acdda951b')
    expect(hex(s.key)).toBe('cf3a5331653c364c88f0f379b6067e37')
    expect(hex(s.iv)).toBe('0ac1493ca1905853b0bba03e')
    expect(hex(s.hp)).toBe('c206b8d9b9f0f37644430b490eeaa314')
    expect(hex(hkdfExpandLabel(c.secret, 'quic iv', 12))).toBe('fa044b2f42a3fd3b46fb255c')
  })

  it('varints (RFC 9000 §16)', () => {
    expect(hex(varint(37))).toBe('25')
    expect(hex(varint(15293))).toBe('7bbd')
    expect(hex(varint(494878333))).toBe('9d7f3e7d')
  })
})

describe('packet protection (RFC 9001 A.2 / A.3)', () => {
  it('the client Initial: the very bytes of the RFC', () => {
    const header = Buffer.from('c300000001088394c8f03e5157080000449e00000002', 'hex')
    const frames = Buffer.from(A2_CRYPTO_FRAME, 'hex')
    const payload = Buffer.concat([frames, Buffer.alloc(1162 - frames.length)])
    const out = protectPacket(header, 4, 2, payload, initialKeys(DCID, 'client'))
    expect(out.length).toBe(1200)
    expect(hex(out.subarray(0, 22))).toBe('c000000001088394c8f03e5157080000449e7b9aec34')
    expect(hex(out)).toBe(A2_PROTECTED)
  })

  it('the server Initial (2-byte packet number)', () => {
    const header = Buffer.from('c1000000010008f067a5502a4262b50040750001', 'hex')
    const out = protectPacket(
      header,
      2,
      1,
      Buffer.from(A3_PAYLOAD, 'hex'),
      initialKeys(DCID, 'server')
    )
    expect(hex(out)).toBe(A3_PROTECTED)
    // and it is what the probe takes for an answer
    expect(isServerReply(out)).toBe(true)
  })

  it('our own Initial: 1200 bytes, long header, QUIC v1, type Initial', () => {
    const { packet, dcid } = buildInitial('rr2---sn-8ph2xajvh-n8vs.googlevideo.com')
    expect(packet.length).toBeGreaterThanOrEqual(1200)
    expect(packet[0] & 0xf0).toBe(0xc0)
    expect(packet.readUInt32BE(1)).toBe(1)
    expect(packet[5]).toBe(8)
    expect(packet.subarray(6, 14)).toEqual(dcid)
  })

  it('answers that are not a server Initial / Handshake do not count', () => {
    expect(isServerReply(Buffer.from('40000000010000', 'hex'))).toBe(false) // short header
    expect(isServerReply(Buffer.from('c0000000000000', 'hex'))).toBe(false) // version negotiation
    expect(isServerReply(Buffer.from('f0000000010000', 'hex'))).toBe(false) // Retry
    expect(isServerReply(Buffer.from('e0000000010000', 'hex'))).toBe(true) // Handshake
  })
})

describe('probeQuic never hangs', () => {
  it('a silent UDP port → «timeout» within the deadline; a reply → ok', async () => {
    const silent = createSocket('udp4')
    await new Promise<void>((r) => silent.bind(0, '127.0.0.1', () => r()))
    const port = silent.address().port
    const t0 = Date.now()
    expect(await probeQuic('127.0.0.1', 'example.org', undefined, 500, port)).toEqual({
      ok: false,
      error: 'timeout'
    })
    expect(Date.now() - t0).toBeLessThan(1500)
    // 0.7.3: switched off meanwhile → ends at once
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const t1 = Date.now()
    expect(await probeQuic('127.0.0.1', 'example.org', undefined, 5000, port, ac.signal)).toEqual({
      ok: false,
      error: 'aborted'
    })
    expect(Date.now() - t1).toBeLessThan(1000)
    silent.close()

    // a «server» that answers a server Initial addressed to someone else (RFC A.3: empty DCID) → not ours
    const stranger = createSocket('udp4')
    const foreign = Buffer.from(A3_PROTECTED, 'hex')
    stranger.on('message', (_m, rinfo) => stranger.send(foreign, rinfo.port, rinfo.address))
    await new Promise<void>((r) => stranger.bind(0, '127.0.0.1', () => r()))
    expect(
      await probeQuic('127.0.0.1', 'example.org', undefined, 700, stranger.address().port)
    ).toEqual({ ok: false, error: 'timeout' })
    stranger.close()

    // a «server» that answers to OUR connection id (its DCID = our SCID) → ok
    const server = createSocket('udp4')
    server.on('message', (m, rinfo) => {
      const dcidLen = m[5]
      const scidLen = m[6 + dcidLen]
      const scid = m.subarray(7 + dcidLen, 7 + dcidLen + scidLen)
      const reply = Buffer.concat([
        Buffer.from([0xc0, 0, 0, 0, 1, scid.length]),
        scid,
        Buffer.from([0]),
        Buffer.alloc(40)
      ])
      server.send(reply, rinfo.port, rinfo.address)
    })
    await new Promise<void>((r) => server.bind(0, '127.0.0.1', () => r()))
    const r = await probeQuic('127.0.0.1', 'example.org', undefined, 2000, server.address().port)
    expect(r.ok).toBe(true)
    server.close()
  })

  it('a reply must carry our SCID as its DCID', () => {
    const scid = Buffer.from('0102030405060708', 'hex')
    const mk = (id: Buffer): Buffer =>
      Buffer.concat([Buffer.from([0xc0, 0, 0, 0, 1, id.length]), id, Buffer.alloc(10)])
    expect(isServerReply(mk(scid), scid)).toBe(true)
    expect(isServerReply(mk(Buffer.from('0102030405060709', 'hex')), scid)).toBe(false)
    expect(isServerReply(mk(Buffer.alloc(0)), scid)).toBe(false)
    expect(isServerReply(Buffer.from(A3_PROTECTED, 'hex'), scid)).toBe(false)
  })
})
