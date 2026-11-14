// A read of bytes a parked temporary torrent has on disk, a picture's or a Save's, is answered and
// leaves it parked, and one a Save makes of bytes not on disk wakes it until the Save is done.
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
  // a read at this offset waits for the test to let it go, as one waiting on its pieces does
  slow: { at: -1, go: () => {} },
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
      read: async (_h: number, _file: number, offset: number, len: number) => {
        if (offset === engine.slow.at) await new Promise<void>((resolve) => { engine.slow.go = resolve })
        return new Uint8Array(len)
      },
      setStreamWindow: () => true,
      pauseTorrent: (h: number) => { engine.paused.add(h); engine.log.push('pause') },
      resumeTorrent: (h: number) => { engine.paused.delete(h); engine.log.push('resume') },
      // libtorrent's check clears a pause itself
      forceRecheck: (h: number) => { engine.paused.delete(h); engine.log.push('recheck') },
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

it('answers a read of bytes a parked temporary torrent has on disk and leaves it parked', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  await vi.waitFor(() => expect(engine.log).toEqual(['pause']), { timeout: 2_000 })

  expect((await read('poster', 0, 0, false)).type).toBe('read-result')
  expect(engine.log).toEqual(['pause'])
  expect((await read('not there', 1, 10 * MiB, false))).toMatchObject({ type: 'read-error', error: 'not downloaded' })
  expect(engine.log).toEqual(['pause'])
  // the library's Save reads with priority and no viewer
  expect((await read('save', 0, 0)).type).toBe('read-result')
  expect(engine.log).toEqual(['pause'])

  // a read that may wait for pieces still wakes it, so the check above can see a wake
  void read('seek', 1, 10 * MiB)
  await vi.waitFor(() => expect(engine.log).toEqual(['pause', 'resume']))
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

// what the worker waits for after the last read with no viewer before it parks the torrent again
const quiet = () => new Promise((resolve) => setTimeout(resolve, 6_500))

it('parks it again once a Save has not read it for a while, and not after each of its reads', async () => {
  // the next chunk of the same Save, while the read that woke it is still fresh
  expect((await read('chunk', 1, 12 * MiB)).type).toBe('read-result')
  expect(engine.log).toEqual(['pause', 'resume'])
  await vi.waitFor(() => expect(engine.log).toEqual(['pause', 'resume', 'pause']), { timeout: 8_000 })
}, 15_000)

it('keeps it awake while the read that woke it waits for its pieces', async () => {
  engine.slow.at = 20 * MiB
  rig.send({ type: 'read', id: 'waiting', handle: 1, fileIndex: 1, offset: 20 * MiB, len: 64 * 1024 })
  await vi.waitFor(() => expect(engine.log).toEqual(['pause', 'resume', 'pause', 'resume']))
  await quiet()
  expect(engine.log).toEqual(['pause', 'resume', 'pause', 'resume'])
  engine.slow.go()
  await vi.waitFor(() => expect(rig.posted.find((m) => m.id === 'waiting')?.type).toBe('read-result'))
  await vi.waitFor(() => expect(engine.log).toEqual(['pause', 'resume', 'pause', 'resume', 'pause']), { timeout: 8_000 })
}, 20_000)

it('leaves it to a player that came meanwhile, and running when the person resumed it', async () => {
  void read('save', 1, 22 * MiB)
  await vi.waitFor(() => expect(engine.log.slice(5)).toEqual(['resume']))
  rig.send({ type: 'watch', viewer: 'player:1', handle: 1, fileIndex: 1, fromOffset: 0 })
  await quiet()
  expect(engine.log.slice(5)).toEqual(['resume'])
  // the player going is what parks it then
  rig.send({ type: 'unwatch', viewer: 'player:1' })
  await vi.waitFor(() => expect(engine.log.slice(5)).toEqual(['resume', 'pause']))

  // not parked when the Save came: a Save of one the person paused and resumed leaves it running
  rig.send({ type: 'pause', handle: 1 })
  rig.send({ type: 'resume', handle: 1 })
  await vi.waitFor(() => expect(engine.log.slice(5)).toEqual(['resume', 'pause', 'pause', 'resume']))
  expect((await read('their save', 1, 24 * MiB)).type).toBe('read-result')
  await quiet()
  expect(engine.log.slice(5)).toEqual(['resume', 'pause', 'pause', 'resume'])
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 30_000)

it('parks it again though a read of a player that has left still waits', async () => {
  // a player closing cancels none of its reads: this one waits for nobody once its player has left, which parks it
  engine.slow.at = 26 * MiB
  rig.send({ type: 'read', id: 'abandoned', handle: 1, fileIndex: 1, offset: 26 * MiB, len: 64 * 1024, viewer: 'player:2' })
  rig.send({ type: 'unwatch', viewer: 'player:2' })
  await vi.waitFor(() => expect(engine.log.slice(9)).toEqual(['pause']))
  expect((await read('one more save', 1, 28 * MiB)).type).toBe('read-result')
  expect(engine.log.slice(9)).toEqual(['pause', 'resume'])
  await vi.waitFor(() => expect(engine.log.slice(9)).toEqual(['pause', 'resume', 'pause']), { timeout: 8_000 })
  engine.slow.go()
  await vi.waitFor(() => expect(rig.posted.find((m) => m.id === 'abandoned')).toBeDefined())
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('leaves it running when the person pauses and resumes it while a Save reads', async () => {
  engine.slow.at = 14 * MiB
  rig.send({ type: 'read', id: 'paused save', handle: 1, fileIndex: 1, offset: 14 * MiB, len: 64 * 1024 })
  await vi.waitFor(() => expect(engine.log.slice(12)).toEqual(['resume']))
  rig.send({ type: 'pause', handle: 1 })
  rig.send({ type: 'resume', handle: 1 })
  await vi.waitFor(() => expect(engine.log.slice(12)).toEqual(['resume', 'pause', 'resume']))
  engine.slow.at = -1
  engine.slow.go()
  // the Save asks again for the chunk the pause refused, and ends
  expect((await read('resumed save', 1, 14 * MiB)).type).toBe('read-result')
  await quiet()
  expect(engine.log.slice(12)).toEqual(['resume', 'pause', 'resume'])
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('leaves a check the person started while a Save reads to run', async () => {
  // a player coming and going parks it again first
  rig.send({ type: 'watch', viewer: 'player:3', handle: 1, fileIndex: 1, fromOffset: 0 })
  rig.send({ type: 'unwatch', viewer: 'player:3' })
  await vi.waitFor(() => expect(engine.log.slice(15)).toEqual(['pause']))
  engine.slow.at = 16 * MiB
  rig.send({ type: 'read', id: 'checked save', handle: 1, fileIndex: 1, offset: 16 * MiB, len: 64 * 1024 })
  await vi.waitFor(() => expect(engine.log.slice(15)).toEqual(['pause', 'resume']))
  rig.send({ type: 'recheck', handle: 1 })
  await vi.waitFor(() => expect(engine.log.slice(15)).toEqual(['pause', 'resume', 'recheck']))
  engine.slow.at = -1
  engine.slow.go()
  expect((await read('save after the check', 1, 16 * MiB)).type).toBe('read-result')
  await quiet()
  expect(engine.log.slice(15)).toEqual(['pause', 'resume', 'recheck'])
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 25_000)
