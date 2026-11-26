import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CORE_EXE, DPI_ALL, DPI_HASHES } from './coreNames'
import { sha256, TunService } from './tunService'
import { installScript } from './serviceScripts'

// The zapret files of a build are checked against the pinned hashes of the
// release (coreNames.ts DPI_HASHES) before anything goes to the SYSTEM folder.
// Other files: zapret alone is left out — TUN and LAN are set up as usual.

const SID = 'S-1-5-21-1000000001-1000000002-1000000003-1001'

describe('TunService: a build whose zapret files differ from the pinned release', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cw-tunsvc-'))
  const bin = join(tmp, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, CORE_EXE), 'core')
  writeFileSync(join(bin, 'wintun.dll'), 'wintun')
  // the right names, other bytes (a tampered / wrong build)
  for (const f of DPI_ALL) writeFileSync(join(bin, f), `not the release ${f}`)
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  const logs: string[] = []
  const svc = new TunService({
    binDir: bin,
    runDir: join(tmp, 'run'),
    appVersion: '0.7.0',
    log: (_l, m) => logs.push(m),
    rootOverride: join(tmp, 'root'),
    taskExists: async () => true,
    sidOverride: SID
  })

  it('install: TUN (and LAN) as usual, without any zapret part; the reason in the log', async () => {
    const p = await svc.installParams(SID)
    expect(p.dpiBrokerText).toBeUndefined()
    for (const f of DPI_ALL) expect(p.hashes[f]).toBeUndefined()
    expect(p.hashes[CORE_EXE]).toMatch(/^[0-9a-f]{64}$/)
    expect(logs.join('\n')).toMatch(/не совпадает с закреплённым выпуском v72\.13/)
    const script = installScript(p)
    expect(script).not.toContain('DpiXml')
    expect(script).not.toContain("Put-File (Join-Path $SrcBin 'cipherway-dpi.exe')")
    expect(script).toContain('RegisterTask($TaskName, $Xml')
  })

  it('status: the service stays «ok» for TUN, zapret is reported unavailable with the reason', async () => {
    const home = join(tmp, 'root', 'u', SID)
    mkdirSync(home, { recursive: true })
    const p = await svc.installParams(SID)
    writeFileSync(
      join(home, 'manifest.json'),
      JSON.stringify({ broker: sha256(p.brokerText), files: p.hashes })
    )
    const st = await svc.status()
    expect(st.state).toBe('ok')
    expect(st.dpi).toBe(false)
    expect(st.dpiError).toMatch(/zapret/)
  })

  it('the pinned table covers every file', () => {
    for (const f of DPI_ALL) expect(DPI_HASHES[f]).toMatch(/^[0-9a-f]{64}$/)
  })
})
