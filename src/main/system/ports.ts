import { createServer } from 'node:net'

/** Finds a free TCP port (optionally preferring a given one). */
export function findFreePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', () => {
      // preferred busy -> let the OS pick
      const s2 = createServer()
      s2.unref()
      s2.on('error', reject)
      s2.listen(0, '127.0.0.1', () => {
        const port = (s2.address() as { port: number }).port
        s2.close(() => resolve(port))
      })
    })
    srv.listen(preferred ?? 0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}
