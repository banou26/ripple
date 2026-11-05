import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * The case Firefox showed stuck on "Too big for this browser's storage here": a fixed
 * 10 GiB room held by the film watched before, and a film bigger than the room opened after it.
 *
 * Free is under the 23 chunks a window needs, and under the margin, so the numbers alone would call
 * the room full while the earlier film only waits out its grace. The earlier film is the largest
 * thing cached, so the cache's size cap keeps it too. A window sized from what is free could never be
 * planned, the new film would owe all 25 GiB, and no eviction could cover that, so nothing was ever
 * given up.
 *
 * The player read the earlier film until it moved on, as stub's open in place does. Its reads used to
 * keep the film for a minute after that, most of what the new film's first read waits before the
 * player gives up for good.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const PIECE = 16 * MiB
const FILM = 25 * GiB
const EARLIER = 10 * GiB - 32 * MiB
const FILM_HASH = 'f'.repeat(40)
const EARLIER_HASH = 'e'.repeat(40)

const state = vi.hoisted(() => ({ ahead: 0, resumed: [] as number[], start: Date.now() }))

// Time moved on without waiting for it: the earlier film's grace and the engine's recovery both read Date.now
const realNow = Date.now.bind(Date)
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + state.ahead)

const earlier: Persisted = {
  infoHash: EARLIER_HASH, magnet: 'magnet:?xt=urn:btih:' + EARLIER_HASH, savePath: '/cache/' + EARLIER_HASH,
  addedAt: 1, lastUsedAt: state.start, started: true, ephemeral: true,
}

const usage = () => (sessions[0]?.removed.includes(1) ? 0 : EARLIER)
const rig = installWorkerGlobals({ estimate: async () => ({ usage: usage(), quota: 10 * GiB }) })

// what a film whose tail write was refused reports: stopped, with the error
const stopped = {
  paused: true, autoManaged: true, state: 3, totalDone: 0, downloadRate: 0, numPeers: 4, errorCode: 28, error: 'short write',
  activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
}

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      // the restored film is handle 1, the new one handle 2
      files: (h: number) => h === 2
        ? { storageIndex: 0, pieceLength: PIECE, numPieces: FILM / PIECE, totalSize: FILM, contentSize: FILM, files: [{ path: 'remux.mkv', offset: 0, size: FILM, pad: false }] }
        : { storageIndex: h, pieceLength: PIECE, numPieces: EARLIER / PIECE, totalSize: EARLIER, contentSize: EARLIER, files: [{ path: 'film.mkv', offset: 0, size: EARLIER, pad: false }] },
      status: (h: number) => (h === 2 ? stopped : null),
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
      pauseTorrent: () => {},
      resumeTorrent: (h: number) => { state.resumed.push(h) },
      setDownloadLimit: () => {},
      read: async () => new Uint8Array(16),
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
    usageOf: async (savePath: string) => (savePath.endsWith(EARLIER_HASH) ? EARLIER : 0),
    refusedFile: (savePath: string) => (savePath.endsWith(FILM_HASH) ? 0 : undefined),
  }),
}))
vi.mock('../../src/torrent/chunked-storage', () => ({
  CHUNK_BYTES: 64 * 1024 * 1024,
  createChunkedStorage: () => ({ chunkBytesOf: () => 64 * 1024 * 1024, chunksOf: () => [], footprint: () => 0, drop: async () => {} }),
}))
vi.mock('idb-keyval', () => {
  // the session that watched the earlier film saw the ceiling hold, as Firefox's does
  const store = new Map<string, unknown>([['ripple:torrents', [earlier]], ['ripple:ceiling-fixed', true]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const windowed = () => (rig.of('state').at(-1)?.torrents as { handle: number, windowed: boolean }[] | undefined)
  ?.find((t) => t.handle === 2)?.windowed

it('gives up the film a player has let go of for a film bigger than the room, plays it through a window and restarts it at once', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })
  rig.send({ type: 'read', id: 1, viewer: 'player', handle: 1, fileIndex: 0, offset: 0, len: 16 })
  await vi.waitFor(() => expect(rig.of('read-result')).toHaveLength(1))
  rig.send({ type: 'unwatch', viewer: 'player' })
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  rig.send({ type: 'watch', viewer: 'player', handle: 2, fileIndex: 0, fromOffset: 0 })
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(sessions[0]!.removed, 'the earlier film went inside its grace').toEqual([])
  expect(rig.of('storage-full').filter((m) => m.full), 'a film that gets a window once the grace ends was called too big').toEqual([])

  // past the add's hold, so recovery has the stopped film on its backoff, and past the earlier film's last use,
  // well inside a minute of its last read
  state.ahead = 16_000
  await new Promise((resolve) => setTimeout(resolve, 700))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '0'.repeat(40) })
  await vi.waitFor(() => expect(windowed()).toBe(true), { timeout: 8_000 })
  expect(sessions[0]!.removed).toEqual([1])
  // the backoff's first try is 5 s away and the clock no longer moves, so only the pass can have restarted it
  await vi.waitFor(() => expect(state.resumed).toContain(2), { timeout: 2_000 })
  expect(rig.of('storage-full').filter((m) => m.full), 'the film was called too big').toEqual([])
}, 15_000)
