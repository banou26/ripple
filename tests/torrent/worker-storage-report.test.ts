import { describe, expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * "Out of storage space" is owed on every exit from the budget pass, not just the one that worked.
 *
 * `reportSpace` used to sit on the happy path alone and there are three ways out above it: an origin
 * that cannot be measured, a delete whose effect cannot be read back, and a throw anywhere in the
 * pass. All three skipped the one call that raises the notice a player shows instead of stalling
 * with nothing on screen, and a pass that fails part way is exactly when a full origin most needs
 * saying. The answer is a `finally`, which is not a value any pure helper can return, so the worker's
 * own control flow is the subject and the worker is what this runs.
 *
 * The failure is injected the way a full origin really presents it: the library read throws. Nothing
 * guards `loadList`, and `runStorageBudget` awaits it inside the try after it has already measured
 * the origin, so the pass dies holding an honest figure. That is the case the `finally` exists for.
 */

const GB = 1_000_000_000
const USED = 9.8 * GB
const QUOTA = 10 * GB

// installed before the worker is imported, because it reads `self` and `navigator` at module scope
const rig = installWorkerGlobals({ estimate: async () => ({ usage: USED, quota: QUOTA }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return { createSession: async () => fakeSession(), PRIORITY: { skip: 0 }, TORRENT_FLAG: { uploadMode: 1 } }
})
vi.mock('idb-keyval', () => ({
  // exactly the shape a full origin presents: the read-modify-write store refuses
  get: async (key: string) => {
    if (key === 'ripple:torrents') throw new Error('QuotaExceededError')
    return undefined
  },
  set: async () => {},
  del: async () => {},
  update: async () => {},
}))

describe('a storage budget pass that fails part way', () => {
  it('still reports the origin it had already measured', async () => {
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready'), 'the engine never started').toHaveLength(1))

    /*
     * THE CONTROL, and the assertion below is worth nothing without it. A pass that never ran posts
     * no message either, so "there is no storage-full" and "the fix works" are the same observation
     * until something proves the pass got as far as failing.
     */
    await vi.waitFor(() => expect(
      rig.of('worker-error').filter((m) => String((m.args as string[])?.[0]).includes('storage budget pass failed')),
      'the budget pass never failed, so nothing below is evidence',
    ).toHaveLength(1))

    expect(rig.of('storage-full')).toEqual([
      { type: 'storage-full', full: true, usedBytes: USED, limitBytes: QUOTA },
    ])
  })
})