import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * Reads left behind by a viewer that already unwatched (`unwatch` / `unwatch-owner`) must not block
 * cache eviction or storage-room accounting, while viewerless Save/export reads still do.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const PIECE = 16 * MiB
const LIMIT = 10 * GiB
const FILM = 25 * GiB
const EARLIER = 10 * GiB - 32 * MiB
const SAVED = 9 * GiB

const EARLIER_HASH = 'e'.repeat(40)
const FILM_HASH = 'f'.repeat(40)
const SAVED_HASH = 'a'.repeat(40)
const NEED_HASH = 'b'.repeat(40)

const state = vi.hoisted(() => ({
  ahead: 0,
  start: Date.now(),
  resumed: [] as number[],
  readResolvers: new Map<number, () => void>(),
  phase: 1 as 1 | 2,
}))

const realNow = Date.now.bind(Date)
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + state.ahead)

const earlier: Persisted = {
  infoHash: EARLIER_HASH,
  magnet: 'magnet:?xt=urn:btih:' + EARLIER_HASH,
  savePath: '/cache/' + EARLIER_HASH,
  addedAt: 1,
  lastUsedAt: state.start,
  started: true,
  ephemeral: true,
}

const removed = () => sessions[0]?.removed ?? []
const usage = () => {
  if (state.phase === 1) return removed().includes(1) ? 0 : EARLIER
  const savedAlive = !removed().includes(4)
  return savedAlive ? SAVED : 0
}

const rig = installWorkerGlobals({ estimate: async () => ({ usage: usage(), quota: LIMIT }) })

const stopped = {
  paused: true,
  autoManaged: true,
  state: 3,
  totalDone: 0,
  downloadRate: 0,
  numPeers: 4,
  errorCode: 28,
  error: 'short write',
  activeSeconds: 0,
  seedingSeconds: 0,
  allTimeDownload: 0,
  allTimeUpload: 0,
  wasted: 0,
}

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const layout = (storageIndex: number, size: number, path = 'film.mkv') => ({
    storageIndex,
    pieceLength: PIECE,
    numPieces: Math.ceil(size / PIECE),
    totalSize: size,
    contentSize: size,
    files: [{ path, offset: 0, size, pad: false }],
  })
  return {
    createSession: async () => fakeSession({
      files: (h: number) => {
        if (h === 1) return layout(1, EARLIER)
        if (h === 2) return layout(0, FILM, 'remux.mkv')
        if (h === 4) return layout(4, SAVED)
        if (h === 5) return layout(5, 5 * GiB)
        return null
      },
      status: (h: number) => (h === 2 ? stopped : null),
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
      pauseTorrent: () => {},
      resumeTorrent: (h: number) => { state.resumed.push(h) },
      setFlags: (h: number, flags: number, mask: number) => { if (mask & 16 && !(flags & 16)) state.resumed.push(h) },
      setDownloadLimit: () => {},
      read: (h: number) => {
        if (h === 1 || h === 4) {
          return new Promise<Uint8Array>((resolve) => {
            state.readResolvers.set(h, () => resolve(new Uint8Array(16)))
          })
        }
        return Promise.resolve(new Uint8Array(16))
      },
      saveResumeData: async () => new Uint8Array([1]),
      forgetPieces: () => ({ forgotten: 0, busy: 0 }),
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1, paused: 16, autoManaged: 32 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({
    usageOf: async (savePath: string) => {
      if (savePath.endsWith(EARLIER_HASH)) return removed().includes(1) ? 0 : EARLIER
      if (savePath.endsWith(SAVED_HASH)) return removed().includes(4) ? 0 : SAVED
      return 0
    },
    usageOfStorage: async (id: number) => {
      if (id === 1) return removed().includes(1) ? 0 : EARLIER
      if (id === 4) return removed().includes(4) ? 0 : SAVED
      return 0
    },
    refusedFile: (id: number) => (id === 0 ? 0 : undefined),
  }),
}))
vi.mock('../../src/torrent/chunked-storage', () => ({
  createChunkedStorage: () => ({ chunkBytesOf: () => 64 * 1024 * 1024, chunksOf: () => [], footprint: () => 0, drop: async () => {} }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>([['ripple:torrents', [earlier]], ['ripple:ceiling-fixed', true]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const windowed = (handle: number) => (rig.of('state').at(-1)?.torrents as { handle: number, windowed: boolean }[] | undefined)
  ?.find((t) => t.handle === handle)?.windowed

it('evicts cache held only by a departed viewer read instead of calling the next film too big', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  rig.send({ type: 'watch', viewer: 'tab-a:1', handle: 1, fileIndex: 0, fromOffset: 0 })
  rig.send({ type: 'read', id: 101, viewer: 'tab-a:1', handle: 1, fileIndex: 0, offset: 0, len: 16 })
  await vi.waitFor(() => expect(state.readResolvers.has(1)).toBe(true))

  rig.send({ type: 'unwatch-owner', owner: 'tab-a' })
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  rig.send({ type: 'watch', viewer: 'tab-b:1', handle: 2, fileIndex: 0, fromOffset: 0 })

  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(removed(), 'graced cache should not be evicted yet').toEqual([])
  expect(rig.of('storage-full').filter((m) => m.full), 'film should not be reported too big while departed read lingered').toEqual([])

  state.resumed.length = 0
  state.ahead = 16_000
  await new Promise((resolve) => setTimeout(resolve, 700))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '0'.repeat(40) })

  await vi.waitFor(() => expect(windowed(2)).toBe(true), { timeout: 8_000 })
  expect(removed()).toEqual([1])
  await vi.waitFor(() => expect(state.resumed).toContain(2), { timeout: 2_000 })
  expect(rig.of('storage-full').filter((m) => m.full)).toEqual([])
}, 15_000)

it('still shields a cold cache torrent with an active viewerless read until cancel-read arrives', async () => {
  rig.send({ type: 'unwatch', viewer: 'tab-b:1' })
  state.phase = 2

  // handle 4: ephemeral cache torrent with an active viewerless read (Save/export)
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + SAVED_HASH, ephemeral: true, hold: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(3))
  await new Promise((resolve) => setTimeout(resolve, 700))

  rig.send({ type: 'read', id: 201, handle: 4, fileIndex: 0, offset: 0, len: 16 })
  await vi.waitFor(() => expect(state.readResolvers.has(4)).toBe(true))

  // past both READ_GRACE_MS (60s) and RECENT_USE_MS (15s), so only waitedOn(4) protects it
  state.ahead = 90_000

  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + NEED_HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(4))
  rig.send({ type: 'watch', viewer: 'player-5', handle: 5, fileIndex: 0, fromOffset: 0 })
  await new Promise((resolve) => setTimeout(resolve, 400))

  expect(removed(), 'viewerless read must still shield cache from eviction').not.toContain(4)

  rig.send({ type: 'cancel-read', id: 201, handle: 4 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '1'.repeat(40) })

  await vi.waitFor(() => expect(removed()).toContain(4), { timeout: 8_000 })
}, 15_000)
