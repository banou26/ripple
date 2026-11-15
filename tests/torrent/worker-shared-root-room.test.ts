import type { StorageBackend } from 'libtorrent-wasm/types'

import { expect, it, vi } from 'vitest'

import { fakeDir, fakeFile, installWorkerGlobals } from '../utils/worker-rig'

/**
 * Whether a watched film fits is judged by that film's own bytes and refusals.
 *
 * Every torrent added from a .torrent shares one save path, so a judgement read by save path is the one about the
 * torrent mounted there last. Here the one mounted first fits and the one mounted last does not, and the browser
 * refused a write of the second: only a judgement of each torrent's own files gives both answers. The second also
 * holds a file it is not playing, which a measure of the whole torrent would count as the film's.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const LIMIT = 10 * GiB
// 32 MiB free, under the margin a watched file must leave
const USED = LIMIT - 32 * MiB

const LAYOUTS = [
  // owes 10 MiB, which fits
  [{ path: 'Whole/w.mkv', size: 40 * MiB }],
  // owes nearly all of 1 GiB, which does not, beside an extra already stored that is bigger than the film
  [{ path: 'Part/p.mkv', size: GiB }, { path: 'Part/extra.mkv', size: 2 * GiB }],
]
const HASHES = ['a'.repeat(40), 'b'.repeat(40)]
// libtorrent's storage ids are its own, never the handles
const storageOf = (handle: number) => 10 + handle

// the browser lands none of a write into the second torrent's file, which it already holds 1 MiB of
const refusing = {
  kind: 'file' as const,
  name: 'p.mkv',
  size: MiB,
  getFile: async () => ({ size: MiB }),
  createSyncAccessHandle: async () => ({ write: () => 0, read: () => 0, getSize: () => MiB, truncate: () => {}, flush: () => {}, close: () => {} }),
}

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: USED, quota: LIMIT }),
  root: fakeDir('', [fakeDir('dl', [fakeDir('Whole', [fakeFile('w.mkv', 30 * MiB)]), fakeDir('Part', [refusing, fakeFile('extra.mkv', 2 * GiB)])])]),
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
          const mounted = Promise.resolve(storage.onNewStorage(storageOf(handle), savePath, LAYOUTS[handle - 1]!))
          if (handle === 2) void mounted.then(() => storage.write(storageOf(handle), 0, 512 * MiB, new Uint8Array(16_384))).catch(() => {})
          return handle
        },
        infohash: (handle: number) => HASHES[handle - 1] ?? null,
        infohashV2: () => null,
        files: (handle: number) => {
          const files = LAYOUTS[handle - 1]
          if (!files) return null
          let offset = 0
          const placed = files.map((f) => ({ ...f, offset: (offset += f.size) - f.size, pad: false }))
          return { storageIndex: storageOf(handle), pieceLength: MiB, numPieces: offset / MiB, totalSize: offset, contentSize: offset, files: placed }
        },
        setStreamWindow: () => true,
        clearStreamWindow: () => {},
        cancelPieceRequests: () => {},
        pauseTorrent: () => {},
        resumeTorrent: () => {},
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

it('judges each watched torrent in the shared root by its own bytes and its own refused write', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([1]) })
  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([2]) })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2), { timeout: 10_000 })

  // THE CONTROL: the one that does not fit is called full
  rig.send({ type: 'watch', viewer: 'player', handle: 2, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(rig.of('storage-full').at(-1)).toEqual({ type: 'storage-full', full: true, usedBytes: USED, limitBytes: LIMIT }), { timeout: 10_000 })

  rig.send({ type: 'unwatch', viewer: 'player' })
  rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(rig.of('storage-full').at(-1), 'the film that fits was judged by the other one').toEqual({ type: 'storage-full', full: false, usedBytes: USED, limitBytes: LIMIT }), { timeout: 10_000 })
}, 30_000)
