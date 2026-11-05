import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * A pass reads the room again only once the cached film it gave up is counted gone, not at the first drop at all.
 *
 * Firefox, a 2 GiB room held by the person's own download and a 1.6 GiB cached film, a 3 GiB release opened
 * (2026-11-06): the first figure after the film's delete was 1 MiB lower and still counted the film, and the next one
 * did not. The pass took the 1 MiB as the delete, found too little room for a window, and the release was called too
 * big until the pass after it.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const PIECE = 16 * MiB
const ROOM = 2 * GiB
const FILM = 1664 * MiB
const OTHER = 322 * MiB
const RELEASE = 3 * GiB
const FILM_HASH = 'c'.repeat(40)
const RELEASE_HASH = 'b'.repeat(40)

const state = vi.hoisted(() => ({ ahead: 0, stale: 1, start: Date.now() }))

// the film's grace reads Date.now, so time moves on without waiting for it
const realNow = Date.now.bind(Date)
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + state.ahead)

const gone = () => sessions[0]?.removed.includes(1) ?? false

const entry = (infoHash: string, lastUsedAt: number): Persisted => ({
  infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/cache/' + infoHash, addedAt: 1, lastUsedAt, started: true, ephemeral: true,
})

const rig = installWorkerGlobals({
  estimate: async () => {
    if (gone() && state.stale) {
      state.stale--
      return { usage: OTHER + FILM - MiB, quota: ROOM }
    }
    return { usage: OTHER + (gone() ? 0 : FILM), quota: ROOM }
  },
})

const layout = (size: number) => ({ storageIndex: 0, pieceLength: PIECE, numPieces: size / PIECE, totalSize: size, contentSize: size, files: [{ path: 'film.mkv', offset: 0, size, pad: false }] })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      // the cached film is handle 1, the release handle 2
      files: (h: number) => (h === 2 ? layout(RELEASE) : layout(FILM)),
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
    usageOf: async (savePath: string) => (savePath.endsWith(FILM_HASH) && !gone() ? FILM : 0),
    refusedFile: () => undefined,
  }),
}))
vi.mock('../../src/torrent/chunked-storage', () => ({
  CHUNK_BYTES: 64 * 1024 * 1024,
  createChunkedStorage: () => ({ chunkBytesOf: () => 64 * 1024 * 1024, chunksOf: () => [], footprint: () => 0, drop: async () => {} }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>([
    // the film was watched just before, so it waits out its grace; the release was opened a day ago
    ['ripple:torrents', [entry(FILM_HASH, state.start), entry(RELEASE_HASH, state.start - 86_400_000)]],
    ['ripple:ceiling-fixed', true],
  ])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const windowed = () => (rig.of('state').at(-1)?.torrents as { handle: number, windowed: boolean }[] | undefined)
  ?.find((t) => t.handle === 2)?.windowed

it('reads the room once the film it gave up is counted gone, and plays the release through a window', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'watch', viewer: 'player', handle: 2, fileIndex: 0, fromOffset: 0 })
  await new Promise((resolve) => setTimeout(resolve, 700))
  expect(sessions[0]!.removed, 'the film went inside its grace').toEqual([])

  state.ahead = 16_000
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '0'.repeat(40) })
  await vi.waitFor(() => expect(sessions[0]!.removed).toEqual([1]), { timeout: 2_000 })
  await vi.waitFor(() => expect(windowed(), 'the release never got a window').toBe(true), { timeout: 5_000 })
  expect(state.stale, 'the figure that had yet to count the delete was never read').toBe(0)
  expect(rig.of('storage-full').filter((m) => m.full), 'the release was called too big').toEqual([])
}, 15_000)
