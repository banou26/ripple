import type { Persisted } from '../../src/torrent/library'

import { describe, expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

/**
 * A new cache torrent is kept under `/cache`, and the orphan sweep accounts for that root too.
 *
 * Two things the sweep has to get right about it: a library entry under `/cache` is attributable by
 * its directory name, so it must not stop the `/dl` walk from clearing what nobody owns there, and a
 * hash directory under `/cache` that nothing lists is an orphan like one under `/dl`.
 */

const GB = 1_000_000_000
const QUOTA = 10 * GB
const FULL = QUOTA - 32 * 1024 * 1024
const KEPT = 'a'.repeat(40)
const ORPHAN = 'b'.repeat(40)
const FILM = 'c'.repeat(40)

const kept: Persisted = {
  infoHash: KEPT,
  magnet: 'magnet:?xt=urn:btih:' + KEPT,
  savePath: '/cache/' + KEPT,
  addedAt: 1,
  started: false,
  ephemeral: true,
}

const state = vi.hoisted(() => ({ list: [] as unknown[] }))

const dl = fakeDir('dl', [fakeDir('Stray Release')])
const cache = fakeDir('cache', [fakeDir(KEPT), fakeDir(ORPHAN)])
let afterSweep = 0
const rig = installWorkerGlobals({
  estimate: async () => {
    if (!dl.removed.length && !cache.removed.length) return { usage: FULL, quota: QUOTA }
    afterSweep++
    return { usage: 5 * GB, quota: QUOTA }
  },
  root: fakeDir('', [dl, cache]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      files: () => ({
        storageIndex: 0, pieceLength: 1_048_576, numPieces: 954, totalSize: GB, contentSize: GB,
        files: [{ path: 'film.mkv', offset: 0, size: GB, pad: false }],
      }),
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
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
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => key === 'ripple:torrents' ? state.list : store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => {
      if (key === 'ripple:torrents') state.list = fn(state.list) as unknown[]
      else store.set(key, fn(store.get(key)))
    },
  }
})

describe('the cache root', () => {
  it('takes a new cache torrent, and the sweep clears both roots around what the list keeps there', async () => {
    state.list = [kept]
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready'), 'the engine never started').toHaveLength(1))

    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM, ephemeral: true })
    await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
    expect((state.list as Persisted[]).find((e) => e.infoHash === FILM)?.savePath).toBe('/cache/' + FILM)

    // watched on a full origin, which is what runs a sweep from the pass
    rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })
    await vi.waitFor(() => expect(afterSweep, 'no sweep ever completed').toBeGreaterThan(0))

    expect(cache.removed, 'an unlisted hash directory under /cache is an orphan').toEqual([ORPHAN])
    expect(dl.removed, 'a /cache entry stopped the /dl walk from clearing what nobody owns').toEqual(['Stray Release'])
    expect([...cache.children.keys()]).toEqual([KEPT])
  })

  it('leaves a library add where it always was', async () => {
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + 'd'.repeat(40) })
    await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2))
    expect((state.list as Persisted[]).find((e) => e.infoHash === 'd'.repeat(40))?.savePath).toBe('/dl/' + 'd'.repeat(40))
  })
})
