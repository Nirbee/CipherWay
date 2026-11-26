import { request as httpsRequest } from 'node:https'
import { dohResolve, type DirectPath, type DohServer } from './checks'

// ---------------------------------------------------------------------------
// YouTube's video servers (0.7.1). www.youtube.com and redirector.googlevideo.com
// often open directly while the video itself does not: the provider's DPI
// drops the TLS ClientHello with SNI *.googlevideo.com to the video caches
// (seen on Beeline: TCP 443 up, TLS with SNI googlevideo hangs, the same IP
// answers with SNI www.google.com). So the check must reach a REAL cache node
// — the one the player of this network gets:
//   1. the watch page of a long-lived video (fetched directly): its player data
//      names the cache nodes for this client (rrN---sn-XXXX.googlevideo.com);
//   2. else report_mapping on the redirector («<ip> => vimpelcom-voz2 (…)»):
//      the cluster name converted to its sn- name (CLUSTER_TO_SN), rr1 / rr2,
//      kept only if DoH resolves them.
// Every request has its own deadline and a size limit. Pure parts unit tested
// in videoNodes.test.ts.
// ---------------------------------------------------------------------------

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * Cluster name character → sn- name character. The community table (the
 * YouTube cache finders of zapret / GoodbyeDPI users) is the affine map
 * sn = 7·(c + 1) mod 36 over 0-9a-z — except that `u` and `z` trade places.
 * Checked on Beeline (26.11.2026): «vimpelcom» → «8ph2xajvh», «voz2» → «8v1l»,
 * «svo3» → «n8vs» — all three are real nodes the player uses there.
 */
const CLUSTER_TO_SN: Record<string, string> = (() => {
  const t: Record<string, string> = {}
  for (let c = 0; c < 36; c++) t[ALPHABET[c]] = ALPHABET[(7 * (c + 1)) % 36]
  const u = t.u
  t.u = t.z
  t.z = u
  t['-'] = '-'
  return t
})()

/** «vimpelcom-voz2» → «8ph2xajvh-8v1l»; null for anything that is not a cluster name. */
export function clusterToSn(cluster: string): string | null {
  const c = cluster.trim().toLowerCase()
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c) || c.length > 40) return null
  return [...c].map((ch) => CLUSTER_TO_SN[ch]).join('')
}

/** The cluster of report_mapping's answer («95.24.1.2 => vimpelcom-voz2 (95.24.0.0/16)»). */
export function parseReportMapping(text: string): string | null {
  return /=>\s*([a-z0-9]+(?:-[a-z0-9]+)*)/i.exec(text)?.[1]?.toLowerCase() ?? null
}

const NODE_RE = /rr(\d{1,2})---sn-([a-z0-9]+(?:-[a-z0-9]+)*)\.googlevideo\.com/g

/** Video node host names a page names, most mentioned first (at most `max`). */
export function nodesFromPage(text: string, max = 3): string[] {
  const count = new Map<string, number>()
  for (const m of text.matchAll(NODE_RE)) {
    const host = `rr${m[1]}---sn-${m[2]}.googlevideo.com`.toLowerCase()
    count.set(host, (count.get(host) ?? 0) + 1)
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([h]) => h)
    .slice(0, max)
}

/** rr1 / rr2 of an sn- name (the fallback when only the cluster is known). */
export const snHosts = (sn: string): string[] =>
  [1, 2].map((n) => `rr${n}---sn-${sn}.googlevideo.com`)

/** a long-lived video: its watch page lists the cache nodes of this client */
export const PROBE_VIDEO = 'jNQXAC9IVRw'

/**
 * GET https://<host><path> directly (the address from DoH, SNI = host): the
 * body as text, at most `maxBytes`; null on any failure. Never longer than
 * `timeoutMs`.
 */
export async function getDirect(
  host: string,
  urlPath: string,
  doh: DohServer,
  path: DirectPath,
  maxBytes: number,
  timeoutMs: number
): Promise<string | null> {
  const t0 = Date.now()
  const ips = await dohResolve(host, doh, path, Math.min(4000, timeoutMs))
  if (!ips.length) return null
  const left = Math.max(1000, timeoutMs - (Date.now() - t0))
  return new Promise((resolve) => {
    let done = false
    const chunks: Buffer[] = []
    let size = 0
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.destroy()
      resolve(v)
    }
    const req = httpsRequest(
      {
        host: ips[0],
        servername: host,
        port: 443,
        path: urlPath,
        method: 'GET',
        agent: false,
        headers: {
          Host: host,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
          'Accept-Language': 'ru'
        },
        ...(path.localAddress ? { localAddress: path.localAddress } : {})
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          finish(null)
          return
        }
        res.on('data', (d: Buffer) => {
          size += d.length
          chunks.push(d)
          if (size >= maxBytes) finish(Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'))
        })
        res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
        res.on('error', () => finish(null))
      }
    )
    const timer = setTimeout(
      () => finish(size > 0 ? Buffer.concat(chunks).toString('utf8') : null),
      left
    )
    req.on('error', () => finish(null))
    req.end()
  })
}

export interface VideoNodeDeps {
  get: (
    host: string,
    urlPath: string,
    maxBytes: number,
    timeoutMs: number
  ) => Promise<string | null>
  resolves: (host: string) => Promise<boolean>
}

/**
 * The video nodes to check, `via` what they were found. [] = none found (the
 * caller treats YouTube as «not verified» → through the VPN).
 */
export async function findVideoNodes(
  d: VideoNodeDeps
): Promise<{ nodes: string[]; via: 'page' | 'mapping' | 'none' }> {
  const page = await d.get('www.youtube.com', `/watch?v=${PROBE_VIDEO}`, 3_000_000, 12_000)
  const fromPage = page ? nodesFromPage(page, 2) : []
  if (fromPage.length) return { nodes: fromPage, via: 'page' }
  const mapping = await d.get('redirector.googlevideo.com', '/report_mapping?di=no', 4096, 6000)
  const cluster = mapping ? parseReportMapping(mapping) : null
  const sn = cluster ? clusterToSn(cluster) : null
  if (sn) {
    const hosts: string[] = []
    for (const h of snHosts(sn)) if (await d.resolves(h)) hosts.push(h)
    if (hosts.length) return { nodes: hosts, via: 'mapping' }
  }
  return { nodes: [], via: 'none' }
}
