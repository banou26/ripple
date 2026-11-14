// A picture read of a parked temporary torrent is answered from disk and leaves it parked.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024

const engine = vi.hoisted(() => ({
  queued: new Set<number>(),
  live: new Set<number>(),
  registered: new Set<number>(),
  paused: new Set<number>(),
  log: [] as string[],
}))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const running = {
    state: 3, paused: false, autoManaged: true, errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: 0,
    activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
  }
  // a poster in the first piece, which is on disk, and a film after it, which is not
  const layout = { storageIndex: 0, pieceLength: MiB, numPieces: 30, totalSize: 30 * MiB, contentSize: 30 * MiB, files: [
    { path: 'poster.jpg', offset: 0, size: MiB, pad: false },
    { path: 'film.mp4', offset: MiB, size: 29 * MiB, pad: false },
  ] }
  const tick = () => { for (const h of engine.queued) engine.live.add(h); engine.queued.clear() }
  setInterval(tick, 250)
  return {
    createSession: async () => fakeSession({
      tick,
      addMagnet: () => { engine.queued.add(1); return 1 },
      popAlerts: () => { for (const h of engine.live) engine.registered.add(h); return [] },
      status: (h: number) => (!engine.registered.has(h) ? null
        : engine.paused.has(h) ? { ...running, paused: true, autoManaged: false } : running),
      files: (h: number) => (engine.registered.has(h) ? layout : null),
      bitfield: (h: number) => (engine.registered.has(h) ? { pieces: new Uint8Array([0x80, 0, 0, 0]), numPieces: 30, pieceLength: MiB, length: 30 * MiB } : null),
      read: async (_h: number, _file: number, _offset: number, len: number) => new Uint8Array(len),
      pauseTorrent: (h: number) => { engine.paused.add(h); engine.log.push('pause') },
      resumeTorrent: (h: number) => { engine.paused.delete(h); engine.log.push('resume') },
      saveResumeData: async () => new Uint8Array([1]),
      setDownloadLimit: () => {},
      setUploadLimit: () => {},
      clearStreamWindow: () => {},
      prioritizePieces: () => {},
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
  // what a reload finds: a film watched earlier and kept as cache
  const entry: Persisted = { infoHash: 'e'.repeat(40), magnet: `magnet:?xt=urn:btih:${'e'.repeat(40)}`, savePath: `/cache/${'e'.repeat(40)}`, addedAt: 1, lastUsedAt: 1, started: true, ephemeral: true }
  const store = new Map<string, unknown>([['ripple:torrents', [entry]]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const read = async (id: string, fileIndex: number, offset: number, prioritize?: boolean) => {
  rig.send({ type: 'read', id, handle: 1, fileIndex, offset, len: 64 * 1024, ...(prioritize === undefined ? {} : { prioritize }) })
  await vi.waitFor(() => expect(rig.posted.find((m) => m.id === id)).toBeDefined())
  // two pumps, so anything the read set off has reached the engine
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  return rig.posted.find((m) => m.id === id)!
}

it('answers a picture read of a parked temporary torrent from disk and leaves it parked', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  await vi.waitFor(() => expect(engine.log).toEqual(['pause']), { timeout: 2_000 })

  expect((await read('poster', 0, 0, false)).type).toBe('read-result')
  expect(engine.log).toEqual(['pause'])
  expect((await read('not there', 1, 10 * MiB, false))).toMatchObject({ type: 'read-error', error: 'not downloaded' })
  expect(engine.log).toEqual(['pause'])

  // a read that may wait for pieces still wakes it, so the check above can see a wake
  void read('seek', 1, 10 * MiB)
  await vi.waitFor(() => expect(engine.log).toEqual(['pause', 'resume']))
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)
