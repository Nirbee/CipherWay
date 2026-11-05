import { describe, expect, it } from 'vitest'
import type { LogEntry } from '@shared/types'
import { isOrdinaryClose, LogFilter } from './logFilter'

const line = (message: string, ts = 0, source: LogEntry['source'] = 'singbox'): LogEntry => ({
  ts,
  level: 'error',
  source,
  message
})

function setup(windowMs = 1000): { f: LogFilter; out: LogEntry[] } {
  const out: LogEntry[] = []
  return { f: new LogFilter((e) => out.push(e), windowMs), out }
}

// real lines from sing-box.log / the xray output (addresses replaced)
const UPLOAD =
  'ERROR [2397529872 144ms] connection: connection upload closed: raw-read tcp4 172.19.0.1:1->203.0.113.1:443: use of closed'
const DOWNLOAD = 'ERROR [1 1s] connection: connection download closed: EOF'
const ABORTED =
  'ERROR [2882759649 627ms] connection: connection upload closed: raw read: An established connection was aborted by the software in your host machine.'
const FORCED = 'ERROR [1 1s] connection: read tcp: wsarecv: An existing connection was forcibly closed by the remote host.'
const REFUSED =
  'ERROR [3437728933 0ms] connection: open connection to 149.154.167.41:80 using outbound/socks[ob_10jcdoh]: dial tcp 127.0.0.1:54760: connectex: No connection could be made because the target machine actively refused it.'
const REALITY =
  '2026/11/06 00:29:36.340111 [Error] [1701365722] transport/internet/reality: REALITY: received real certificate (potential MITM or redirection)'

describe('LogFilter: ordinary broken connections', () => {
  it('hidden without «Подробный журнал», kept with it', () => {
    for (const l of [UPLOAD, DOWNLOAD, ABORTED, FORCED]) {
      expect(isOrdinaryClose(l)).toBe(true)
      const a = setup()
      a.f.push(line(l), false)
      expect(a.out).toEqual([])
      const b = setup()
      b.f.push(line(l), true)
      expect(b.out).toHaveLength(1)
    }
  })

  it('real problems and application lines are never hidden', () => {
    const { f, out } = setup()
    const failed =
      'ERROR connection: open connection to 149.154.167.41:443 using outbound/direct[direct]: dial tcp 149.154.167.41:443: i/o timeout'
    f.push(line(failed), false)
    f.push(line('FATAL start service: boom'), false)
    f.push(line('connection upload closed в приложении: aborted by the software', 0, 'app'), false)
    expect(out).toHaveLength(3)
  })
})

describe('LogFilter: endless repeats', () => {
  it('REALITY: the first line, then one summary per window', () => {
    const { f, out } = setup(1000)
    for (let t = 0; t < 5; t++) f.push(line(REALITY, t * 100, 'xray'), false)
    expect(out).toHaveLength(1)
    f.tick(1000)
    expect(out).toHaveLength(2)
    expect(out[1].message).toMatch(/^… ещё строк: 4 за 1 с \(REALITY/)
    expect(out[1].source).toBe('xray')
    // the window is over: the next one starts with a real line again
    f.push(line(REALITY, 1100, 'xray'), false)
    expect(out).toHaveLength(3)
    expect(out[2].message).toBe(REALITY)
  })

  it('«refused» to our own loopback port is collapsed, in verbose mode too', () => {
    const { f, out } = setup(1000)
    for (let t = 0; t < 50; t++) f.push(line(REFUSED, t), true)
    expect(out).toHaveLength(1)
    f.flush(40)
    expect(out[1].message).toMatch(/^… ещё строк: 49 .*локальное ядро/)
  })

  it('refused to a remote address is a different thing and stays', () => {
    const { f, out } = setup()
    const remote =
      'ERROR connection: open connection to 149.154.167.41:80 using outbound/direct[direct]: dial tcp 149.154.167.41:80: connectex: refused'
    f.push(line(remote), false)
    f.push(line(remote), false)
    expect(out).toHaveLength(2)
  })

  it('a single line leaves no summary', () => {
    const { f, out } = setup(1000)
    f.push(line(REALITY, 0, 'xray'), false)
    f.tick(5000)
    f.flush(5000)
    expect(out).toHaveLength(1)
  })
})
