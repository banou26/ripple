import type { Persisted } from '../../src/torrent/library'

import { describe, expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * The worker writes `created` onto the library entry, which is the one hop of the six with no seam.
 *
 * The flag travels from the create dialog to the auto-save mirror through the client, this handler,
 * the stored entry and the row built from it, and the mirror asks it whether a torrent's bytes are
 * the person's own. `created-flag.browser.test.tsx` covers the client hop and the row hop against
 * fakes; this is the middle one, where the engine's own dispatch decides what gets stored. Deleting
 * it left the whole suite green, and the cost of that is the person's pick written into their save
 * folder a third time.
 *
 * The control is in the same run rather than in another file: a second, ordinary add through the same
 * handler must NOT come out marked, or an entry builder that hard-coded the flag would pass.
 */

const GB = 1_000_000_000
const CREATED = 'b'.repeat(40)
const ORDINARY = 'c'.repeat(40)

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 1 * GB, quota: 10 * GB }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const hashes = [CREATED, ORDINARY]
  return {
    createSession: async () => fakeSession({
      // handles count from 1, so each add answers with its own hash on the first poll
      infohash: (handle: number) => hashes[handle - 1] ?? null,
      infohashV2: () => null,
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  // enough of a store that `upsertList`'s read-modify-write behaves the way IndexedDB's does
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const add = (infoHash: string, over: Record<string, unknown>) => ({
  type: 'add-torrent-file',
  bytes: new Uint8Array([1, 2, 3]),
  savePath: '/dl/' + infoHash,
  ephemeral: false,
  paused: false,
  ...over,
})

describe('the entry the worker writes for a torrent made on this device', () => {
  it('marks it created, and marks an ordinary add in the same session not', async () => {
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready'), 'the engine never started').toHaveLength(1))

    rig.send(add(CREATED, { saveTo: 'browser', created: true }))
    rig.send(add(ORDINARY, {}))
    await vi.waitFor(() => expect(rig.of('added'), 'the adds never landed').toHaveLength(2))

    const stored = (rig.of('list').at(-1)!.list as Persisted[])
    const byHash = new Map(stored.map((e) => [e.infoHash, e]))

    expect(byHash.get(CREATED)).toMatchObject({ saveTo: 'browser', created: true })
    // the control, which is what stops a builder that always writes the flag from passing
    expect(byHash.get(ORDINARY)?.created, "an ordinary download was marked as the person's own").toBeUndefined()
  })
})