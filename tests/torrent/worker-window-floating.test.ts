import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * On a floating ceiling a cache film bigger than the room is never windowed: the whole film is
 * wanted, nothing of it drops or trickles, and it is planned exactly as before windows existed.
 *
 * Chromium raises its quota by what was written (measured on Chromium 149 in a frame, 2026-10-19),
 * so a 25 GiB film that grows a chunk at a time is bigger than the room at every step and has the
 * room all the same. The control of `worker-window.test.ts` and `worker-window-room.test.ts`: the
 * same film, cache and refusal, with the quota floating.
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

const state = vi.hoisted(() => ({ used: 0, held: 0, refused: false, keeps: [] as unknown[], events: [] as unknown[], limits: [] as unknown[] }))

// two episodes watched before, cold and past their grace, more than the floor between them
const episode = (infoHash: string, lastUsedAt: number): Persisted => ({
  infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/cache/' + infoHash, addedAt: 1, lastUsedAt, started: true, ephemeral: true,
})

const usage = () => state.used + EARLIER * [1, 2].filter((h) => !sessions[0]?.removed.includes(h)).length
const reads: number[] = []
// what Chromium states: about 10 GiB of headroom above whatever is held
const rig = installWorkerGlobals({ estimate: async () => { reads.push(usage()); return { usage: usage(), quota: usage() + 10 * GiB } } })

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
      setStreamWindow: (h: number, _claims: unknown, opts: { keep?: unknown }) => { if (h === 3) state.keeps.push(opts.keep); return true },
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
      pauseTorrent: () => {},
      resumeTorrent: () => {},
      bitfield: () => ({ numPieces: FILM / PIECE, pieceLength: PIECE, length: FILM, pieces: new Uint8Array(FILM / PIECE / 8).fill(0xff) }),
      setDownloadLimit: (...args: unknown[]) => { state.limits.push(args) },
      saveResumeData: async () => new Uint8Array([1]),
      forgetPieces: (...args: unknown[]) => { state.events.push(args); return { forgotten: 0, busy: 0 } },
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
  createChunkedStorage: () => ({
    chunkBytesOf: () => 64 * 1024 * 1024,
    chunksOf: () => [0, 1, 2, 200, 399],
    footprint: () => state.held,
    drop: async (...args: unknown[]) => { state.events.push(args) },
  }),
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

it('wants the whole film, keeps the cache, and drops and trickles nothing', async () => {
  state.held = 2 * C
  state.used = 2 * C + MiB
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  rig.send({ type: 'watch', viewer: 'player', handle: 3, fileIndex: 0, fromOffset: 0 })
  for (let step = 0; step < 3; step++) {
    state.used += C
    state.held += C
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + String(step).repeat(40) })
    rig.send({ type: 'watch', viewer: 'player', handle: 3, fileIndex: 0, fromOffset: (step + 1) * 100 * C })
    // a pass has read the usage after this move: the ponyfill's estimate and the platform's own
    await vi.waitFor(() => expect(reads.filter((used) => used === usage()).length).toBeGreaterThanOrEqual(2))
  }
  await new Promise((resolve) => setTimeout(resolve, 700))
  expect(state.keeps.length).toBeGreaterThan(3)
  expect(state.keeps.every((keep) => keep === undefined)).toBe(true)
  expect(rig.of('state').flatMap((s) => s.torrents as { windowed: boolean }[]).some((t) => t.windowed)).toBe(false)
  expect(state.events).toEqual([])
  expect(state.limits).toEqual([])
  expect(sessions[0]!.removed, 'the cache went for a film that does not window').toEqual([])

  // ten more GiB of it: past the quota the worker first read, and every write still lands
  state.used += 10 * GiB
  state.held += 10 * GiB
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '8'.repeat(40) })
  await vi.waitFor(() => expect(reads.filter((used) => used === usage()).length).toBeGreaterThanOrEqual(2))
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(rig.of('storage-full').filter((m) => m.full), 'a film the browser has room for was called too big').toEqual([])

  // and a refused write is a film too big for the room, as it was before windows
  state.refused = true
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '9'.repeat(40) })
  await vi.waitFor(() => expect(rig.of('storage-full').filter((m) => m.full)).toHaveLength(1))
})
