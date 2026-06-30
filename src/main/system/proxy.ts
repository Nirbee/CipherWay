import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const BYPASS = 'localhost;127.*;10.*;172.16.*;172.17.*;192.168.*;<local>'

/**
 * Windows system proxy via the WinInet registry keys. Most apps re-read these
 * on the next connection. A WinInet INTERNET_OPTION_SETTINGS_CHANGED broadcast
 * helper can be added later to force an immediate refresh.
 */
export async function enableSystemProxy(httpPort: number): Promise<void> {
  if (process.platform !== 'win32') return
  const server = `127.0.0.1:${httpPort}`
  await reg('ProxyServer', 'REG_SZ', server)
  await reg('ProxyOverride', 'REG_SZ', BYPASS)
  await reg('ProxyEnable', 'REG_DWORD', '1')
}

export async function disableSystemProxy(): Promise<void> {
  if (process.platform !== 'win32') return
  await reg('ProxyEnable', 'REG_DWORD', '0')
}

async function reg(name: string, type: string, data: string): Promise<void> {
  await exec('reg', ['add', REG_PATH, '/v', name, '/t', type, '/d', data, '/f'], {
    windowsHide: true
  })
}
