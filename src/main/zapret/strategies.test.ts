import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DPI_EXE, DPI_FAKE_QUIC, DPI_FAKE_TLS } from '../core/coreNames'
import { STRATEGIES, strategyById, tokenProblems, winwsTokens } from './strategies'
import { SERVICE_DEFS } from './lists'

describe('strategy table', () => {
  it('8–14 different strategies with unique ids', () => {
    expect(STRATEGIES.length).toBeGreaterThanOrEqual(8)
    expect(STRATEGIES.length).toBeLessThanOrEqual(14)
    const ids = STRATEGIES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/)
    // no two strategies bend TLS the same way
    const tls = STRATEGIES.map((s) => s.tls.join(' '))
    expect(new Set(tls).size).toBe(tls.length)
    expect(strategyById('sniext')?.name).toBeTruthy()
    expect(strategyById('nope')).toBeUndefined()
  })

  it('every token is a plain option with known placeholders only (no paths, no quotes)', () => {
    for (const s of STRATEGIES) {
      for (const discord of [false, true]) {
        const t = winwsTokens(s, discord)
        expect(tokenProblems(t)).toEqual([])
        expect(t.join(' ')).not.toMatch(/["'\\/]/)
      }
    }
    expect(tokenProblems(['--x="a b"', '--hostlist=C:\\x', '--a=%EVIL%', '-x'])).toHaveLength(4)
  })

  it('every profile skips our servers; Discord profiles only when Discord is on', () => {
    const s = STRATEGIES[0]
    const off = winwsTokens(s, false)
    const on = winwsTokens(s, true)
    const profiles = (t: string[]): number => t.filter((x) => x === '--new').length + 1
    expect(off.filter((x) => x === '--ipset-exclude=%EXCL%')).toHaveLength(profiles(off))
    expect(on.filter((x) => x === '--ipset-exclude=%EXCL%')).toHaveLength(profiles(on))
    expect(off.join(' ')).not.toMatch(/discord/)
    expect(on).toContain('--filter-l7=discord,stun')
    // the voice profile acts on Discord's own ranges only, never on anyone's STUN
    const at = on.indexOf('--filter-l7=discord,stun')
    expect(on.slice(at, on.indexOf('--new', at))).toContain('--ipset=%DISCORD_IPS%')
    expect(off[0]).toBe('--wf-tcp=80,443')
    expect(on[0]).toBe('--wf-tcp=80,443,2053,2083,2087,2096,8443')
  })
})

// --- the official winws (zapret v72.13) checks every line itself ------------
// `--dry-run` = «verify parameters and exit with code 0 if successful». winws
// asks for admin rights in its manifest; RunAsInvoker lets the check run as the
// user (it opens no driver in --dry-run).

const BIN = resolve(__dirname, '../../../resources/bin')
const EXE = join(BIN, DPI_EXE)
const canRun = process.platform === 'win32' && existsSync(EXE)

describe.skipIf(!canRun)('cipherway-dpi.exe --dry-run accepts every strategy', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cw-dpi-dry-'))
  const hosts = join(tmp, 'hosts.txt')
  const excl = join(tmp, 'exclude.txt')
  const voice = join(tmp, 'discord-ips.txt')
  writeFileSync(hosts, 'youtube.com\ngooglevideo.com\nexample.org\n')
  writeFileSync(excl, '10.0.0.0/8\n203.0.113.7/32\n2001:db8::/32\n')
  writeFileSync(voice, SERVICE_DEFS.discord.cidrs.join('\n') + '\n')
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  const dryRun = (tokens: string[]): { code: number; out: string } => {
    const args = [
      '--dry-run',
      '--wf-iface=1',
      ...tokens.map((t) =>
        t
          .replace('%TLS%', join(BIN, DPI_FAKE_TLS))
          .replace('%QUIC%', join(BIN, DPI_FAKE_QUIC))
          .replace('%HOSTS%', hosts)
          .replace('%EXCL%', excl)
          .replace('%DISCORD_IPS%', voice)
      )
    ]
    try {
      const out = execFileSync(EXE, args, {
        cwd: BIN,
        env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' },
        windowsHide: true,
        timeout: 20_000,
        stdio: 'pipe'
      })
      return { code: 0, out: String(out) }
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  for (const s of STRATEGIES) {
    for (const discord of [false, true]) {
      it(`${s.id}${discord ? ' + Discord' : ''}`, () => {
        const r = dryRun(winwsTokens(s, discord))
        expect(r.out).toMatch(/command line parameters verified/)
        expect(r.code).toBe(0)
      })
    }
  }

  it('a wrong option is refused (the check is real)', () => {
    const r = dryRun(['--wf-tcp=443', '--filter-tcp=443', '--dpi-desync=no-such-mode'])
    expect(r.code).not.toBe(0)
  })
})
