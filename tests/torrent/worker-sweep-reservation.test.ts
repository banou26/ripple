import { describe, expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

/**
 * The orphan sweep leaves alone a directory a page said it is writing into.
 *
 * `planSweep` deletes any hash-named child of the save root that no list entry and no live handle
 * claims, recursively, and that is exactly the state a created torrent's directory is in while its
 * bytes are copied into it: the copy runs BEFORE the add, so for the whole of it there is no entry
 * and no handle. A multi-gigabyte copy is also itself what makes the origin read full, which runs an
 * extra sweep, so the window is minutes.
 *
 * `planSweep` is pure and already tested and never had the bug. The bug is in what the worker FEEDS
 * it, so `opfs-sweep.test.ts` stays green when the fold is deleted and the worker is what has to run
 * here. `worker-protocol.test.ts` pins that the message is admitted and dispatched; nothing pinned
 * what the branch does.
 *
 * THE UNRESERVED DIRECTORY IS THE CONTROL AND IT CARRIES THE TEST. "The reserved one is still there"
 * is true for free in every run where no sweep ran at all, so it is asserted only after the identical
 * directory nobody reserved has gone.
 */

const GB = 1_000_000_000
const QUOTA = 10 * GB
const FULL = QUOTA - 32 * 1024 * 1024
// the same shape twice, both 40 hex, so the reservation is the only difference between them
const RESERVED = 'b'.repeat(40)
const CONTROL = 'c'.repeat(40)

const dl = fakeDir('dl', [fakeDir(RESERVED), fakeDir(CONTROL)])

/**
 * A FULL origin until the sweep has given something back, and the space it gave back after.
 *
 * Full, because `runOrphanSweep` is called from the pass when `isOriginFull`, which is the extra
 * sweep a large copy provokes: 32 MiB left, under what the film being watched owes. Nothing is
 * watched until the reservation has been sent, so no pass before then sweeps. The drop afterwards
 * is what lets `settleAfterDelete` return on its first poll rather than waiting out four seconds of
 * them, and the count of estimates read after it says the sweep finished.
 */
let afterSweep = 0
const rig = installWorkerGlobals({
  estimate: async () => {
    if (!dl.removed.length) return { usage: FULL, quota: QUOTA }
    afterSweep++
    return { usage: 6.8 * GB, quota: QUOTA }
  },
  root: fakeDir('', [dl]),
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
  // nothing of the film on disk yet, so it owes its whole size
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => ({
  // an empty library, so every hash-named directory down there is an orphan unless something claims it
  get: async () => undefined,
  set: async () => {},
  del: async () => {},
  update: async () => {},
}))

describe('the orphan sweep and a directory a page is writing into', () => {
  it('keeps the reserved one, and takes the identical one nobody reserved', async () => {
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready'), 'the engine never started').toHaveLength(1))

    rig.send({ type: 'reserve-storage', infoHash: RESERVED, on: true })
    rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`, ephemeral: true })
    await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
    expect(dl.removed, 'a pass swept before anything was watched').toEqual([])
    rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })

    /*
     * An estimate after a removal is asked for only from `settleAfterDelete`, which the pass reaches
     * only when a sweep has FINISHED and removed something. So this waits for the whole pass rather
     * than for the first delete inside it, and until it holds nothing below is evidence of anything.
     */
    await vi.waitFor(() => expect(afterSweep, 'no sweep ever completed').toBeGreaterThan(0))

    expect(
      dl.removed,
      'the sweep deleted a directory a page had reserved, which is a copy deleted mid-write',
    ).toEqual([CONTROL])
    expect([...dl.children.keys()]).toEqual([RESERVED])
  })
})