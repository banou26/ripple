// A temporary torrent the person started and Ripple deleted for room keeps no Start once it is downloaded again from
// its row: it is the person's own then, so made temporary later, the entry a reload reads says nobody started it.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals, sessions } from '../utils/worker-rig'

const GB = 1_000_000_000
const MiB = 1024 * 1024
const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
const usage = vi.hoisted(() => ({ used: 9.8e9 }))
const engine = vi.hoisted(() => ({ live: new Set<number>(), paused: new Set<number>() }))
const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: usage.used, quota: 10 * GB }),
  root: fakeDir('', [fakeDir('dl', [fakeDir(HASH)])]),
})

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
  let next = 0
  return {
    createSession: async () => fakeSession({
      addMagnet: () => { const h = ++next; engine.live.add(h); return h },
      status: (h: number) => (engine.live.has(h) ? (engine.paused.has(h) ? { ...seeding, paused: true, autoManaged: false } : seeding) : null),
      files: (h: number) => (engine.live.has(h) ? layout : null),
      bitfield: (h: number) => (engine.live.has(h) ? { pieces: new Uint8Array([0xf0]), numPieces: 4, pieceLength: MiB, length: 4 * MiB } : null),
      pauseTorrent: (h: number) => { engine.paused.add(h) },
      resumeTorrent: (h: number) => { engine.paused.delete(h) },
      removeTorrent: (h: number) => { engine.live.delete(h); sessions[0]!.removed.push(h) },
      saveResumeData: async () => new Uint8Array([1]),
      clearStreamWindow: () => {},
      prioritizePieces: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 2 * GB, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  // a temporary torrent the person started, unused for long enough to be the one deleted for room
  const hash = '08ada5a7a6183aae1e09d831df6748d566095a10'
  const entry: Persisted = {
    infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, savePath: `/dl/${hash}`,
    addedAt: 1, lastUsedAt: 1, started: true, paused: false, resumed: true, ephemeral: true,
  }
  store.set('ripple:torrents', [entry])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const entryOf = () => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === HASH)

it('keeps no Start on a temporary torrent deleted for room once it is downloaded again', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  // the CONTROL: it was deleted for room
  await vi.waitFor(() => expect(sessions[0]?.removed).toEqual([1]), { timeout: 5_000 })
  await vi.waitFor(() => expect(entryOf()).toMatchObject({ started: false }))
  usage.used = 1e9

  // the files-missing row's Download, then made temporary again from its menu
  rig.send({ type: 'start', infoHash: HASH })
  await vi.waitFor(() => expect(entryOf()).toMatchObject({ started: true, ephemeral: false }))
  rig.send({ type: 'set-temporary', infoHash: HASH, temporary: true })
  await vi.waitFor(() => expect(entryOf()).toMatchObject({ ephemeral: true }))
  expect(entryOf()).toMatchObject({ resumed: false })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)
