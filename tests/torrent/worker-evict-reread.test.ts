import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * A pass asks again what the film owes after each eviction, so a tail that landed meanwhile stops it.
 *
 * The film's tail is written seconds after it opens, and the first eviction is what makes room for
 * it, so it can land while that delete settles. From then on the film owes nothing, and a pass still
 * reserving its whole size would give up the rest of the cache for room nobody needs: here the
 * 1.2 GB and 1 GB entries, on top of the 5.1 GB one that was enough.
 */

const MiB = 1024 * 1024
const GB = 1_000_000_000
const LIMIT = 10_737_418_240
const FILM = 5 * GB
const FILM_HASH = 'f'.repeat(40)

const cached = [
  { hash: 'a'.repeat(40), bytes: 5.1 * GB },
  { hash: 'b'.repeat(40), bytes: 1.2 * GB },
  { hash: 'c'.repeat(40), bytes: 1 * GB },
]

// the restored entries are handles 1 to 3, in this order, and the film is handle 4
const state = vi.hoisted(() => ({ reporting: false, windowed: false }))
const removed = () => sessions[0]?.removed ?? []
const filmOnDisk = () => removed().length ? FILM : 16 * MiB

const entries: Persisted[] = cached.map(({ hash }, i) => ({
  infoHash: hash,
  magnet: 'magnet:?xt=urn:btih:' + hash,
  savePath: '/dl/' + hash,
  addedAt: i + 1,
  lastUsedAt: i + 1,
  started: true,
  ephemeral: true,
}))

const rig = installWorkerGlobals({
  // nothing until the film is watched, so the passes before it give nothing up
  estimate: async () => state.reporting
    ? { usage: cached.filter((_, i) => !removed().includes(i + 1)).reduce((sum, c) => sum + c.bytes, 0) + filmOnDisk(), quota: LIMIT }
    : {},
  root: fakeDir('', [fakeDir('dl', [...cached.map(({ hash }) => fakeDir(hash)), fakeDir(FILM_HASH)])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      files: (h: number) => h === 4 ? {
        storageIndex: 0, pieceLength: 8 * MiB, numPieces: 597, totalSize: FILM, contentSize: FILM,
        files: [{ path: 'film.mkv', offset: 0, size: FILM, pad: false }],
      } : null,
      setStreamWindow: () => { state.windowed = true; return true },
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({
    usageOf: async (savePath: string) => savePath.endsWith(FILM_HASH)
      ? filmOnDisk()
      : cached.find((c) => savePath.endsWith(c.hash))?.bytes ?? 0,
    refusedFile: () => undefined,
  }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>([['ripple:torrents', entries]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('stops giving up cache once the film it made room for owes nothing', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  rig.send({ type: 'watch', viewer: 'player', handle: 4, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(state.windowed, 'the film never attached').toBe(true))

  state.reporting = true
  // the next add's pass is the one that sees the room
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + 'e'.repeat(40) })
  await vi.waitFor(() => expect(removed(), 'nothing was given up for the film').toEqual([1]), { timeout: 2_000 })
  // long enough for every further delete the pass could have settled
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  expect(removed()).toEqual([1])
  expect(rig.of('worker-error')).toEqual([])
})
