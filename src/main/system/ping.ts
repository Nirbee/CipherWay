import { connect } from 'node:net'

/** TCP-connect latency to host:port in ms, or null on timeout/error. */
export function tcpPing(host: string, port: number, timeoutMs = 2500): Promise<number | null> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = connect({ host, port })
    let done = false
    const finish = (value: number | null): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(Date.now() - started))
    socket.once('timeout', () => finish(null))
    socket.once('error', () => finish(null))
  })
}
