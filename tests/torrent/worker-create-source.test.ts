import type { Persisted } from '../../src/torrent/library'

import { describe, expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * Whether a created source can be re-opened travels WITH the entry, or the entry renders nowhere.
 *
 * `saveTo: 'source'` means the bytes live outside the origin and the page holds the way back to
 * them. Everything downstream trusts that: `use-torrents.ts` keeps a source entry out of the live
 * rows, the ghosts and the starting rows alike, because the waiting list is meant to carry it and
 * offer the access button. That list reads the handle the page stored, so an entry with no handle
 * falls out of it too, and an entry in NO list has no row and therefore no way to be removed. The
 * person is left with a torrent in their library that they cannot see and cannot delete.
 *
 * Reachable on the shipping Firefox path before this: a pick that cannot be re-opened whose copy
 * into browser storage does not FIT publishes exactly that entry, and "does not fit" is ordinary.
 *
 * So the page tells the worker whether it managed to keep a handle, and `started: false` is what
 * sends the entry to the ghost branch instead, where it carries its name and offers "Remove from the
 * library". The control is in the same run: an ordinary create-source must stay `started: true`, or
 * a handler that hard-coded false would pass while making every created torrent a ghost.
 */

const GB = 1_000_000_000
const KEPT = 'd'.repeat(40)
const LOST = 'e'.repeat(40)
const OLD = 'f'.repeat(40)
/** an ordinary library entry, so the refusal above can be shown to be about SOURCES */
const PLAIN = 'a'.repeat(40)

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 1 * GB, quota: 10 * GB }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const hashes = [KEPT, LOST, OLD, PLAIN]
  return {
    createSession: async () => fakeSession({
      infohash: (handle: number) => hashes[handle - 1] ?? null,
      infohashV2: () => null,
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const create = (infoHash: string, over: Record<string, unknown>) => ({
  type: 'create-source',
  infoHash,
  magnet: 'magnet:?xt=urn:btih:' + infoHash,
  bytes: new Uint8Array([1, 2, 3]),
  // a real entry, since a message with nothing openable in it is refused before any of this
  handles: [{ kind: 'file', name: 'a.mkv' }],
  name: 'Pack',
  size: 1_000,
  format: 'v1',
  files: [{ name: 'Pack/a.mkv', size: 1_000 }],
  ...over,
})

describe('the entry the worker writes for a torrent created from a pick', () => {
  it('marks a source it cannot re-open as not started, so the list can still show it', async () => {
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready'), 'the engine never started').toHaveLength(1))

    // an ordinary download in the same library, so the refusal can be shown to be about sources
    rig.send({
      type: 'add-magnet',
      magnet: 'magnet:?xt=urn:btih:' + PLAIN,
      savePath: '/dl/' + PLAIN,
      ephemeral: false,
      paused: false,
    })
    rig.send(create(KEPT, { reopenable: true }))
    rig.send(create(LOST, { reopenable: false }))
    // an older page sends no flag at all, and must keep the behaviour it had rather than vanish
    rig.send(create(OLD, {}))
    await vi.waitFor(() => expect(rig.of('added'), 'the creates never landed').toHaveLength(4))

    const stored = rig.of('list').at(-1)!.list as Persisted[]
    const byHash = new Map(stored.map((entry) => [entry.infoHash, entry]))

    expect(byHash.get(LOST)).toMatchObject({ saveTo: 'source', started: false })
    // the control: a source whose handle WAS kept is an ordinary running torrent
    expect(byHash.get(KEPT), 'a re-openable source was hidden as a ghost').toMatchObject({
      saveTo: 'source', started: true,
    })
    // absent means true, so a page that predates the flag keeps the behaviour it had
    expect(byHash.get(OLD)).toMatchObject({ saveTo: 'source', started: true })

    /*
     * AND THE SECOND LOCK: pressing Download on the ghost this creates must not add the torrent.
     *
     * Its bytes were never in a swarm and its savePath is a key into handles this worker does not
     * have, so adding it throws inside the storage on the first read: a fatal disk error, a red row
     * backing off to five minutes, and `started: true` written back, which hides the entry again
     * with the Remove option that was on its row gone with it. The UI no longer offers the button;
     * this is what makes a message from a stale tab harmless too.
     */
    rig.send({ type: 'start', infoHash: LOST })
    await vi.waitFor(() => expect(rig.of('add-failed')).toHaveLength(1))
    expect(rig.of('add-failed')[0]!.message).toMatch(/made from files on this device/)

    /*
     * And the control, which is what stops a handler that refused EVERY start from passing.
     *
     * `start` on an ordinary entry re-adds it and posts state; it must not post a refusal. Waiting
     * for that state and then reading the refusal count is what makes the absence meaningful, since
     * asserting an absence with nothing awaited would pass before the handler had run at all.
     */
    const statesBefore = rig.of('state').length
    rig.send({ type: 'start', infoHash: PLAIN })
    await vi.waitFor(() => expect(rig.of('state').length).toBeGreaterThan(statesBefore))
    expect(rig.of('add-failed'), 'an ordinary library entry was refused too').toHaveLength(1)
  })
})
