// A plugin's `peers` and `trackers` calls ask for one torrent's detail without moving `inspecting`, so an open
// details panel keeps showing its own torrent's peers and trackers.
import type { PeerInfo, TrackerInfo } from 'libtorrent-wasm'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const OPEN = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })

const peer = (endpoint: string): PeerInfo => ({
  endpoint,
  client: 'qBittorrent 5.0',
  downloadRate: 1024,
  uploadRate: 512,
  totalDownload: 4096,
  totalUpload: 2048,
  progress: 0.5,
  flags: 0,
  source: 0,
  transport: 'tcp',
  localConnection: false,
} as unknown as PeerInfo)

const tracker = (url: string, fails = 0): TrackerInfo => ({
  url,
  message: 'secret-tracker-msg',
  tier: 0,
  fails,
  updating: false,
  verified: fails === 0,
  nextAnnounceIn: 60,
  seeders: 1,
  leechers: 0,
  downloaded: 0,
})

const peersByHandle: Record<number, PeerInfo[]> = {
  1: [peer('198.51.100.1:6881')],
  2: [peer('203.0.113.2:51413')],
}
const trackersByHandle: Record<number, TrackerInfo[]> = {
  1: [tracker('https://open.example/announce')],
  2: [tracker('https://private.example/secret-passkey/announce')],
}

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => ({
      ...fakeSession(),
      peers: async (h: number) => peersByHandle[h] ?? [],
      lastPeers: (h: number) => peersByHandle[h] ?? [],
      trackers: async (h: number) => trackersByHandle[h] ?? [],
      lastTrackers: (h: number) => trackersByHandle[h] ?? [],
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
    PEER_FLAG: { localConnection: 1 },
  }
})
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('answers per-asker torrent-detail for another torrent while keeping the inspected panel on its own torrent', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${OPEN}` })
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${OTHER}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2))

  rig.send({ type: 'inspect', handle: 1 })
  await vi.waitFor(() => expect((rig.of('state').at(-1)?.detail as { handle?: number } | undefined)?.handle).toBe(1))

  const beforeStates = rig.of('state').length
  rig.send({ type: 'torrent-detail', id: 42, handle: 2 })
  await vi.waitFor(() => expect(rig.of('answer').find((a) => a.id === 42)).toBeDefined())
  const answer = rig.of('answer').find((a) => a.id === 42) as unknown as { value: { peers: PeerInfo[], trackers: TrackerInfo[] } }
  expect(answer.value.peers.map((p) => p.endpoint)).toEqual(['203.0.113.2:51413'])
  expect(answer.value.trackers.map((t) => t.url)).toEqual(['https://private.example/secret-passkey/announce'])

  // an unknown handle answers null without error
  rig.send({ type: 'torrent-detail', id: 43, handle: 999 })
  await vi.waitFor(() => expect(rig.of('answer').find((a) => a.id === 43)).toBeDefined())
  expect(rig.of('answer').find((a) => a.id === 43)!.value).toBeNull()

  // a handle removed before torrent-detail answers returns null
  rig.send({ type: 'remove', handle: 2, deleteFiles: false })
  await vi.waitFor(() => expect(rig.of('state').at(-1)?.torrents).toHaveLength(1))
  rig.send({ type: 'torrent-detail', id: 44, handle: 2 })
  await vi.waitFor(() => expect(rig.of('answer').find((a) => a.id === 44)).toBeDefined())
  expect(rig.of('answer').find((a) => a.id === 44)!.value).toBeNull()

  // subsequent state ticks still carry handle 1's detail for the open details panel
  await vi.waitFor(() => expect(rig.of('state').length).toBeGreaterThan(beforeStates))
  for (const state of rig.of('state').slice(beforeStates)) {
    const detail = state.detail as { handle: number, peers: PeerInfo[] } | undefined
    expect(detail?.handle).toBe(1)
    expect(detail?.peers.map((p) => p.endpoint)).toEqual(['198.51.100.1:6881'])
  }
  expect(rig.of('worker-error')).toEqual([])
})
