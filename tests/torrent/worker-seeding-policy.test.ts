// Library seeding policy stays off by default, enforces ratio and seeding-time limits (OR), persists across restarts, and yields to manual Start or Force start.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { DEFAULT_SEEDING_POLICY, SEEDING_POLICY_KEY } from '../../src/torrent/seeding-policy'
import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024

type MockStatus = {
  state: number
  allTimeDownload: number
  allTimeUpload: number
  seedingSeconds: number
}

const engine = vi.hoisted(() => ({
  queued: new Set<number>(),
  live: new Set<number>(),
  registered: new Set<number>(),
  paused: new Set<number>(),
  autoManaged: new Set<number>(),
  statusByHandle: new Map<number, MockStatus>(),
  held: new Map<number, Set<number>>(),
  filesByHandle: new Map<number, { size: number, path: string }[]>(),
  added: 0,
}))

const store = vi.hoisted(() => {
  const restored: Persisted = {
    infoHash: 'a'.repeat(40),
    magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
    savePath: `/dl/${'a'.repeat(40)}`,
    addedAt: 1,
    downloaded: 4 * 1024 * 1024,
    uploaded: 4 * 1024 * 1024,
    started: true,
    ephemeral: false,
  }
  return new Map<string, unknown>([
    ['ripple:torrents', [restored]],
    ['ripple:seeding-policy', { ratio: 1, minutes: null }],
  ])
})

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
        engine.autoManaged.add(h)
        if (h === 1) {
          // restored library torrent starts already complete having met ratio 1
          engine.statusByHandle.set(h, { state: 5, allTimeDownload: 4 * MiB, allTimeUpload: 4 * MiB, seedingSeconds: 0 })
          engine.held.set(h, new Set([0, 1, 2, 3]))
        } else {
          engine.statusByHandle.set(h, { state: 3, allTimeDownload: 0, allTimeUpload: 0, seedingSeconds: 0 })
        }
        return h
      },
      addTorrentFile: () => {
        const h = ++engine.added
        engine.queued.add(h)
        engine.autoManaged.add(h)
        engine.statusByHandle.set(h, { state: 3, allTimeDownload: 0, allTimeUpload: 0, seedingSeconds: 0 })
        return h
      },
      popAlerts: () => { for (const h of engine.live) engine.registered.add(h); return [] },
      status: (h: number) => {
        if (!engine.registered.has(h)) return null
        const cur = engine.statusByHandle.get(h) ?? { state: 3, allTimeDownload: 0, allTimeUpload: 0, seedingSeconds: 0 }
        return {
          state: cur.state,
          paused: engine.paused.has(h),
          autoManaged: engine.autoManaged.has(h),
          errorCode: 0,
          totalDone: cur.state >= 4 ? 4 * MiB : 0,
          downloadRate: 0,
          numPeers: 0,
          activeSeconds: cur.seedingSeconds,
          seedingSeconds: cur.seedingSeconds,
          allTimeDownload: cur.allTimeDownload,
          allTimeUpload: cur.allTimeUpload,
          wasted: 0,
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
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      prioritizePieces: () => {},
      pauseTorrent: (h: number) => {
        engine.paused.add(h)
        engine.autoManaged.delete(h)
      },
      resumeTorrent: (h: number) => {
        engine.paused.delete(h)
        engine.autoManaged.add(h)
      },
      setFlags: (h: number, flags: number, mask: number) => {
        if (mask & 16) {
          if (flags & 16) engine.paused.add(h)
          else engine.paused.delete(h)
        }
        if (mask & 32) {
          if (flags & 32) engine.autoManaged.add(h)
          else engine.autoManaged.delete(h)
        }
      },
      forceRecheck: (h: number) => { engine.paused.delete(h) },
      saveResumeData: async () => new Uint8Array([1]),
      setDownloadLimit: () => {},
      setUploadLimit: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { seedMode: 1, uploadMode: 2, paused: 16, autoManaged: 32, sequentialDownload: 512 },
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

const pumps = () => new Promise((resolve) => setTimeout(resolve, 1_100))

it('restores stored ratio policy, pauses satisfied completed torrent, and allows clearing and manual Start override', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  // restored torrent 1 satisfies stored { ratio: 1, minutes: null } and pauses
  await vi.waitFor(() => expect(engine.paused.has(1)).toBe(true), { timeout: 2_000 })

  // clearing limits resumes the policy-stopped torrent, while userPaused torrents stay paused
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}`, ephemeral: false })
  await vi.waitFor(() => expect(engine.registered.has(2)).toBe(true))
  engine.statusByHandle.set(2, { state: 5, allTimeDownload: 4 * MiB, allTimeUpload: 4 * MiB, seedingSeconds: 0 })
  await vi.waitFor(() => expect(engine.paused.has(2)).toBe(true), { timeout: 2_000 })
  rig.send({ type: 'pause', handle: 2 })
  await pumps()

  rig.send({ type: 'set-seeding-policy', policy: DEFAULT_SEEDING_POLICY })
  await vi.waitFor(() => expect(store.get(SEEDING_POLICY_KEY)).toEqual(DEFAULT_SEEDING_POLICY))
  await vi.waitFor(() => expect(engine.paused.has(1)).toBe(false), { timeout: 2_000 })
  expect(engine.paused.has(2)).toBe(true)

  // manual Start overrides an active limit on a completed torrent across subsequent pumps
  rig.send({ type: 'set-seeding-policy', policy: { ratio: 1, minutes: null } })
  await vi.waitFor(() => expect(engine.paused.has(1)).toBe(true), { timeout: 2_000 })
  rig.send({ type: 'resume', handle: 1 })
  await vi.waitFor(() => expect(engine.paused.has(1)).toBe(false), { timeout: 2_000 })
  await pumps()
  expect(engine.paused.has(1)).toBe(false)

  // changing the policy clears bypass and applies the new limit
  rig.send({ type: 'set-seeding-policy', policy: { ratio: 1, minutes: 10 } })
  await vi.waitFor(() => expect(engine.paused.has(1)).toBe(true), { timeout: 2_000 })

  // Force start overrides limits too
  rig.send({ type: 'force-start', handle: 1 })
  await vi.waitFor(() => expect(engine.paused.has(1)).toBe(false), { timeout: 2_000 })
  await pumps()
  expect(engine.paused.has(1)).toBe(false)
}, 20_000)

it('enforces ratio, seeding duration, and combined OR limits only after completion', async () => {
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}`, ephemeral: false })
  await vi.waitFor(() => expect(engine.registered.has(3)).toBe(true))

  // downloading (state 3) and checking (state 1) never stop even past thresholds
  rig.send({ type: 'set-seeding-policy', policy: { ratio: 1, minutes: 1 } })
  engine.statusByHandle.set(3, { state: 3, allTimeDownload: 2 * MiB, allTimeUpload: 10 * MiB, seedingSeconds: 10_000 })
  await pumps()
  expect(engine.paused.has(3)).toBe(false)

  engine.statusByHandle.set(3, { state: 1, allTimeDownload: 2 * MiB, allTimeUpload: 10 * MiB, seedingSeconds: 10_000 })
  await pumps()
  expect(engine.paused.has(3)).toBe(false)

  // ratio threshold waits until met
  rig.send({ type: 'set-seeding-policy', policy: { ratio: 1.5, minutes: null } })
  engine.statusByHandle.set(3, { state: 5, allTimeDownload: 4 * MiB, allTimeUpload: 5 * MiB, seedingSeconds: 10 })
  await pumps()
  expect(engine.paused.has(3)).toBe(false)
  engine.statusByHandle.set(3, { state: 5, allTimeDownload: 4 * MiB, allTimeUpload: 6 * MiB, seedingSeconds: 10 })
  await vi.waitFor(() => expect(engine.paused.has(3)).toBe(true), { timeout: 2_000 })

  // raising ratio threshold resumes seeding until reached again
  rig.send({ type: 'set-seeding-policy', policy: { ratio: 2, minutes: null } })
  await vi.waitFor(() => expect(engine.paused.has(3)).toBe(false), { timeout: 2_000 })

  // combined ratio + time limit stops as soon as duration reaches its threshold
  rig.send({ type: 'set-seeding-policy', policy: { ratio: 2, minutes: 10 } })
  engine.statusByHandle.set(3, { state: 5, allTimeDownload: 4 * MiB, allTimeUpload: 6 * MiB, seedingSeconds: 599 })
  await pumps()
  expect(engine.paused.has(3)).toBe(false)
  engine.statusByHandle.set(3, { state: 5, allTimeDownload: 4 * MiB, allTimeUpload: 6 * MiB, seedingSeconds: 600 })
  await vi.waitFor(() => expect(engine.paused.has(3)).toBe(true), { timeout: 2_000 })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('keeps a newly created source torrent seeding until its configured seeding limit is reached', async () => {
  rig.send({ type: 'set-seeding-policy', policy: { ratio: 1, minutes: 5 } })
  rig.send({
    type: 'create-source',
    infoHash: 'd'.repeat(40),
    magnet: `magnet:?xt=urn:btih:${'d'.repeat(40)}`,
    bytes: new Uint8Array([1, 2, 3]),
    handles: [{ kind: 'file' } as never],
    name: 'my-release',
    size: 4 * MiB,
    files: [{ name: 'my-release.mkv', size: 4 * MiB }],
  })
  await vi.waitFor(() => expect(engine.added).toBeGreaterThanOrEqual(4))
  const h = engine.added
  await vi.waitFor(() => expect(engine.registered.has(h)).toBe(true))
  engine.statusByHandle.set(h, { state: 5, allTimeDownload: 0, allTimeUpload: 0, seedingSeconds: 0 })
  await pumps()
  expect(engine.paused.has(h)).toBe(false)

  // Once it seeds 4 MiB (ratio 1 against content size), it stops
  engine.statusByHandle.set(h, { state: 5, allTimeDownload: 0, allTimeUpload: 4 * MiB, seedingSeconds: 30 })
  await vi.waitFor(() => expect(engine.paused.has(h)).toBe(true), { timeout: 2_000 })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)
