import { createCipheriv, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { isIP } from 'node:net'
import { countConnection, onAbort } from './probeNet'

// ---------------------------------------------------------------------------
// A QUIC probe of a YouTube video node (0.7.2). Browsers fetch YouTube video
// over QUIC (UDP 443) first; the provider's DPI may treat it differently
// from TCP — on one PC the video went direct over QUIC (5.7 MB) while TCP to
// the same node got 6 KB. So the node is checked over both, separately.
// The probe sends one real QUIC v1 Initial (RFC 9000 / 9001): a TLS 1.3
// ClientHello with SNI = the node and ALPN h3, protected with the initial keys
// (HKDF-SHA256, AES-128-GCM, AES-ECB header protection — node:crypto only)
// and padded to 1200 bytes. Success = any Initial / Handshake packet of QUIC
// v1 coming back within the deadline (their type bits and version are not
// protected, so no keys of the server are needed). winws sees the same
// Initial a browser sends (its QUIC profile matches the SNI). Pure parts are
// checked against RFC 9001 Appendix A in quic.test.ts.
// ---------------------------------------------------------------------------

/** RFC 9001 §5.2: the initial salt of QUIC v1 */
const INITIAL_SALT_V1 = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex')

export function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac('sha256', salt).update(ikm).digest()
}

/** RFC 8446 §7.1 HKDF-Expand-Label with an empty context */
export function hkdfExpandLabel(secret: Buffer, label: string, length: number): Buffer {
  const full = Buffer.from(`tls13 ${label}`, 'ascii')
  const info = Buffer.concat([
    Buffer.from([length >> 8, length & 0xff, full.length]),
    full,
    Buffer.from([0])
  ])
  const out: Buffer[] = []
  let t = Buffer.alloc(0)
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    t = createHmac('sha256', secret)
      .update(Buffer.concat([t, info, Buffer.from([i])]))
      .digest()
    out.push(t)
  }
  return Buffer.concat(out).subarray(0, length)
}

export interface InitialKeys {
  secret: Buffer
  key: Buffer
  iv: Buffer
  hp: Buffer
}

/** The Initial keys of one side for the client's Destination Connection ID. */
export function initialKeys(dcid: Buffer, side: 'client' | 'server'): InitialKeys {
  const initial = hkdfExtract(INITIAL_SALT_V1, dcid)
  const secret = hkdfExpandLabel(initial, side === 'client' ? 'client in' : 'server in', 32)
  return {
    secret,
    key: hkdfExpandLabel(secret, 'quic key', 16),
    iv: hkdfExpandLabel(secret, 'quic iv', 12),
    hp: hkdfExpandLabel(secret, 'quic hp', 16)
  }
}

/** RFC 9000 §16 variable-length integer */
export function varint(n: number): Buffer {
  if (n < 0x40) return Buffer.from([n])
  if (n < 0x4000) return Buffer.from([0x40 | (n >> 8), n & 0xff])
  if (n < 0x40000000) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    b[0] |= 0x80
    return b
  }
  throw new Error('varint too large')
}

/**
 * Protects a long-header packet (RFC 9001 §5.3, §5.4): `header` ends with the
 * plain packet number of `pnLength` bytes; AEAD over `payload` with the header
 * as AAD, then header protection with a sample of the ciphertext.
 */
export function protectPacket(
  header: Buffer,
  pnLength: number,
  pn: number,
  payload: Buffer,
  keys: InitialKeys
): Buffer {
  const pnOffset = header.length - pnLength
  const nonce = Buffer.from(keys.iv)
  for (let i = 0; i < 4; i++) nonce[nonce.length - 1 - i] ^= (pn >>> (8 * i)) & 0xff
  const gcm = createCipheriv('aes-128-gcm', keys.key, nonce)
  gcm.setAAD(header)
  const sealed = Buffer.concat([gcm.update(payload), gcm.final(), gcm.getAuthTag()])
  // the sample starts 4 bytes after the start of the packet number
  const sample = sealed.subarray(4 - pnLength, 4 - pnLength + 16)
  const ecb = createCipheriv('aes-128-ecb', keys.hp, null)
  ecb.setAutoPadding(false)
  const mask = ecb.update(sample)
  const h = Buffer.from(header)
  h[0] ^= mask[0] & 0x0f
  for (let i = 0; i < pnLength; i++) h[pnOffset + i] ^= mask[1 + i]
  return Buffer.concat([h, sealed])
}

const u16 = (n: number): Buffer => Buffer.from([n >> 8, n & 0xff])
const ext = (type: number, body: Buffer): Buffer =>
  Buffer.concat([u16(type), u16(body.length), body])

/** A TLS 1.3 ClientHello for QUIC: SNI, ALPN h3, x25519 key share, transport parameters. */
export function clientHello(sni: string, scid: Buffer): Buffer {
  const name = Buffer.from(sni, 'ascii')
  const pub = generateKeyPairSync('x25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .subarray(-32)
  const tp = (id: number, value: Buffer): Buffer =>
    Buffer.concat([varint(id), varint(value.length), value])
  const params = Buffer.concat([
    tp(0x01, varint(30_000)), // max_idle_timeout
    tp(0x04, varint(1_048_576)), // initial_max_data
    tp(0x05, varint(262_144)), // initial_max_stream_data_bidi_local
    tp(0x06, varint(262_144)), // …_bidi_remote
    tp(0x07, varint(262_144)), // …_uni
    tp(0x08, varint(100)), // initial_max_streams_bidi
    tp(0x09, varint(100)), // initial_max_streams_uni
    tp(0x0f, scid) // initial_source_connection_id
  ])
  const sigs = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601]
  const exts = Buffer.concat([
    ext(0x0000, Buffer.concat([u16(name.length + 3), Buffer.from([0]), u16(name.length), name])),
    ext(0x000a, Buffer.concat([u16(4), u16(0x001d), u16(0x0017)])),
    ext(0x000d, Buffer.concat([u16(sigs.length * 2), ...sigs.map(u16)])),
    ext(0x0010, Buffer.concat([u16(3), Buffer.from([2]), Buffer.from('h3', 'ascii')])),
    ext(0x002b, Buffer.from([2, 0x03, 0x04])),
    ext(0x002d, Buffer.from([1, 1])),
    ext(0x0033, Buffer.concat([u16(36), u16(0x001d), u16(32), pub])),
    ext(0x0039, params)
  ])
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    randomBytes(32),
    Buffer.from([0]), // legacy_session_id: empty in QUIC
    u16(6),
    u16(0x1301),
    u16(0x1302),
    u16(0x1303),
    Buffer.from([1, 0]),
    u16(exts.length),
    exts
  ])
  return Buffer.concat([
    Buffer.from([0x01, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]),
    body
  ])
}

/** One client Initial datagram (≥ 1200 bytes) for `sni`; `scid` = what the server must answer to. */
export function buildInitial(sni: string): { packet: Buffer; dcid: Buffer; scid: Buffer } {
  const dcid = randomBytes(8)
  const scid = randomBytes(8)
  const ch = clientHello(sni, scid)
  const crypto = Buffer.concat([Buffer.from([0x06]), varint(0), varint(ch.length), ch])
  const pnLength = 4
  // header without the length field: 1 + 4 + 1+8 + 1+8 + 1 (token length 0) = 24, + 2 (length) + 4 (pn)
  const headerLen = 24 + 2 + pnLength
  const payloadLen = Math.max(crypto.length, 1200 - headerLen - 16)
  const payload = Buffer.concat([crypto, Buffer.alloc(payloadLen - crypto.length)])
  const header = Buffer.concat([
    Buffer.from([0xc0 | (pnLength - 1)]),
    Buffer.from([0, 0, 0, 1]),
    Buffer.from([dcid.length]),
    dcid,
    Buffer.from([scid.length]),
    scid,
    varint(0),
    varint2(pnLength + payload.length + 16),
    Buffer.alloc(pnLength) // packet number 0
  ])
  return {
    packet: protectPacket(header, pnLength, 0, payload, initialKeys(dcid, 'client')),
    dcid,
    scid
  }
}

/** a 2-byte varint (the length field is written in 2 bytes, as RFC 9001's sample does) */
function varint2(n: number): Buffer {
  if (n >= 0x4000) throw new Error('length too large')
  return Buffer.from([0x40 | (n >> 8), n & 0xff])
}

/**
 * A QUIC v1 Initial or Handshake packet (long header; type, version and the
 * connection ids are not protected) — addressed to us: its Destination
 * Connection ID is our Source Connection ID (`scid`; omitted: not checked).
 */
export function isServerReply(b: Buffer, scid?: Buffer): boolean {
  if (b.length < 7 || (b[0] & 0x80) === 0) return false
  if (b.readUInt32BE(1) !== 1) return false
  const type = (b[0] & 0x30) >> 4
  if (type !== 0 && type !== 2) return false
  if (!scid) return true
  const len = b[5]
  return len === scid.length && b.length >= 6 + len && b.subarray(6, 6 + len).equals(scid)
}

export interface QuicResult {
  ok: boolean
  error?: string
  ms?: number
}

/**
 * One QUIC Initial to ip:443 (bound to `localAddress` in TUN mode — past the
 * tunnel): ok once a server Initial / Handshake comes back. Never longer than
 * `timeoutMs`, never throws.
 */
export function probeQuic(
  ip: string,
  sni: string,
  localAddress?: string,
  timeoutMs = 3000,
  port = 443,
  signal?: AbortSignal
): Promise<QuicResult> {
  const t0 = Date.now()
  if (signal?.aborted) return Promise.resolve({ ok: false, error: 'aborted' })
  countConnection()
  return new Promise((resolve) => {
    let done = false
    const sock = createSocket(isIP(ip) === 6 ? 'udp6' : 'udp4')
    const finish = (r: QuicResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      unhook()
      try {
        sock.close()
      } catch {
        /* closed */
      }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs)
    const unhook = onAbort(signal, () => finish({ ok: false, error: 'aborted' }))
    sock.on('error', (e) =>
      finish({ ok: false, error: `udp:${(e as { code?: string }).code ?? 'error'}` })
    )
    let scid: Buffer | null = null
    // only from the very address and port we asked, only addressed to our connection id
    sock.on('message', (msg, rinfo) => {
      if (!scid || rinfo.address !== ip || rinfo.port !== port) return
      if (isServerReply(msg, scid)) finish({ ok: true, ms: Date.now() - t0 })
    })
    const send = (): void => {
      try {
        const built = buildInitial(sni)
        scid = built.scid
        const { packet } = built
        sock.send(packet, port, ip, (err) => {
          if (err) finish({ ok: false, error: 'udp:send' })
        })
      } catch {
        finish({ ok: false, error: 'udp:build' })
      }
    }
    if (localAddress) sock.bind({ address: localAddress, port: 0 }, send)
    else send()
  })
}
