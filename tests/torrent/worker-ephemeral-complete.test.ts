// An ephemeral playback torrent keeps seeding by default while watching (qBittorrent parity), pauses on viewer close, and stops early only when a configured seeding limit is met.
import { expect, it, vi } from 'vitest'

import { DEMO_SAVE_PATH } from '../../src/torrent/constants'
import { DEFAULT_SEEDING_POLICY } from '../../src/torrent/seeding-policy'
import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024

type MockStatus = {
  state: number
  allTimeUpload: number
  seedingSeconds: number
}

const engine = vi.hoisted(() => ({
  queued: new Set<number>(),
  live: new Set<number>(),
  registered: new Set<number>(),
  paused: new Set<number>(),
  autoManaged: new Set<number>(),
  stats: new Map<number, MockStatus>(),
  held: new Map<number, Set<number>>(),
  filesByHandle: new Map<number, { size: number, path: string }[]>(),
  log: [] as string[],
  flagLog: [] as { handle: number, flags: number, mask: number }[],
  setStreamWindowCalls: [] as { handle: number, claims: unknown[] }[],
  readDelayMs: 0,
  added: 0,
}))

const store = vi.hoisted(() => new Map<string, unknown>())
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const buildLayout = (h: number) => {
    const entries = engine.filesByHandle.get(h) ?? [{ size: 4 * MiB, path: 'film.mp4' }]
    let offset = 0
    const files = entries.map((entry) => {
      const f = { path: entry.path, offset, size: entry.size, pad: false }
      offset += entry.size
      return f
    })
    return { storageIndex: h, pieceLength: MiB, numPieces: offset / MiB, totalSize: offset, contentSize: offset, files }
  }
  const tick = () => { for (const h of engine.queued) engine.live.add(h); engine.queued.clear() }
  setInterval(tick, 50)
  return {
    createSession: async () => fakeSession({
      tick,
      addMagnet: () => {
        const h = ++engine.added
        engine.queued.add(h)
        engine.stats.set(h, { state: 3, allTimeUpload: 0, seedingSeconds: 0 })
        engine.autoManaged.add(h)
        return h
      },
      addTorrentFile: () => {
        const h = ++engine.added
        engine.queued.add(h)
        engine.stats.set(h, { state: 3, allTimeUpload: 0, seedingSeconds: 0 })
        engine.autoManaged.add(h)
        return h
      },
      popAlerts: () => { for (const h of engine.live) engine.registered.add(h); return [] },
      status: (h: number) => {
        if (!engine.registered.has(h)) return null
        const layout = buildLayout(h)
        const s = engine.stats.get(h) ?? { state: 3, allTimeUpload: 0, seedingSeconds: 0 }
        const done = (engine.held.get(h)?.size ?? 0) * MiB
        return {
          state: s.state,
          paused: engine.paused.has(h),
          autoManaged: engine.autoManaged.has(h),
          errorCode: 0,
          totalDone: done,
          downloadRate: 0,
          numPeers: 0,
          activeSeconds: s.seedingSeconds,
          seedingSeconds: s.seedingSeconds,
          allTimeDownload: done,
          allTimeUpload: s.allTimeUpload,
          wasted: 0,
          storageIndex: layout.storageIndex,
        }
      },
      files: (h: number) => (engine.registered.has(h) ? buildLayout(h) : null),
      bitfield: (h: number) => {
        if (!engine.registered.has(h)) return null
        const layout = buildLayout(h)
        const pieces = new Uint8Array(Math.ceil(layout.numPieces / 8))
        for (const p of engine.held.get(h) ?? []) pieces[p >> 3]! |= 0x80 >> (p & 7)
        return { pieces, numPieces: layout.numPieces, pieceLength: MiB, length: layout.totalSize }
      },
      read: async (_h: number, _file: number, _offset: number, len: number) => {
        if (engine.readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, engine.readDelayMs))
        return new Uint8Array(len)
      },
      setStreamWindow: (h: number, claims: unknown[]) => {
        engine.setStreamWindowCalls.push({ handle: h, claims })
        return true
      },
      clearStreamWindow: () => {},
      prioritizePieces: () => {},
      pauseTorrent: (h: number) => {
        engine.paused.add(h)
        engine.autoManaged.delete(h)
        engine.log.push(`pause ${h}`)
      },
      resumeTorrent: (h: number) => {
        engine.paused.delete(h)
        engine.autoManaged.add(h)
        engine.log.push(`resume ${h}`)
      },
      setFlags: (h: number, flags: number, mask: number) => {
        engine.flagLog.push({ handle: h, flags, mask })
        if (mask & 16) {
          if (flags & 16) engine.paused.add(h)
          else engine.paused.delete(h)
        }
        if (mask & 32) {
          if (flags & 32) engine.autoManaged.add(h)
          else engine.autoManaged.delete(h)
        }
      },
      saveResumeData: async () => new Uint8Array([1]),
      setDownloadLimit: () => {},
      setUploadLimit: () => {},
      cancelPieceRequests: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 2, paused: 16, autoManaged: 32, sequentialDownload: 512 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, usageOfStorage: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => { store.set(key, value) },
  del: async (key: string) => { store.delete(key) },
  update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
}))

const range = (from: number, to: number) => new Set(Array.from({ length: to - from }, (_, i) => from + i))
const hash = (c: string) => c.repeat(40)

const addEphemeral = async (c: string, files: { size: number, path: string }[], savePath?: string) => {
  const before = rig.of('added').length
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${hash(c)}`, ephemeral: true, ...(savePath ? { savePath } : {}) })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(before + 1))
  const h = rig.of('added').at(-1)!.handle as number
  engine.filesByHandle.set(h, files)
  await vi.waitFor(() => expect(engine.registered.has(h)).toBe(true))
  return h
}

const pumps = () => new Promise((resolve) => setTimeout(resolve, 1_100))

it('keeps a completed ephemeral playback torrent seeding by default while watching, and pauses once viewing ends', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  const h = await addEphemeral('1', [{ size: 4 * MiB, path: 'film.mp4' }])
  engine.held.set(h, range(0, 2))
  rig.send({ type: 'watch', viewer: 'player:1', handle: h, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(engine.setStreamWindowCalls.some((c) => c.handle === h)).toBe(true))
  expect(engine.paused.has(h)).toBe(false)

  // torrent finishes while the player is still open -> stays seeding under default (limits off)
  engine.held.set(h, range(0, 4))
  engine.stats.set(h, { state: 5, allTimeUpload: 16 * MiB, seedingSeconds: 36_000 })
  await pumps()
  expect(engine.paused.has(h)).toBe(false)

  // closing the viewer parks the idle ephemeral torrent
  rig.send({ type: 'unwatch', viewer: 'player:1' })
  await vi.waitFor(() => expect(engine.paused.has(h)).toBe(true), { timeout: 2_000 })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('stops an ephemeral playback torrent when a seeding limit hits while keeping OPFS reads paused, and wakes on an unheld episode', async () => {
  rig.send({ type: 'set-seeding-policy', policy: { ratio: 1, minutes: null } })
  const pack = await addEphemeral('2', [
    { size: 4 * MiB, path: 'e1.mkv' },
    { size: 4 * MiB, path: 'e2.mkv' },
  ])
  engine.held.set(pack, range(0, 4))
  engine.stats.set(pack, { state: 4, allTimeUpload: 4 * MiB, seedingSeconds: 0 })
  rig.send({ type: 'watch', viewer: 'player:2', handle: pack, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(engine.paused.has(pack)).toBe(true), { timeout: 2_000 })
  const logCountAfterStop = engine.log.length

  // OPFS reads and seeks within held episode continue serving without waking/seeding
  rig.send({ type: 'read', id: 'opfs-2', handle: pack, fileIndex: 0, offset: MiB, len: 64 * 1024, prioritize: true, viewer: 'player:2' })
  await vi.waitFor(() => expect(rig.posted.find((m) => m.id === 'opfs-2')).toMatchObject({ type: 'read-result' }))
  rig.send({ type: 'watch', viewer: 'player:2', handle: pack, fileIndex: 0, fromOffset: 2 * MiB, readLen: 64 * 1024 })
  await pumps()
  expect(engine.paused.has(pack)).toBe(true)
  expect(engine.log.length).toBe(logCountAfterStop)

  // switching to episode 2 whose pieces (4..7) are not held wakes the torrent and plans its window
  const windowsBefore = engine.setStreamWindowCalls.filter((c) => c.handle === pack).length
  rig.send({ type: 'watch', viewer: 'player:2', handle: pack, fileIndex: 1, fromOffset: 0 })
  await vi.waitFor(() => expect(engine.paused.has(pack)).toBe(false), { timeout: 2_000 })
  expect(engine.setStreamWindowCalls.filter((c) => c.handle === pack).length).toBeGreaterThan(windowsBefore)

  // once episode 2 finishes and meets the limit, it stops seeding again
  engine.held.set(pack, range(0, 8))
  engine.stats.set(pack, { state: 5, allTimeUpload: 8 * MiB, seedingSeconds: 0 })
  await vi.waitFor(() => expect(engine.paused.has(pack)).toBe(true), { timeout: 2_000 })

  // closing the viewer keeps it parked even if seeding limits are cleared afterward
  rig.send({ type: 'unwatch', viewer: 'player:2' })
  await pumps()
  rig.send({ type: 'set-seeding-policy', policy: DEFAULT_SEEDING_POLICY })
  await pumps()
  expect(engine.paused.has(pack)).toBe(true)
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('stays parked during a slow OPFS read of already-held bytes and a concurrent re-anchor under an active limit', async () => {
  rig.send({ type: 'set-seeding-policy', policy: { ratio: null, minutes: 1 } })
  const h = await addEphemeral('3', [{ size: 32 * MiB, path: 'film.mp4' }])
  engine.held.set(h, range(0, 32))
  engine.stats.set(h, { state: 5, allTimeUpload: 0, seedingSeconds: 60 })
  rig.send({ type: 'watch', viewer: 'player:3', handle: h, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(engine.paused.has(h)).toBe(true), { timeout: 2_000 })

  const logStart = engine.log.length
  engine.readDelayMs = 600
  try {
    rig.send({ type: 'read', id: 'slow-held-1', handle: h, fileIndex: 0, offset: 0, len: 64 * 1024, prioritize: false, viewer: 'player:3' })
    await new Promise((resolve) => setTimeout(resolve, 40))
    rig.send({ type: 'watch', viewer: 'player:3', handle: h, fileIndex: 0, fromOffset: 16 * MiB, readLen: 64 * 1024 })
    await vi.waitFor(() => expect(rig.posted.find((m) => m.id === 'slow-held-1')).toMatchObject({ type: 'read-result' }), { timeout: 5_000 })
    await pumps()
  } finally {
    engine.readDelayMs = 0
  }

  expect(engine.paused.has(h)).toBe(true)
  const cycles = engine.log.slice(logStart).filter((entry) => entry.startsWith('resume ') || entry.startsWith('pause '))
  expect(cycles).toEqual([])

  // Manual Start, Force start, and the demo sample override active limits while watching
  rig.send({ type: 'resume', handle: h })
  await vi.waitFor(() => expect(engine.paused.has(h)).toBe(false), { timeout: 2_000 })
  await pumps()
  expect(engine.paused.has(h)).toBe(false)
  rig.send({ type: 'unwatch', viewer: 'player:3' })

  const sample = await addEphemeral('4', [{ size: 4 * MiB, path: 'sintel.mp4' }], DEMO_SAVE_PATH)
  engine.held.set(sample, range(0, 4))
  engine.stats.set(sample, { state: 5, allTimeUpload: 8 * MiB, seedingSeconds: 120 })
  rig.send({ type: 'watch', viewer: 'player:4', handle: sample, fileIndex: 0, fromOffset: 0 })
  await pumps()
  expect(engine.paused.has(sample)).toBe(false)
  rig.send({ type: 'unwatch', viewer: 'player:4' })
  rig.send({ type: 'set-seeding-policy', policy: DEFAULT_SEEDING_POLICY })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)
