import { useEffect, useState } from 'react'

const cache = new Map<string, string | null>()
const pending = new Map<string, Promise<string | null>>()

/** data: URL of an exe's icon (via app.getFileIcon in main), cached per path. */
export function useProcessIcon(path: string | undefined): string | null {
  const key = path?.toLowerCase()
  const [icon, setIcon] = useState<string | null>(key ? (cache.get(key) ?? null) : null)

  useEffect(() => {
    if (!path || !key || !/\.exe$/i.test(path)) {
      setIcon(null)
      return
    }
    if (cache.has(key)) {
      setIcon(cache.get(key) ?? null)
      return
    }
    let alive = true
    let p = pending.get(key)
    if (!p) {
      p = window.api.connections.icon(path).catch(() => null)
      pending.set(key, p)
    }
    void p.then((url) => {
      cache.set(key, url)
      pending.delete(key)
      if (alive) setIcon(url)
    })
    return () => {
      alive = false
    }
  }, [path, key])

  return icon
}
