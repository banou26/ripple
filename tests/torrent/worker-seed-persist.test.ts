// Persisted `seedStopped` and `seedBypass` survive worker reloads device-locally without syncing to cloud backups.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { DEFAULT_SEEDING_POLICY } from '../../src/torrent/seeding-policy'
import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024
const SEED_STOPPED_HASH = 'e'.repeat(40)
const SEED_BYPASS_HASH = 'f'.repeat(40)

const engine = vi.hoisted(() => ({
  queued: new Set<number>(),
  live: new Set<number>(),
  registered: new Set<number>(),
  paused: new Set<number>(),
  autoManaged: new Set<number>(),
  resumedHandles: [] as number[],
  statusByHandle: new Map<number, { state: number, allTimeDownload: number, allTimeUpload: number, seedingSeconds: number }>(),
  added: 0,
}))

const store = vi.hoisted(() => {
  const stoppedEntry: Persisted = {
    infoHash: 'e'.repeat(40),
    magnet: `magnet:?xt=urn:btih:${'e'.repeat(40)}`,
    savePath: `/dl/${'e'.repeat(40)}`,
    addedAt: 1,
    downloaded: 4 * 1024 * 1024,
    uploaded: 4 * 1024 * 1024,
    started: true,
    ephemeral: false,
    seedStopped: true,
    seedBypass: false,
  }
  const bypassEntry: Persisted = {
    infoHash: 'f'.repeat(40),
    magnet: `magnet:?xt=urn:btih:${'f'.repeat(40)}`,
    savePath: `/dl/${'f'.repeat(40)}`,
    addedAt: 2,
    downloaded: 4 * 1024 * 1024,
    uploaded: 4 * 1024 * 1024,
    started: true,
    ephemeral: false,
    seedStopped: false,
    seedBypass: true,
  }
  return new Map<string, unknown>([
    ['ripple:torrents', [stoppedEntry, bypassEntry]],
    ['ripple:seeding-policy', { ratio: 1, minutes: null }],
  ])
})

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }),
  root: fakeDir('', [fakeDir('dl', [fakeDir('e'.repeat(40)), fakeDir('f'.repeat(40))])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const tick = () => { for (const h of engine.queued) engine.live.add(h); engine.queued.clear() }
  setInterval(tick, 50)
  return {
    createSession: async () => fakeSession({
      tick,
      addTorrentWithResume: (_resume: Uint8Array, savePath: string) => {
        const h = ++engine.added
        engine.queued.add(h)
        engine.autoManaged.add(h)
        // Simulate a stale unpaused resume blob so only restored seedStopped keeps handle 1 paused on boot.
        if (savePath.includes(SEED_STOPPED_HASH)) engine.paused.delete(h)
        engine.statusByHandle.set(h, { state: 5, allTimeDownload: 4 * MiB, allTimeUpload: 4 * MiB, seedingSeconds: 0 })
        return h
      },
      addMagnet: () => {
        const h = ++engine.added
        engine.queued.add(h)
        engine.autoManaged.add(h)
        engine.statusByHandle.set(h, { state: 5, allTimeDownload: 4 * MiB, allTimeUpload: 4 * MiB, seedingSeconds: 0 })
        return h
      },
      popAlerts: () => { for (const h of engine.live) engine.registered.add(h); return [] },
      status: (h: number) => {
        if (!engine.registered.has(h)) return null
        const cur = engine.statusByHandle.get(h)!
        return {
          state: cur.state,
          paused: engine.paused.has(h),
          autoManaged: engine.autoManaged.has(h),
          errorCode: 0,
          totalDone: 4 * MiB,
          downloadRate: 0,
          numPeers: 0,
          activeSeconds: cur.seedingSeconds,
          seedingSeconds: cur.seedingSeconds,
          allTimeDownload: cur.allTimeDownload,
          allTimeUpload: cur.allTimeUpload,
          wasted: 0,
        }
      },
      files: () => null,
      pauseTorrent: (h: number) => {
        engine.paused.add(h)
        engine.autoManaged.delete(h)
      },
      resumeTorrent: (h: number) => {
        engine.resumedHandles.push(h)
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

it('restores persisted seedStopped (never unpausing at boot) and seedBypass across reloads', async () => {
  store.set(`ripple:resume:${SEED_STOPPED_HASH}`, new Uint8Array([1]))
  store.set(`ripple:resume:${SEED_BYPASS_HASH}`, new Uint8Array([1]))

  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  await vi.waitFor(() => expect(engine.registered.has(1) && engine.registered.has(2)).toBe(true))

  // Handle 1 (persisted seedStopped: true) stays paused and was NEVER unpaused via resumeTorrent at restore
  await vi.waitFor(() => expect(engine.paused.has(1)).toBe(true), { timeout: 2_000 })
  expect(engine.resumedHandles).not.toContain(1)

  // Handle 2 (persisted seedBypass: true) stays seeding despite active ratio 1 limit being met
  await new Promise((resolve) => setTimeout(resolve, 600))
  expect(engine.paused.has(2)).toBe(false)

  // Clearing policy resumes handle 1 and clears seedStopped in IDB
  rig.send({ type: 'set-seeding-policy', policy: DEFAULT_SEEDING_POLICY })
  await vi.waitFor(() => expect(engine.paused.has(1)).toBe(false), { timeout: 2_000 })
  await vi.waitFor(() => {
    const saved = (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === SEED_STOPPED_HASH)
    expect(saved?.seedStopped).toBe(false)
  })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 15_000)
