import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

/**
 * A resume blob carries the download limit in force when it was saved, so a blob saved while a
 * window trickled brings the trickle back on a reload. This engine does what libtorrent-wasm 0.3.21
 * was measured doing (node, 2026-10-23): an add with a blob takes the blob's limit, and a limit set
 * before the alert pump has registered the handle is dropped without a word.
 */

const TRICKLE = 16 * 1024
const CAP = 500_000
const CACHED = 'c'.repeat(40)
const CAPPED = 'b'.repeat(40)
const UPLOAD_CAPPED = 'a'.repeat(40)

const engine = vi.hoisted(() => ({
  added: [] as number[],
  registered: new Set<number>(),
  limit: new Map<number, number>(),
}))

// the field as libtorrent writes it, -1 being unlimited
const blobLimited = (limit: number) => new TextEncoder().encode(`d19:download_rate_limiti${limit}ee`)
const limitIn = (blob: Uint8Array) => Number(/download_rate_limiti(-?\d+)e/.exec(new TextDecoder().decode(blob))?.[1] ?? -1)

const entry = (infoHash: string, savePath: string, more: Partial<Persisted> = {}): Persisted => ({
  infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath, addedAt: 1, lastUsedAt: 1, started: true, ...more,
})

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }),
  root: fakeDir('', [fakeDir('cache', [fakeDir(CACHED)]), fakeDir('dl', [fakeDir(CAPPED), fakeDir(UPLOAD_CAPPED)])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const running = {
    state: 3, paused: false, autoManaged: true, errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: 0,
    activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
  }
  return {
    createSession: async () => fakeSession({
      addTorrentWithResume: (blob: Uint8Array) => {
        const h = engine.added.length + 1
        engine.added.push(h)
        engine.limit.set(h, limitIn(blob))
        return h
      },
      popAlerts: () => { for (const h of engine.added) engine.registered.add(h); return [] },
      status: (h: number) => (engine.registered.has(h) ? running : null),
      setDownloadLimit: (h: number, limit: number) => { if (engine.registered.has(h)) engine.limit.set(h, limit) },
      setUploadLimit: () => {},
      pauseTorrent: () => {},
      resumeTorrent: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>([
    ['ripple:torrents', [
      entry(CACHED, '/cache/' + CACHED, { ephemeral: true }),
      entry(UPLOAD_CAPPED, '/dl/' + UPLOAD_CAPPED, { uploadLimit: CAP }),
      entry(CAPPED, '/dl/' + CAPPED, { downloadLimit: CAP }),
    ]],
    ['ripple:resume:' + CACHED, blobLimited(TRICKLE)],
    ['ripple:resume:' + UPLOAD_CAPPED, blobLimited(TRICKLE)],
    ['ripple:resume:' + CAPPED, blobLimited(TRICKLE)],
  ])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('lifts the trickle a resume blob brings back, to the limit the list holds or to none', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  expect([...engine.limit.values()], 'each blob restores its own limit').toEqual([TRICKLE, TRICKLE, TRICKLE])
  // THE CONTROL: a limit the list holds reaches the engine once the pump has registered the handles
  await vi.waitFor(() => expect(engine.limit.get(3)).toBe(CAP))
  expect(engine.limit.get(1), 'a cache torrent, which holds no limit').toBe(0)
  expect(engine.limit.get(2), 'a torrent with an upload limit alone').toBe(0)
})
