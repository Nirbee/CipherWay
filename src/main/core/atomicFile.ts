import { rename, rm, writeFile } from 'node:fs/promises'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Write via a temp file + rename, so a reader (sing-box watching its rule-set
 * files, the TUN broker) never sees half a file. On Windows the rename fails
 * while someone has the target open without FILE_SHARE_DELETE (Go's os.Open)
 * — retried for up to ~3 s.
 */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  let last: unknown
  for (let i = 0; i < 30; i++) {
    try {
      await rename(tmp, path)
      return
    } catch (err) {
      last = err
      await sleep(100)
    }
  }
  await rm(tmp, { force: true }).catch(() => undefined)
  throw last instanceof Error ? last : new Error(String(last))
}
