import type { Persisted } from '../../src/torrent/library'

import { describe, expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals, sessions } from '../utils/worker-rig'

const GB = 1_000_000_000
const USED = 9.8 * GB
const QUOTA = 10 * GB
const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'

const entry: Persisted = {
  infoHash: HASH,
  magnet: 'magnet:?xt=urn:btih:' + HASH,
  savePath: '/dl/' + HASH,
  addedAt: 1,
  lastUsedAt: 1,
  started: true,
  ephemeral: true,
}

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: USED, quota: QUOTA }),
  root: fakeDir('', [fakeDir('dl', [fakeDir(HASH)])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return { createSession: async () => fakeSession(), PRIORITY: { skip: 0 }, TORRENT_FLAG: { uploadMode: 1 } }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  // enough on disk to be worth taking, which is what makes the entry a real candidate
  createHybridStorage: () => ({ usageOf: async () => 2 * GB }),
}))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => (key === 'ripple:torrents' ? [{ ...entry }] : undefined),
  set: async () => {},
  del: async () => {},
  // the read-modify-write `releaseStorage` does AFTER the bytes are gone, refusing the way a full
  // origin's IndexedDB refuses
  update: async () => { throw new Error('QuotaExceededError') },
}))

/**
 * A pass that frees a torrent and then falls over does not announce a full origin.
 *
 * Reporting from `finally` fixed one hole and opened another. `measured` held the figure taken
 * BEFORE the delete, and `releaseStorage` awaits `patchList`, which is an IndexedDB read-modify-write
 * and so is exactly the write that fails on a full origin. A throw there escapes with the bytes
 * already gone and the pre-delete figure still in hand, so the `finally` announced "Out of storage
 * space" having just given up a torrent's worth of room.
 *
 * The fix is a statement ORDER across an await: `measured = null` above the evict rather than below
 * it. Nothing pure can hold that, and a Playwright test would have to make an IndexedDB write fail
 * midway through a real eviction, which is not arrangeable from a page. So this drives the worker.
 */
describe('a budget pass whose eviction cannot be written back', () => {
  it('says nothing about the origin, because it has just freed a torrent', async () => {
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready'), 'the engine never started').toHaveLength(1))

    /*
     * THE CONTROL, first, because the assertion under it is satisfied for free by every run where
     * the pass never got that far. An earlier version of this test passed vacuously for exactly that
     * reason: the session mock was missing `files()`, `snapshot()` threw, `init` died before the
     * first pass and the absence of a message meant nothing at all.
     */
    await vi.waitFor(() => expect(
      sessions[0]?.removed,
      'nothing was ever evicted, so nothing below is evidence',
    ).toEqual([1]))
    await vi.waitFor(() => expect(
      rig.of('worker-error').filter((m) => String((m.args as string[])?.[0]).includes('storage budget pass failed')),
      'the write-back never failed, so the pass did not reach the case this is about',
    ).toHaveLength(1))

    expect(rig.of('storage-full'), 'a full origin was announced with the bytes already given back').toEqual([])
  })
})