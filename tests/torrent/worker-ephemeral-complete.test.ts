// An ephemeral playback torrent stops seeding as soon as its wanted bytes finish, while keeping OPFS reads and seeks paused and waking only when missing pieces are requested.
import { expect, it, vi } from 'vitest'

import { DEMO_SAVE_PATH } from '../../src/torrent/constants'
import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024

const engine = vi.hoisted(() => ({
  queued: new Set<number>(),
  live: new Set<number>(),
  registered: new Set<number>(),
  paused: new Set<number>(),
  autoManaged: new Set<number>(),
  states: new Map<number, number>(),
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
        engine.states.set(h, 3)
        engine.autoManaged.add(h)
        return h
      },
      addTorrentFile: () => {
        const h = ++engine.added
        engine.queued.add(h)
        engine.states.set(h, 3)
        engine.autoManaged.add(h)
        return h
      },
      popAlerts: () => { for (const h of engine.live) engine.registered.add(h); return [] },
      status: (h: number) => {
        if (!engine.registered.has(h)) return null
        const layout = buildLayout(h)
        return {
          state: engine.states.get(h) ?? 3,
          paused: engine.paused.has(h),
          autoManaged: engine.autoManaged.has(h),
          errorCode: 0,
          totalDone: (engine.held.get(h)?.size ?? 0) * MiB,
          downloadRate: 0,
          numPeers: 0,
          activeSeconds: 0,
          seedingSeconds: 0,
          allTimeDownload: (engine.held.get(h)?.size ?? 0) * MiB,
          allTimeUpload: 0,
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

it('pauses a completed ephemeral playback torrent immediately and keeps OPFS reads and seeks paused', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  const h = await addEphemeral('1', [{ size: 4 * MiB, path: 'film.mp4' }])
  engine.held.set(h, range(0, 2))
  rig.send({ type: 'watch', viewer: 'player:1', handle: h, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(engine.setStreamWindowCalls.some((c) => c.handle === h)).toBe(true))
  expect(engine.paused.has(h)).toBe(false)

  // torrent finishes while the player is still open
  engine.held.set(h, range(0, 4))
  engine.states.set(h, 5)
  await vi.waitFor(() => expect(engine.paused.has(h)).toBe(true), { timeout: 2_000 })
  const logCountAfterPark = engine.log.length

  // OPFS reads, sequential re-anchors, and in-file seeks continue serving without waking/seeding
  rig.send({ type: 'read', id: 'opfs-1', handle: h, fileIndex: 0, offset: MiB, len: 64 * 1024, prioritize: true, viewer: 'player:1' })
  await vi.waitFor(() => expect(rig.posted.find((m) => m.id === 'opfs-1')).toMatchObject({ type: 'read-result' }))
  rig.send({ type: 'watch', viewer: 'player:1', handle: h, fileIndex: 0, fromOffset: 2 * MiB, readLen: 64 * 1024 })
  rig.send({ type: 'watch', viewer: 'player:1', handle: h, fileIndex: 0, fromOffset: 3 * MiB })
  await pumps()
  expect(engine.paused.has(h)).toBe(true)
  expect(engine.log.length).toBe(logCountAfterPark)

  // closing the viewer must not turn autoManaged back on and unpark the torrent
  const flagsBefore = engine.flagLog.length
  rig.send({ type: 'unwatch', viewer: 'player:1' })
  await pumps()
  expect(engine.paused.has(h)).toBe(true)
  expect(engine.flagLog.slice(flagsBefore).some((f) => (f.mask & 32) !== 0 && (f.flags & 32) !== 0)).toBe(false)
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('wakes a completion-parked pack when switching to an unheld episode, then re-parks once it finishes', async () => {
  const pack = await addEphemeral('2', [
    { size: 4 * MiB, path: 'e1.mkv' },
    { size: 4 * MiB, path: 'e2.mkv' },
  ])
  engine.held.set(pack, range(0, 4))
  engine.states.set(pack, 4)
  rig.send({ type: 'watch', viewer: 'player:2', handle: pack, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(engine.paused.has(pack)).toBe(true), { timeout: 2_000 })

  // switching to episode 2 whose pieces (4..7) are not held wakes the torrent and plans the window
  const windowsBefore = engine.setStreamWindowCalls.filter((c) => c.handle === pack).length
  rig.send({ type: 'watch', viewer: 'player:2', handle: pack, fileIndex: 1, fromOffset: 0 })
  await vi.waitFor(() => expect(engine.paused.has(pack)).toBe(false), { timeout: 2_000 })
  expect(engine.setStreamWindowCalls.filter((c) => c.handle === pack).length).toBeGreaterThan(windowsBefore)

  // once episode 2 finishes, the pack stops seeding again while playback stays open
  engine.held.set(pack, range(0, 8))
  engine.states.set(pack, 5)
  await vi.waitFor(() => expect(engine.paused.has(pack)).toBe(true), { timeout: 2_000 })
  rig.send({ type: 'unwatch', viewer: 'player:2' })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('waits for prepared next-episode bands in a pack before auto-pausing', async () => {
  const pack = await addEphemeral('3', [
    { size: 10 * MiB, path: 'e1.mkv' },
    { size: 20 * MiB, path: 'e2.mkv' },
  ])
  // file 0 (pieces 0..9) complete, file 1 (pieces 10..29) has only head (10..13) and lacks tail (27..29)
  engine.held.set(pack, range(0, 14))
  engine.states.set(pack, 4)
  rig.send({ type: 'watch', viewer: 'player:3', handle: pack, fileIndex: 0, fromOffset: 0 })
  rig.send({ type: 'watch', viewer: 'next:3', handle: pack, fileIndex: 1, fromOffset: 0, prepare: true })
  await pumps()
  // prepare turned on because player file is held; tail pieces 27..29 of file 1 are still needed
  expect(engine.paused.has(pack)).toBe(false)

  // once tail band (27..29) lands while middle pieces 14..26 remain skipped, it stops seeding
  engine.held.set(pack, new Set([...range(0, 14), 27, 28, 29]))
  await vi.waitFor(() => expect(engine.paused.has(pack)).toBe(true), { timeout: 2_000 })
  rig.send({ type: 'unwatch', viewer: 'player:3' })
  rig.send({ type: 'unwatch', viewer: 'next:3' })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('leaves user-started, force-started, and demo sample ephemeral torrents seeding on completion', async () => {
  const started = await addEphemeral('4', [{ size: 4 * MiB, path: 'film.mp4' }])
  engine.held.set(started, range(0, 4))
  engine.states.set(started, 5)
  rig.send({ type: 'watch', viewer: 'player:4', handle: started, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(engine.paused.has(started)).toBe(true), { timeout: 2_000 })
  rig.send({ type: 'resume', handle: started })
  await vi.waitFor(() => expect(engine.paused.has(started)).toBe(false), { timeout: 2_000 })
  await pumps()
  expect(engine.paused.has(started)).toBe(false)
  rig.send({ type: 'unwatch', viewer: 'player:4' })

  const forcedH = await addEphemeral('5', [{ size: 4 * MiB, path: 'film.mp4' }])
  engine.held.set(forcedH, range(0, 4))
  engine.states.set(forcedH, 5)
  rig.send({ type: 'watch', viewer: 'player:5', handle: forcedH, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(engine.paused.has(forcedH)).toBe(true), { timeout: 2_000 })
  rig.send({ type: 'force-start', handle: forcedH })
  await vi.waitFor(() => expect(engine.paused.has(forcedH)).toBe(false), { timeout: 2_000 })
  await pumps()
  expect(engine.paused.has(forcedH)).toBe(false)
  rig.send({ type: 'unwatch', viewer: 'player:5' })

  const sample = await addEphemeral('6', [{ size: 4 * MiB, path: 'sintel.mp4' }], DEMO_SAVE_PATH)
  engine.held.set(sample, range(0, 4))
  engine.states.set(sample, 5)
  rig.send({ type: 'watch', viewer: 'player:6', handle: sample, fileIndex: 0, fromOffset: 0 })
  await pumps()
  expect(engine.paused.has(sample)).toBe(false)
  rig.send({ type: 'unwatch', viewer: 'player:6' })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('stays parked during a slow OPFS read of already-held bytes and a concurrent re-anchor', async () => {
  const h = await addEphemeral('7', [{ size: 32 * MiB, path: 'film.mp4' }])
  engine.held.set(h, range(0, 32))
  engine.states.set(h, 5)
  rig.send({ type: 'watch', viewer: 'player:7', handle: h, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(engine.paused.has(h)).toBe(true), { timeout: 2_000 })

  const logStart = engine.log.length
  engine.readDelayMs = 600
  try {
    rig.send({ type: 'read', id: 'slow-held-1', handle: h, fileIndex: 0, offset: 0, len: 64 * 1024, prioritize: false, viewer: 'player:7' })
    // Yield so the worker enters session.read with readsByHandle populated, then send a re-anchoring watch mid-read
    await new Promise((resolve) => setTimeout(resolve, 40))
    rig.send({ type: 'watch', viewer: 'player:7', handle: h, fileIndex: 0, fromOffset: 16 * MiB, readLen: 64 * 1024 })
    await vi.waitFor(() => expect(rig.posted.find((m) => m.id === 'slow-held-1')).toMatchObject({ type: 'read-result' }), { timeout: 5_000 })
    await pumps()
  } finally {
    engine.readDelayMs = 0
  }

  expect(engine.paused.has(h)).toBe(true)
  const cycles = engine.log.slice(logStart).filter((entry) => entry.startsWith('resume ') || entry.startsWith('pause '))
  expect(cycles).toEqual([])
  rig.send({ type: 'unwatch', viewer: 'player:7' })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)
