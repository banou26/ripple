// A finished temporary torrent the idle park stopped, started by the person: it seeds until they stop it, through a
// viewer coming and going and through a reload.
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
  added: 0,
}))

const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const seeding = {
    state: 5, paused: false, autoManaged: true, errorCode: 0, totalDone: 4 * MiB, downloadRate: 0, numPeers: 0,
    activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
  }
  const layout = { storageIndex: 0, pieceLength: MiB, numPieces: 4, totalSize: 4 * MiB, contentSize: 4 * MiB, files: [
    { path: 'film.mp4', offset: 0, size: 4 * MiB, pad: false },
  ] }
  const tick = () => { for (const h of engine.queued) engine.live.add(h); engine.queued.clear() }
  setInterval(tick, 250)
  return {
    createSession: async () => fakeSession({
      tick,
      addMagnet: () => { const h = ++engine.added; engine.queued.add(h); return h },
      popAlerts: () => { for (const h of engine.live) engine.registered.add(h); return [] },
      status: (h: number) => (!engine.registered.has(h) ? null
        : engine.paused.has(h) ? { ...seeding, paused: true, autoManaged: false } : seeding),
      files: (h: number) => (engine.registered.has(h) ? layout : null),
      bitfield: (h: number) => (engine.registered.has(h) ? { pieces: new Uint8Array([0xf0]), numPieces: 4, pieceLength: MiB, length: 4 * MiB } : null),
      read: async (_h: number, _file: number, _offset: number, len: number) => new Uint8Array(len),
      pauseTorrent: (h: number) => { engine.paused.add(h); engine.log.push(`pause ${h}`) },
      resumeTorrent: (h: number) => { engine.paused.delete(h); engine.log.push(`resume ${h}`) },
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
  // what a reload finds: two films watched earlier and kept as cache, the second started by the person since
  const entry = (c: string, over: Partial<Persisted> = {}): Persisted => ({
    infoHash: c.repeat(40), magnet: `magnet:?xt=urn:btih:${c.repeat(40)}`, savePath: `/cache/${c.repeat(40)}`,
    addedAt: 1, lastUsedAt: 1, started: true, ephemeral: true, ...over,
  })
  store.set('ripple:torrents', [entry('a'), entry('b', { paused: false, resumed: true })])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const entryOf = (c: string) => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === c.repeat(40))
// two pumps, so anything a message set off has reached the engine
const pumps = () => new Promise((resolve) => setTimeout(resolve, 1_100))

it('keeps seeding a parked temporary torrent the person started, until the person stops it', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  // the reload parks the one nobody started and leaves the one the person started running
  await vi.waitFor(() => expect(engine.log).toEqual(['pause 1']), { timeout: 2_000 })
  await pumps()
  expect(engine.log).toEqual(['pause 1'])

  rig.send({ type: 'resume', handle: 1 })
  await vi.waitFor(() => expect(entryOf('a')).toMatchObject({ paused: false, resumed: true }))
  expect(engine.log).toEqual(['pause 1', 'resume 1'])

  // a page holding it and letting it go is what parks a temporary torrent nobody watches
  for (const h of [1, 2]) {
    rig.send({ type: 'watch', viewer: `page-${h}`, handle: h, fileIndex: 0, fromOffset: 0, held: true })
    rig.send({ type: 'unwatch', viewer: `page-${h}` })
  }
  await pumps()
  expect(engine.log).toEqual(['pause 1', 'resume 1'])

  // the person's Stop, which a viewer then does not undo
  rig.send({ type: 'pause', handle: 1 })
  await vi.waitFor(() => expect(entryOf('a')).toMatchObject({ paused: true }))
  rig.send({ type: 'watch', viewer: 'page-1', handle: 1, fileIndex: 0, fromOffset: 0, held: true })
  rig.send({ type: 'unwatch', viewer: 'page-1' })
  await pumps()
  expect(engine.log).toEqual(['pause 1', 'resume 1', 'pause 1'])

  // moved to the folder, the started one comes back under a new handle and still seeds
  rig.send({ type: 'relocate', infoHash: 'b'.repeat(40), to: 'folder' })
  await vi.waitFor(() => expect(engine.registered.has(3)).toBe(true))
  rig.send({ type: 'watch', viewer: 'page-3', handle: 3, fileIndex: 0, fromOffset: 0, held: true })
  rig.send({ type: 'unwatch', viewer: 'page-3' })
  await pumps()
  expect(engine.log).toEqual(['pause 1', 'resume 1', 'pause 1'])
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)
