import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A torrent mid-check gets no resume blob. libtorrent 2.0.12 writes only the pieces checked so far, none
 * before the check starts or while it checks resume data, and the restore trusts the blob unhashed, so a
 * torrent paused before its check came back owning nothing and its Resume downloaded it all again
 * (measured on ripple main 3a7d429 in headless Chromium, 2026-11-06).
 */

const CHECKING = 'a'.repeat(40)
const CHECKING_RESUME = 'b'.repeat(40)
const DOWNLOADING = 'c'.repeat(40)

const engine = vi.hoisted(() => ({ saved: [] as number[], store: new Map<string, unknown>() }))

const entry = (infoHash: string): Persisted => ({
  infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/dl/' + infoHash, addedAt: 1, lastUsedAt: 1, started: true,
})

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const status = (state: number) => ({
    state, paused: false, autoManaged: true, errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: 0,
    activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
  })
  // restored in list order: 1 checks its files, 2 checks its resume data, 3 downloads
  const states = new Map([[1, status(1)], [2, status(7)], [3, status(3)]])
  return {
    createSession: async () => fakeSession({
      status: (h: number) => states.get(h) ?? null,
      saveResumeData: async (h: number) => { engine.saved.push(h); return new Uint8Array([h]) },
      pauseTorrent: () => {},
      resumeTorrent: () => {},
      setUploadLimit: () => {},
      setDownloadLimit: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  const { store } = engine
  store.set('ripple:torrents', [entry(CHECKING), entry(CHECKING_RESUME), entry(DOWNLOADING)])
  for (const hash of [CHECKING, CHECKING_RESUME, DOWNLOADING]) store.set('ripple:torrent:' + hash, new Uint8Array([1]))
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('writes no resume blob for a torrent mid-check, on a pause or a handover', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  rig.send({ type: 'pause', handle: 1 })
  rig.send({ type: 'pause', handle: 2 })
  rig.send({ type: 'pause', handle: 3 })
  // THE CONTROL: the pause of a torrent past its check does save its blob
  await vi.waitFor(() => expect(engine.store.get('ripple:resume:' + DOWNLOADING)).toEqual(new Uint8Array([3])))
  rig.send({ type: 'flush-resume' })
  await vi.waitFor(() => expect(engine.saved.filter((h) => h === 3)).toHaveLength(2))

  expect(engine.saved).toEqual([3, 3])
  expect(engine.store.has('ripple:resume:' + CHECKING)).toBe(false)
  expect(engine.store.has('ripple:resume:' + CHECKING_RESUME)).toBe(false)
})
