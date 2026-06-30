/*
 * Downloads the runtime binaries CipherWay needs into resources/bin:
 *   - sing-box.exe  (SagerNet/sing-box, Windows amd64)
 *   - wintun.dll    (wintun.net, amd64) — required for the TUN inbound
 *
 * Run via `npm run download:cores` (also invoked before packaging).
 * Binaries are NOT committed to git (see .gitignore).
 *
 * NOTE: the generated sing-box config targets the 1.12+ schema (typed DNS
 * servers, route.default_domain_resolver, action-based route rules, rule-sets
 * for geosite/geoip) and is validated against sing-box 1.13.x via
 * `sing-box check`. Bump SINGBOX_SERIES when migrating the schema.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'

const BIN_DIR = join(process.cwd(), 'resources', 'bin')
const SINGBOX_SERIES = /^v?1\.13\./
const WINTUN_URL = 'https://www.wintun.net/builds/wintun-0.14.1.zip'

interface GhRelease {
  tag_name: string
  prerelease: boolean
  assets: { name: string; browser_download_url: string }[]
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
  await writeFile(join(BIN_DIR, 'sing-box.exe'), await readFile(exe))
  await rm(tmp, { recursive: true, force: true })
  await rm(zip, { force: true })
  console.log(`-> ${join(BIN_DIR, 'sing-box.exe')}`)
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

async function main(): Promise<void> {
  await mkdir(BIN_DIR, { recursive: true })
  await getSingbox()
  await getWintun()
  console.log('\nAll cores ready in resources/bin')
}

main().catch((err) => {
  console.error('\ndownload-cores failed:', err.message)
  process.exit(1)
})
