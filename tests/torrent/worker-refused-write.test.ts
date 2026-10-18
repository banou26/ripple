import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A write the browser refused, for a file the cache cannot make room for, is reported full.
 *
 * The numbers alone never say it for a file over the headroom: on Chromium the ceiling floats 10 GiB
 * above usage, so a 20 GiB file opening owes more than the headroom and still plays. What says it is
 * the refusal, which on Firefox 157 is the tail write of a file over the frame's fixed 10 GiB
 * (2026-10-19), and which `@banou/ponyfill` raises as a `QuotaExceededError` there as on Chromium.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const LIMIT = 10 * GiB
const USED = 16 * MiB + 491_520
const FILE = 20 * GiB
const HASH = 'f'.repeat(40)

const state = vi.hoisted(() => ({ usageOf: [] as unknown[][], refused: 0 as number | undefined, floating: false }))

// a ceiling that floats stays 10 GiB above usage, as Chromium's does
const rig = installWorkerGlobals({ estimate: async () => ({ usage: USED, quota: state.floating ? USED + LIMIT : LIMIT }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      files: () => ({
        storageIndex: 0, pieceLength: 16 * MiB, numPieces: 1280, totalSize: FILE, contentSize: FILE,
        files: [{ path: 'remux.mkv', offset: 0, size: FILE, pad: false }],
      }),
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
      // the player leaving parks a cache torrent, and its coming back wakes it
      pauseTorrent: () => {},
      resumeTorrent: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({
    usageOf: async (...args: unknown[]) => { state.usageOf.push(args); return 16 * MiB },
    // the tail write, when it is refused, is refused before the pass can run
    refusedFile: () => state.refused,
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

it('reports a refused write the cache cannot make room for as full, and the same file unrefused as not', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 100))
  // THE CONTROL: with nothing watched, a refusal is nobody's
  expect(rig.of('storage-full')).toEqual([])

  // and with nothing refused, on a ceiling that floats, a file owing twice the headroom still plays
  state.refused = undefined
  state.floating = true
  rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(state.usageOf, 'no pass ever asked what the file owes').toContainEqual(['/dl/' + HASH, 0]))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(rig.of('storage-full')).toEqual([])

  rig.send({ type: 'unwatch', viewer: 'player' })
  state.refused = 0
  state.floating = false
  state.usageOf.length = 0
  rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(state.usageOf, 'no pass ever asked what the file owes').toContainEqual(['/dl/' + HASH, 0]))
  await vi.waitFor(() => expect(rig.of('storage-full')).toEqual([
    { type: 'storage-full', full: true, usedBytes: USED, limitBytes: LIMIT },
  ]))
})
