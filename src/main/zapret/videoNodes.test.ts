import { describe, expect, it } from 'vitest'
import {
  clusterToSn,
  findVideoNodes,
  nodesFromPage,
  parseReportMapping,
  snHosts,
  type VideoNodeDeps
} from './videoNodes'

describe('report_mapping → the video node', () => {
  it('the cluster name converts to the sn- name of real nodes (checked on Beeline 26.11.2026)', () => {
    // report_mapping said «vimpelcom-voz2»; the player there uses …-8v1l / …-n8vs
    expect(clusterToSn('vimpelcom-voz2')).toBe('8ph2xajvh-8v1l')
    expect(clusterToSn('vimpelcom-svo3')).toBe('8ph2xajvh-n8vs')
    expect(clusterToSn('VIMPELCOM')).toBe('8ph2xajvh')
    expect(clusterToSn('bad name!')).toBeNull()
    expect(clusterToSn('a'.repeat(41))).toBeNull()
    // a bijection: every character has its own image
    const all = '0123456789abcdefghijklmnopqrstuvwxyz'
    expect(new Set([...(clusterToSn(all) ?? '')]).size).toBe(36)
  })

  it('reads the cluster from the answer', () => {
    expect(parseReportMapping('109.72.228.10 => vimpelcom-voz2 (109.72.228.0/23)\n')).toBe(
      'vimpelcom-voz2'
    )
    expect(parseReportMapping('<html>no</html>')).toBeNull()
    expect(snHosts('8ph2xajvh-8v1l')).toEqual([
      'rr1---sn-8ph2xajvh-8v1l.googlevideo.com',
      'rr2---sn-8ph2xajvh-8v1l.googlevideo.com'
    ])
  })

  it('the watch page: the nodes it names, most mentioned first', () => {
    const page =
      '"url":"https://rr2---sn-8ph2xajvh-n8vs.googlevideo.com/videoplayback?a"'.repeat(3) +
      'https:\\/\\/rr1---sn-8ph2xajvh-8v1s.googlevideo.com\\/x ' +
      'rr2---sn-8ph2xajvh-n8vs.googlevideo.com rr9---sn-evil..googlevideo.com'
    expect(nodesFromPage(page)).toEqual([
      'rr2---sn-8ph2xajvh-n8vs.googlevideo.com',
      'rr1---sn-8ph2xajvh-8v1s.googlevideo.com'
    ])
    expect(nodesFromPage('nothing here')).toEqual([])
  })
})

describe('findVideoNodes', () => {
  const deps = (o: { page?: string | null; mapping?: string | null; resolves?: string[] }) => {
    const asked: string[] = []
    const d: VideoNodeDeps = {
      get: async (host, path) => {
        asked.push(`${host}${path}`)
        return host === 'www.youtube.com' ? (o.page ?? null) : (o.mapping ?? null)
      },
      resolves: async (h) => (o.resolves ?? []).includes(h)
    }
    return { d, asked }
  }

  it('the watch page first', async () => {
    const { d, asked } = deps({ page: 'x rr3---sn-nvm-cxb6.googlevideo.com y' })
    expect(await findVideoNodes(d)).toEqual({
      nodes: ['rr3---sn-nvm-cxb6.googlevideo.com'],
      via: 'page'
    })
    expect(asked).toContain('www.youtube.com/watch?v=jNQXAC9IVRw')
  })

  it('0.7.2: the page nodes AND report_mapping ones (a pick alternates between them)', async () => {
    const { d } = deps({
      page: 'x rr3---sn-nvm-cxb6.googlevideo.com y',
      mapping: '1.2.3.4 => vimpelcom-voz2 (1.2.3.0/24)',
      resolves: ['rr1---sn-8ph2xajvh-8v1l.googlevideo.com', 'rr2---sn-8ph2xajvh-8v1l.googlevideo.com']
    })
    expect(await findVideoNodes(d)).toEqual({
      nodes: [
        'rr3---sn-nvm-cxb6.googlevideo.com',
        'rr1---sn-8ph2xajvh-8v1l.googlevideo.com',
        'rr2---sn-8ph2xajvh-8v1l.googlevideo.com'
      ],
      via: 'both'
    })
  })

  it('no page: report_mapping → rr1 / rr2 of the sn- name, only those that resolve', async () => {
    const { d } = deps({
      page: null,
      mapping: '1.2.3.4 => vimpelcom-voz2 (1.2.3.0/24)',
      resolves: ['rr1---sn-8ph2xajvh-8v1l.googlevideo.com']
    })
    expect(await findVideoNodes(d)).toEqual({
      nodes: ['rr1---sn-8ph2xajvh-8v1l.googlevideo.com'],
      via: 'mapping'
    })
  })

  it('nothing found → [] (YouTube is not «verified» then)', async () => {
    const { d } = deps({ page: '<html></html>', mapping: null })
    expect(await findVideoNodes(d)).toEqual({ nodes: [], via: 'none' })
  })
})
