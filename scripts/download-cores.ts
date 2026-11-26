/*
 * Downloads the runtime binaries CipherWay needs into resources/bin:
 *   - cipherway-core.exe  (sing-box, SagerNet/sing-box, Windows amd64) — TUN, routing, DNS, Hysteria2
 *   - cipherway-xray.exe  (xray.exe, XTLS/Xray-core, Windows amd64) — VLESS+REALITY connections
 *   - wintun.dll          (wintun.net, amd64) — required for the TUN inbound
 *   - cipherway-lan.exe / cipherway-lanctl.exe (tailscaled.exe / tailscale.exe,
 *     the official Tailscale Windows build, unmodified) — «LAN» (virtual LAN)
 *
 * The cores get our own names: other VPN clients stop theirs with
 * `taskkill /im xray.exe`, which must not hit ours (and the reverse).
 *
 *   - cipherway-dpi.exe (winws.exe of zapret, bol-van/zapret, the official
 *     Windows x86_64 build, unmodified) + WinDivert.dll / WinDivert64.sys /
 *     cygwin1.dll and two fake payloads — «Ускорение без VPN (zapret)», 0.7.0
 *
 * Run via `npm run download:cores` (also invoked before packaging).
 * Fetch only some cores: `npm run download:cores -- xray` (names: singbox, xray, wintun, lan, zapret).
 * Binaries are NOT committed to git (see .gitignore).
 *
 * Xray is pinned to the exact release the nodes run (26.7.x series): the zip is
 * verified against the release .dgst file AND against the SHA-256 pinned below.
 * Xray geoip/geosite .dat files are not shipped — routing is done by sing-box.
 *
 * Tailscale is pinned too: the amd64 MSI from pkgs.tailscale.com is checked
 * against its published .sha256 AND the SHA-256 pinned below, unpacked with an
 * administrative install (`msiexec /a`, no elevation, nothing gets installed)
 * and the two exes are checked against their own pinned hashes. Its wintun.dll
 * must be the very file we ship (one wintun.dll serves both daemons).
 * Licence: resources/THIRD-PARTY-NOTICES.txt (BSD-3-Clause + PATENTS).
 *
 * zapret is pinned to a stable tag: the zip is checked against the GitHub asset
 * digest AND the SHA-256 pinned below, every file taken from it against the
 * release's sha256sum.txt (binaries) AND its own pinned hash. The zip is read
 * in memory and never written to disk: Windows Defender flags the archive as a
 * whole («Trojan:Win32/Suschil!rfn», seen 26.11.2026 — other tools in it), the
 * files we take are not flagged on their own; each of them still goes through
 * the antivirus when it is written (and is re-hashed after that). Licences:
 * zapret MIT, WinDivert LGPLv3 / GPLv2, Cygwin DLL LGPLv3+ (THIRD-PARTY-NOTICES).
 *
 * NOTE: the generated sing-box config targets the 1.12+ schema (typed DNS
 * servers, route.default_domain_resolver, action-based route rules, rule-sets
 * for geosite/geoip) and is validated against sing-box 1.13.x via
 * `sing-box check`. Bump SINGBOX_SERIES when migrating the schema.
 */
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFileSync, spawnSync } from 'node:child_process'
// the zapret tag and the pinned hashes live in ONE place (the app checks them too)
import { DPI_EXE, DPI_HASHES, ZAPRET_TAG } from '../src/main/core/coreNames'

const BIN_DIR = join(process.cwd(), 'resources', 'bin')
const CORE_EXE = 'cipherway-core.exe' // = src/main/core/coreNames.ts
const XRAY_EXE = 'cipherway-xray.exe'
const SINGBOX_SERIES = /^v?1\.13\./
const WINTUN_URL = 'https://www.wintun.net/builds/wintun-0.14.1.zip'
// Xray-core: same series as the nodes (26.7.x). GitHub marks 26.7.x as
// pre-release, so the tag is pinned explicitly instead of "latest stable".
const XRAY_TAG = 'v26.7.28'
const XRAY_ASSET = 'Xray-windows-64.zip'
const XRAY_ZIP_SHA256 = 'c7172078fca4711bcd92a4774dcd1822544579c58816197575c47533317fd8d1'
// Tailscale (LAN): exact stable release, Windows amd64 MSI
const LAN_EXE = 'cipherway-lan.exe' // = src/main/core/coreNames.ts
const LANCTL_EXE = 'cipherway-lanctl.exe'
const TAILSCALE_VERSION = '1.104.7'
const TAILSCALE_MSI = `tailscale-setup-${TAILSCALE_VERSION}-amd64.msi`
const TAILSCALE_MSI_URL = `https://pkgs.tailscale.com/stable/${TAILSCALE_MSI}`
const TAILSCALE_MSI_SHA256 = '676b5b32fdd1aeaee90d8e8f38e222635b216fbdfbf877bf01cb1d7cda330ec5'
const TAILSCALE_FILES: Record<string, { to: string; sha256: string }> = {
  'tailscaled.exe': {
    to: LAN_EXE,
    sha256: 'c2382efe345c13d6e1592d6191118c7ecf7abf8a178d071459926e4094492991'
  },
  'tailscale.exe': {
    to: LANCTL_EXE,
    sha256: 'e10279fa2f34996b93525484f14984e8a1afa5ccf713d234f7db9aa33873b007'
  }
}

// zapret (DPI bypass): exact stable release, Windows x86_64 binaries
const ZAPRET_ASSET = `zapret-${ZAPRET_TAG}.zip`
const ZAPRET_ZIP_SHA256 = 'c493e33a0dc4eba23a8686efdaba55f59755ad6ade3564aebd9d13f4c65e2e0c'
const ZAPRET_ROOT = `zapret-${ZAPRET_TAG}`
/** path in the zip → our name (its pinned SHA-256: DPI_HASHES in src/main/core/coreNames.ts) */
const ZAPRET_FILES: Record<string, { to: keyof typeof DPI_HASHES; listed: boolean }> = {
  'binaries/windows-x86_64/winws.exe': { to: DPI_EXE, listed: true },
  'binaries/windows-x86_64/WinDivert.dll': { to: 'WinDivert.dll', listed: true },
  'binaries/windows-x86_64/WinDivert64.sys': { to: 'WinDivert64.sys', listed: true },
  'binaries/windows-x86_64/cygwin1.dll': { to: 'cygwin1.dll', listed: true },
  // fake payloads: sha256sum.txt lists binaries only — pinned hash only
  'files/fake/tls_clienthello_www_google_com.bin': {
    to: 'tls_clienthello_www_google_com.bin',
    listed: false
  },
  'files/fake/quic_initial_www_google_com.bin': {
    to: 'quic_initial_www_google_com.bin',
    listed: false
  }
}

interface GhRelease {
  tag_name: string
  prerelease: boolean
  assets: { name: string; browser_download_url: string; digest?: string | null }[]
}

async function ghReleases(repo: string): Promise<GhRelease[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
    headers: { 'User-Agent': 'cipherway-build', Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub API ${repo}: ${res.status} ${res.statusText}`)
  return (await res.json()) as GhRelease[]
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'cipherway-build' } })
  if (!res.ok || !res.body) throw new Error(`download failed ${url}: ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

function unzip(zip: string, dest: string): void {
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Force -Path '${zip}' -DestinationPath '${dest}'`
    ])
  } else {
    execFileSync('unzip', ['-o', zip, '-d', dest])
  }
}

/** Recursively find the first file matching `name` under `dir`. */
async function findFile(dir: string, name: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = await findFile(full, name)
      if (hit) return hit
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full
    }
  }
  return null
}

async function getSingbox(): Promise<void> {
  console.log('\n== sing-box ==')
  const releases = await ghReleases('SagerNet/sing-box')
  const rel =
    releases.find((r) => !r.prerelease && SINGBOX_SERIES.test(r.tag_name)) ??
    releases.find((r) => !r.prerelease)
  if (!rel) throw new Error('no suitable sing-box release found')

  const asset = rel.assets.find((a) => /windows-amd64\.zip$/i.test(a.name))
  if (!asset) throw new Error(`sing-box windows-amd64.zip not found in ${rel.tag_name}`)

  const zip = join(BIN_DIR, asset.name)
  console.log(`downloading ${asset.name} (${rel.tag_name})…`)
  await downloadTo(asset.browser_download_url, zip)

  // verify against the checksums asset if present
  const sums = rel.assets.find((a) => /checksums?\.txt$/i.test(a.name))
  if (sums) {
    const sumPath = join(BIN_DIR, sums.name)
    await downloadTo(sums.browser_download_url, sumPath)
    const actual = await sha256(zip)
    if (!(await readFile(sumPath, 'utf8')).toLowerCase().includes(actual.toLowerCase())) {
      await rm(zip)
      throw new Error(`checksum mismatch for ${asset.name}`)
    }
    console.log(`checksum OK (${(await sha256(zip)).slice(0, 12)}…)`)
    await rm(sumPath)
  } else {
    console.warn('! no checksums asset; skipping verification')
  }

  const tmp = join(BIN_DIR, 'singbox-unzip')
  await rm(tmp, { recursive: true, force: true })
  unzip(zip, tmp)
  const exe = await findFile(tmp, 'sing-box.exe')
  if (!exe) throw new Error('sing-box.exe not found in archive')
  await writeFile(join(BIN_DIR, CORE_EXE), await readFile(exe))
  await rm(join(BIN_DIR, 'sing-box.exe'), { force: true })
  await rm(tmp, { recursive: true, force: true })
  await rm(zip, { force: true })
  console.log(`-> ${join(BIN_DIR, CORE_EXE)}`)
}

async function getXray(): Promise<void> {
  console.log('\n== xray ==')
  const res = await fetch(`https://api.github.com/repos/XTLS/Xray-core/releases/tags/${XRAY_TAG}`, {
    headers: { 'User-Agent': 'cipherway-build', Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub API Xray-core ${XRAY_TAG}: ${res.status} ${res.statusText}`)
  const rel = (await res.json()) as GhRelease
  const asset = rel.assets.find((a) => a.name === XRAY_ASSET)
  const dgst = rel.assets.find((a) => a.name === `${XRAY_ASSET}.dgst`)
  if (!asset || !dgst) throw new Error(`${XRAY_ASSET}(.dgst) not found in ${rel.tag_name}`)

  const zip = join(BIN_DIR, asset.name)
  console.log(`downloading ${asset.name} (${rel.tag_name})…`)
  await downloadTo(asset.browser_download_url, zip)

  // .dgst format: lines like "SHA2-256= <hex>"
  const dgstPath = join(BIN_DIR, dgst.name)
  await downloadTo(dgst.browser_download_url, dgstPath)
  const published = /SHA2-256=\s*([0-9a-f]{64})/i.exec(await readFile(dgstPath, 'utf8'))?.[1]
  await rm(dgstPath, { force: true })
  const actual = await sha256(zip)
  if (!published || published.toLowerCase() !== actual) {
    await rm(zip, { force: true })
    throw new Error(`checksum mismatch for ${asset.name} (.dgst)`)
  }
  if (actual !== XRAY_ZIP_SHA256) {
    await rm(zip, { force: true })
    throw new Error(`checksum mismatch for ${asset.name}: pinned ${XRAY_ZIP_SHA256}, got ${actual}`)
  }
  console.log(`checksum OK (${actual.slice(0, 12)}…, pinned)`)

  const tmp = join(BIN_DIR, 'xray-unzip')
  await rm(tmp, { recursive: true, force: true })
  unzip(zip, tmp)
  const exe = await findFile(tmp, 'xray.exe')
  if (!exe) throw new Error('xray.exe not found in archive')
  await writeFile(join(BIN_DIR, XRAY_EXE), await readFile(exe))
  await rm(join(BIN_DIR, 'xray.exe'), { force: true })
  await rm(tmp, { recursive: true, force: true })
  await rm(zip, { force: true })
  console.log(`-> ${join(BIN_DIR, XRAY_EXE)}`)
}

async function getWintun(): Promise<void> {
  console.log('\n== wintun ==')
  const zip = join(BIN_DIR, 'wintun.zip')
  console.log(`downloading ${WINTUN_URL}…`)
  await downloadTo(WINTUN_URL, zip)
  console.warn('! wintun has no published checksum endpoint; verify out-of-band if needed')

  const tmp = join(BIN_DIR, 'wintun-unzip')
  await rm(tmp, { recursive: true, force: true })
  unzip(zip, tmp)
  const dll = await findFile(join(tmp, 'wintun', 'bin', 'amd64'), 'wintun.dll')
  const found = dll ?? (await findFile(tmp, 'wintun.dll'))
  if (!found) throw new Error('wintun.dll (amd64) not found in archive')
  await writeFile(join(BIN_DIR, 'wintun.dll'), await readFile(found))
  await rm(tmp, { recursive: true, force: true })
  await rm(zip, { force: true })
  console.log(`-> ${join(BIN_DIR, 'wintun.dll')}`)
}

async function getLan(): Promise<void> {
  console.log(`
== tailscale ${TAILSCALE_VERSION} (LAN) ==`)
  if (process.platform !== 'win32')
    throw new Error('the Tailscale MSI is unpacked with msiexec (Windows only)')
  const msi = join(BIN_DIR, TAILSCALE_MSI)
  console.log(`downloading ${TAILSCALE_MSI}…`)
  await downloadTo(TAILSCALE_MSI_URL, msi)
  const sumPath = `${msi}.sha256`
  await downloadTo(`${TAILSCALE_MSI_URL}.sha256`, sumPath)
  const published = /^([0-9a-f]{64})/i.exec((await readFile(sumPath, 'utf8')).trim())?.[1]
  await rm(sumPath, { force: true })
  const actual = await sha256(msi)
  if (!published || published.toLowerCase() !== actual || actual !== TAILSCALE_MSI_SHA256) {
    await rm(msi, { force: true })
    throw new Error(
      `checksum mismatch for ${TAILSCALE_MSI}: pinned ${TAILSCALE_MSI_SHA256}, published ${published}, got ${actual}`
    )
  }
  console.log(`checksum OK (${actual.slice(0, 12)}…, pinned)`)

  const tmp = join(BIN_DIR, 'tailscale-unpack')
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  // administrative install = unpack the files only: no service, no registry, no UAC
  // msiexec wants TARGETDIR="C:\path" — quoted by hand (verbatim), not by Node
  const res = spawnSync('msiexec.exe', ['/a', `"${msi}"`, '/qn', `TARGETDIR="${tmp}"`], {
    windowsHide: true,
    windowsVerbatimArguments: true
  })
  if (res.status !== 0) throw new Error(`msiexec /a failed: ${res.status ?? res.error?.message}`)
  for (const [name, f] of Object.entries(TAILSCALE_FILES)) {
    const exe = await findFile(tmp, name)
    if (!exe) throw new Error(`${name} not found in ${TAILSCALE_MSI}`)
    const got = await sha256(exe)
    if (got !== f.sha256)
      throw new Error(`checksum mismatch for ${name}: pinned ${f.sha256}, got ${got}`)
    await writeFile(join(BIN_DIR, f.to), await readFile(exe))
    console.log(`-> ${join(BIN_DIR, f.to)}`)
  }
  const theirWintun = await findFile(tmp, 'wintun.dll')
  const ours = join(BIN_DIR, 'wintun.dll')
  if (theirWintun) {
    try {
      if ((await sha256(theirWintun)) !== (await sha256(ours))) {
        console.warn('! the wintun.dll of Tailscale differs from ours — check both before shipping')
      }
    } catch {
      console.warn('! resources/bin/wintun.dll is missing — run `npm run download:cores -- wintun`')
    }
  }
  await rm(tmp, { recursive: true, force: true })
  await rm(msi, { force: true })
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': 'cipherway-build' } })
  if (!res.ok) throw new Error(`download failed ${url}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const sha256Of = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/**
 * The files of a zip held in memory (stored / deflate, no zip64 — enough for
 * the zapret release): name → bytes, only for the names in `wanted`.
 */
function unzipInMemory(zip: Buffer, wanted: Set<string>): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: no end of central directory')
  const count = zip.readUInt16LE(eocd + 10)
  let pos = zip.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('zip: bad central directory')
    const method = zip.readUInt16LE(pos + 10)
    const csize = zip.readUInt32LE(pos + 20)
    const usize = zip.readUInt32LE(pos + 24)
    const nameLen = zip.readUInt16LE(pos + 28)
    const extraLen = zip.readUInt16LE(pos + 30)
    const commentLen = zip.readUInt16LE(pos + 32)
    const local = zip.readUInt32LE(pos + 42)
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLen)
    pos += 46 + nameLen + extraLen + commentLen
    if (!wanted.has(name)) continue
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip: bad local header ${name}`)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + csize)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`zip: unsupported method ${method} for ${name}`)
    if (data.length !== usize) throw new Error(`zip: size mismatch for ${name}`)
    out.set(name, data)
  }
  return out
}

async function getZapret(): Promise<void> {
  console.log(`\n== zapret ${ZAPRET_TAG} (DPI bypass) ==`)
  const res = await fetch(
    `https://api.github.com/repos/bol-van/zapret/releases/tags/${ZAPRET_TAG}`,
    { headers: { 'User-Agent': 'cipherway-build', Accept: 'application/vnd.github+json' } }
  )
  if (!res.ok) throw new Error(`GitHub API zapret ${ZAPRET_TAG}: ${res.status} ${res.statusText}`)
  const rel = (await res.json()) as GhRelease
  const asset = rel.assets.find((a) => a.name === ZAPRET_ASSET)
  const sums = rel.assets.find((a) => a.name === 'sha256sum.txt')
  if (!asset || !sums) throw new Error(`${ZAPRET_ASSET} / sha256sum.txt not found in ${rel.tag_name}`)

  console.log(`downloading ${asset.name} (${rel.tag_name}) into memory…`)
  const zip = await downloadBuffer(asset.browser_download_url)
  const actual = sha256Of(zip)
  const published = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase()
  if (published && published !== actual) {
    throw new Error(`checksum mismatch for ${ZAPRET_ASSET}: GitHub ${published}, got ${actual}`)
  }
  if (actual !== ZAPRET_ZIP_SHA256) {
    throw new Error(
      `checksum mismatch for ${ZAPRET_ASSET}: pinned ${ZAPRET_ZIP_SHA256}, got ${actual}`
    )
  }
  console.log(`checksum OK (${actual.slice(0, 12)}…, pinned${published ? ' + GitHub digest' : ''})`)

  const listed = new Map<string, string>()
  const sumText = (await downloadBuffer(sums.browser_download_url)).toString('utf8')
  for (const line of sumText.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(line.trim())
    if (m) listed.set(m[2], m[1].toLowerCase())
  }

  const wanted = new Set(Object.keys(ZAPRET_FILES).map((f) => `${ZAPRET_ROOT}/${f}`))
  const files = unzipInMemory(zip, wanted)
  for (const [inZip, f] of Object.entries(ZAPRET_FILES)) {
    const full = `${ZAPRET_ROOT}/${inZip}`
    const data = files.get(full)
    if (!data) throw new Error(`${inZip} not found in ${ZAPRET_ASSET}`)
    const got = sha256Of(data)
    const pinned = DPI_HASHES[f.to]
    if (f.listed && listed.get(full) !== got) {
      throw new Error(`checksum mismatch for ${inZip}: sha256sum.txt ${listed.get(full)}, got ${got}`)
    }
    if (got !== pinned) {
      throw new Error(`checksum mismatch for ${inZip}: pinned ${pinned}, got ${got}`)
    }
    const dest = join(BIN_DIR, f.to)
    await writeFile(dest, data)
    // an antivirus may take the file away (or change it) right after it was written
    if ((await sha256(dest).catch(() => '')) !== pinned) {
      throw new Error(`${f.to} is gone or changed after writing — check the antivirus quarantine`)
    }
    console.log(`-> ${dest}`)
  }
}

async function main(): Promise<void> {
  await mkdir(BIN_DIR, { recursive: true })
  const all = {
    singbox: getSingbox,
    xray: getXray,
    wintun: getWintun,
    lan: getLan,
    zapret: getZapret
  } as const
  const wanted = process.argv.slice(2).map((a) => a.toLowerCase().replace(/[^a-z]/g, ''))
  for (const name of wanted) {
    if (!(name in all))
      throw new Error(`unknown core "${name}" (use: ${Object.keys(all).join(', ')})`)
  }
  for (const [name, fn] of Object.entries(all)) {
    if (wanted.length === 0 || wanted.includes(name)) await fn()
  }
  console.log('\nAll cores ready in resources/bin')
}

main().catch((err) => {
  console.error('\ndownload-cores failed:', err.message)
  process.exit(1)
})
