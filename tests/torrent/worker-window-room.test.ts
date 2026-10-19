import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * A windowed film owes only what its room has free, so the cold cache is given up for it, and a
 * write the browser refuses it is the window's to absorb rather than a reason to call the film too
 * big. `worker-window-floating.test.ts` is the control: the same cache and the same refusal on a
 * floating ceiling keep the cache and report the film too big, as before windows existed.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const C = 64 * MiB
const PIECE = 16 * MiB
const FILM = 25 * GiB
const EARLIER = 1_200_000_000
const FILM_HASH = 'f'.repeat(40)
const EARLIER_HASH = 'e'.repeat(40)
const OLDER_HASH = 'd'.repeat(40)

const state = vi.hoisted(() => ({ used: 0, held: 0, refused: false }))

// two episodes watched before, cold and past their grace, more than the floor between them
const episode = (infoHash: string, lastUsedAt: number): Persisted => ({
  infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/cache/' + infoHash, addedAt: 1, lastUsedAt, started: true, ephemeral: true,
})

const usage = () => state.used + EARLIER * [1, 2].filter((h) => !sessions[0]?.removed.includes(h)).length
const rig = installWorkerGlobals({ estimate: async () => ({ usage: usage(), quota: 10 * GiB }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      // the restored episodes are handles 1 and 2, the film handle 3
      files: (h: number) => h === 3
        ? { storageIndex: 0, pieceLength: PIECE, numPieces: FILM / PIECE, totalSize: FILM, contentSize: FILM, files: [{ path: 'remux.mkv', offset: 0, size: FILM, pad: false }] }
        : { storageIndex: h, pieceLength: PIECE, numPieces: 84, totalSize: EARLIER, contentSize: EARLIER, files: [{ path: 'e01.mkv', offset: 0, size: EARLIER, pad: false }] },
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
      pauseTorrent: () => {},
      resumeTorrent: () => {},
      setDownloadLimit: () => {},
      saveResumeData: async () => new Uint8Array([1]),
      forgetPieces: () => ({ forgotten: 0, busy: 0 }),
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({
    usageOf: async (savePath: string) => (savePath.endsWith(FILM_HASH) ? state.held : savePath.endsWith(EARLIER_HASH) || savePath.endsWith(OLDER_HASH) ? EARLIER : 0),
    refusedFile: (savePath: string) => (state.refused && savePath.endsWith(FILM_HASH) ? 0 : undefined),
  }),
}))
vi.mock('../../src/torrent/chunked-storage', () => ({
  CHUNK_BYTES: 64 * 1024 * 1024,
  createChunkedStorage: () => ({ chunkBytesOf: () => 64 * 1024 * 1024, chunksOf: () => [], footprint: () => state.held, drop: async () => {} }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>([['ripple:torrents', [episode(OLDER_HASH, 1), episode(EARLIER_HASH, 2)]]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const windowed = () => {
  const states = rig.of('state')
  return (states.at(-1)?.torrents as { handle: number, windowed: boolean }[] | undefined)?.find((t) => t.handle === 3)?.windowed
}

it('gives the cold cache up for a windowed film, and does not call it too big when a write of it is refused', async () => {
  state.held = 2 * C
  state.used = 2 * C + MiB
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  rig.send({ type: 'watch', viewer: 'player', handle: 3, fileIndex: 0, fromOffset: 0 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(sessions[0]!.removed, 'an episode went before the ceiling was known').toEqual([])

  state.used += C
  state.held += C
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '0'.repeat(40) })
  await vi.waitFor(() => expect(windowed()).toBe(true), { timeout: 8_000 })
  // all of it, in the pass that planned the window, oldest first
  expect(sessions[0]!.removed).toEqual([1, 2])

  state.refused = true
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '1'.repeat(40) })
  await new Promise((resolve) => setTimeout(resolve, 600))
  expect(rig.of('storage-full').filter((m) => m.full)).toEqual([])
})
