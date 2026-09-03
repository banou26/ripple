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
// the same shape twice, both 40 hex, so the reservation is the only difference between them
const RESERVED = 'b'.repeat(40)
const CONTROL = 'c'.repeat(40)

const dl = fakeDir('dl', [fakeDir(RESERVED), fakeDir(CONTROL)])

/**
 * The first estimate is held until the test has sent its reservation, and answers a FULL origin.
 *
 * Not a convenience. The budget pass is started at the tail of `init`, unawaited, so it is already
 * running by the time a poll notices `ready`, and a reservation posted after that would miss the
 * sweep it is about; waiting for the ten second interval to bring a second pass is the alternative
 * and costs ten seconds. Holding the pass at its very first await instead is deterministic and free.
 *
 * Full, because `runOrphanSweep` is called from the pass when `isOriginFull`, which is the extra
 * sweep a large copy provokes. Every later call reports the space the sweep gave back, so
 * `settleAfterDelete` sees the drop and returns on its first poll rather than waiting out four
 * seconds of them.
 */
let releaseFirstEstimate = () => {}
const firstEstimate = new Promise<void>((resolve) => { releaseFirstEstimate = resolve })
let estimates = 0
const rig = installWorkerGlobals({
  estimate: async () => {
    if (++estimates === 1) { await firstEstimate; return { usage: 9.8 * GB, quota: QUOTA } }
    return { usage: 6.8 * GB, quota: QUOTA }
  },
  root: fakeDir('', [dl]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return { createSession: async () => fakeSession(), PRIORITY: { skip: 0 }, TORRENT_FLAG: { uploadMode: 1 } }
})
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
    // a macrotask, so every queued command has been handled before the pass is let go
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseFirstEstimate()

    /*
     * A second estimate is asked for only from `settleAfterDelete`, which the pass reaches only when
     * a sweep has FINISHED and removed something. So this waits for the whole pass rather than for
     * the first delete inside it, and until it holds nothing below is evidence of anything.
     */
    await vi.waitFor(() => expect(estimates, 'no sweep ever completed').toBeGreaterThan(1))

    expect(
      dl.removed,
      'the sweep deleted a directory a page had reserved, which is a copy deleted mid-write',
    ).toEqual([CONTROL])
    expect([...dl.children.keys()]).toEqual([RESERVED])
  })
})