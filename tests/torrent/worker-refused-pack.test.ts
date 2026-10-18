import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A write refused to a file nobody claims, in a pack a download page holds, is reported full.
 *
 * The download page holds the pack's first file and downloads the others, so what the refusal says
 * has to come from the file that was refused, not from the one held: here that one is complete and
 * owes nothing, while the second still owes all of its gigabyte with 32 MiB left.
 */

const GB = 1_000_000_000
const QUOTA = 10 * GB
const USED = QUOTA - 32 * 1024 * 1024
const HASH = 'd'.repeat(40)

const rig = installWorkerGlobals({ estimate: async () => ({ usage: USED, quota: QUOTA }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      files: () => ({
        storageIndex: 0, pieceLength: 1_048_576, numPieces: 1908, totalSize: 2 * GB, contentSize: 2 * GB,
        files: [
          { path: 'pack/e01.mkv', offset: 0, size: GB, pad: false },
          { path: 'pack/e02.mkv', offset: GB, size: GB, pad: false },
        ],
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
  createHybridStorage: () => ({
    // the first file is all on disk, the second not at all
    usageOf: async (_savePath: string, fileIndex?: number) => fileIndex === 0 ? GB : 0,
    refusedFile: () => 1,
  }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('reports a refused write to a file the download page does not hold as full', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + HASH })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 100))
  // THE CONTROL: with nothing holding it, a refusal is nobody's
  expect(rig.of('storage-full')).toEqual([])

  rig.send({ type: 'watch', viewer: 'download', handle: 1, fileIndex: 0, fromOffset: 0, held: true })
  // a hold runs no pass of its own, so the next add's pass is the one that reads it
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + 'c'.repeat(40) })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2))
  await vi.waitFor(() => expect(rig.of('storage-full')).toEqual([
    { type: 'storage-full', full: true, usedBytes: USED, limitBytes: QUOTA },
  ]))
})
