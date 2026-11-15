import type { StorageBackend } from 'libtorrent-wasm/types'

import { expect, it, vi } from 'vitest'

import { fakeDir, fakeFile, installWorkerGlobals } from '../utils/worker-rig'

/**
 * The details panel's browser storage figure is the open torrent's own.
 *
 * Every torrent added from a .torrent shares one save path, so a figure read by save path would be the one mounted
 * there last. The two here differ in size, and each file on disk differs from its size in the torrent, so only a
 * measure of the torrent's own files can give both answers.
 */

const HASHES = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]
const LAYOUTS = [
  [{ path: 'Small/s.mkv', size: 4_000 }],
  [{ path: 'Large/l.mkv', size: 80_000 }, { path: 'Large/l.srt', size: 600 }],
  [{ path: 'Folder/f.mkv', size: 9_000 }],
]
// libtorrent's storage ids are its own, never the handles
const storageOf = (handle: number) => 10 + handle

const small = fakeDir('Small', [fakeFile('s.mkv', 3_000)])
const large = fakeDir('Large', [fakeFile('l.mkv', 70_000), fakeFile('l.srt', 500)])
const rig = installWorkerGlobals({
  estimate: async () => ({ usage: 0, quota: 10_000_000_000 }),
  root: fakeDir('', [fakeDir('dl', [small, large])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async ({ storage }: { storage: StorageBackend }) => {
      let next = 1
      return fakeSession({
        addTorrentFile: (_bytes: Uint8Array, savePath: string) => {
          const handle = next++
          void storage.onNewStorage(storageOf(handle), savePath, LAYOUTS[handle - 1]!)
          return handle
        },
        infohash: (handle: number) => HASHES[handle - 1] ?? null,
        infohashV2: () => null,
        files: (handle: number) => {
          const files = LAYOUTS[handle - 1]
          if (!files) return null
          let offset = 0
          const placed = files.map((f) => ({ ...f, offset: (offset += f.size) - f.size, pad: false }))
          return { storageIndex: storageOf(handle), pieceLength: 16_384, numPieces: 6, totalSize: offset, contentSize: offset, files: placed }
        },
      })
    },
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

/** What the state messages about `handle` posted since message `since` say it takes in browser storage. */
const figuresSince = (handle: number, since: number) => rig.posted.slice(since)
  .map((m) => m.detail as { handle: number, storageBytes?: number } | null | undefined)
  .filter((detail) => detail?.handle === handle)
  .map((detail) => detail!.storageBytes)

/** What each of the first `count` state messages about `handle` after it is opened says it takes in browser storage. */
const figuresOf = async (handle: number, count = 3) => {
  const since = rig.posted.length
  rig.send({ type: 'inspect', handle })
  await vi.waitFor(() => expect(figuresSince(handle, since).length).toBeGreaterThanOrEqual(count), { timeout: 10_000 })
  return figuresSince(handle, since).slice(0, count)
}

let added: Promise<void> | undefined
const ready = () => added ??= (async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([1]) })
  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([2]) })
  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([3]), savePath: `/native/${HASHES[2]}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(3), { timeout: 10_000 })
})()

it('gives each torrent in the shared root its own browser storage, and one in a folder none', async () => {
  await ready()
  // the folder's is read over as many messages as the two others needed to carry theirs
  for (const [handle, bytes] of [[1, 3_000], [2, 70_500], [3, undefined], [1, 3_000]] as const) {
    const figures = await figuresOf(handle)
    expect(figures.filter((figure) => figure !== undefined && figure !== bytes), `torrent ${handle}, another's figure`).toEqual([])
    expect(figures.at(-1), `torrent ${handle}`).toBe(bytes)
  }
  expect(rig.of('worker-error')).toEqual([])
}, 60_000)

it('measures the open torrent again as its bytes grow', async () => {
  await ready()
  const since = rig.posted.length
  rig.send({ type: 'inspect', handle: 1 })
  await vi.waitFor(() => expect(figuresSince(1, since).at(-1)).toBe(3_000), { timeout: 10_000 })
  small.children.set('s.mkv', fakeFile('s.mkv', 3_500))
  await vi.waitFor(() => expect(figuresSince(1, since).at(-1)).toBe(3_500), { timeout: 10_000 })
}, 30_000)
