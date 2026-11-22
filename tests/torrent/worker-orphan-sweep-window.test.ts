import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

/**
 * When `runOrphanSweep()` frees disk space inside a budget pass, `owed`, `rooms`, `replan`, and
 * `recovery.retry` must be refreshed before `reportSpace` runs in `finally`.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const PIECE = 16 * MiB
const LIMIT = 10 * GiB
const ORPHAN = 10 * GiB - 32 * MiB
const FILM = 25 * GiB
const FILM_HASH = 'f'.repeat(40)
const ORPHAN_HASH = 'd'.repeat(40)

const cacheDir = fakeDir('cache', [fakeDir(ORPHAN_HASH)])
const state = vi.hoisted(() => ({ ahead: 0, reporting: false, resumed: [] as number[] }))

const realNow = Date.now.bind(Date)
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + state.ahead)

const rig = installWorkerGlobals({
  estimate: async () => {
    if (!state.reporting) return {}
    const orphanBytes = cacheDir.removed.includes(ORPHAN_HASH) ? 0 : ORPHAN
    return { usage: orphanBytes, quota: LIMIT }
  },
  root: fakeDir('', [cacheDir]),
})

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
  return {
    createSession: async () => fakeSession({
      files: (h: number) => h === 1
        ? { storageIndex: 0, pieceLength: PIECE, numPieces: FILM / PIECE, totalSize: FILM, contentSize: FILM, files: [{ path: 'remux.mkv', offset: 0, size: FILM, pad: false }] }
        : null,
      status: (h: number) => (h === 1 ? stopped : null),
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
      pauseTorrent: () => {},
      resumeTorrent: (h: number) => { state.resumed.push(h) },
      setFlags: (h: number, flags: number, mask: number) => { if (mask & 16 && !(flags & 16)) state.resumed.push(h) },
      setDownloadLimit: () => {},
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
    usageOf: async () => 0,
    usageOfStorage: async () => 0,
    refusedFile: (id: number) => (id === 0 ? 0 : undefined),
  }),
}))
vi.mock('../../src/torrent/chunked-storage', () => ({
  createChunkedStorage: () => ({ chunkBytesOf: () => 64 * 1024 * 1024, chunksOf: () => [], footprint: () => 0, drop: async () => {} }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>([['ripple:ceiling-fixed', true]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const windowed = () => (rig.of('state').at(-1)?.torrents as { handle: number, windowed: boolean }[] | undefined)
  ?.find((t) => t.handle === 1)?.windowed

it('replans window, retries recovery, and avoids false storage-full right after orphan sweep frees space', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(state.resumed).toEqual([1]))
  state.resumed.length = 0

  // move past recovery add-hold so stopped status puts handle 1 onto recovery backoff
  state.ahead = 12_000
  await new Promise((resolve) => setTimeout(resolve, 650))
  expect(cacheDir.removed).toEqual([])
  expect(state.resumed).toEqual([])

  state.reporting = true
  // trigger one budget pass; backoff is still 5s away with frozen Date.now
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '0'.repeat(40) })

  await vi.waitFor(() => expect(cacheDir.removed).toEqual([ORPHAN_HASH]), { timeout: 5_000 })
  await vi.waitFor(() => expect(windowed()).toBe(true), { timeout: 3_000 })
  await vi.waitFor(() => expect(state.resumed).toContain(1), { timeout: 2_000 })
  expect(rig.of('storage-full').filter((m) => m.full)).toEqual([])
}, 15_000)
