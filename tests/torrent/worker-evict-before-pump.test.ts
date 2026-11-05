import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

/**
 * A cached film the restore's first budget pass gives up leaves the engine, bytes and all.
 *
 * That pass runs before the worker's first alert pump, and this engine does what libtorrent-wasm 0.3.21 does: a
 * command reaches only a handle the pump has registered, and a remove before it is dropped without a word. The worker
 * had already forgotten the film by then, so nothing removed it again: on Firefox (2026-11-06, about 1 run in 10) its
 * 1.6 GiB stayed in a 2 GiB room and the release opened next was called too big.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const FILM = 1664 * MiB
const OWN = 320 * MiB
const FILM_HASH = 'c'.repeat(40)

const engine = vi.hoisted(() => ({ added: [] as number[], registered: new Set<number>(), removed: [] as number[] }))
const gone = () => engine.removed.includes(1)

const film: Persisted = {
  infoHash: FILM_HASH,
  magnet: 'magnet:?xt=urn:btih:' + FILM_HASH,
  savePath: '/cache/' + FILM_HASH,
  addedAt: 1,
  lastUsedAt: 1,
  started: true,
  ephemeral: true,
}

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: OWN + (gone() ? 0 : FILM), quota: 2 * GiB }),
  root: fakeDir('', [fakeDir('cache', [fakeDir(FILM_HASH)])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      addMagnet: () => {
        const h = engine.added.length + 1
        engine.added.push(h)
        return h
      },
      popAlerts: () => { for (const h of engine.added) engine.registered.add(h); return [] },
      removeTorrent: (h: number) => { if (engine.registered.has(h)) engine.removed.push(h) },
      pauseTorrent: () => {},
      resumeTorrent: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => (gone() ? 0 : FILM), refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>([['ripple:torrents', [film]]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('removes the cached film it gives up before the first alert pump from the engine', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  await vi.waitFor(() => expect(engine.removed, 'the film given up stayed in the engine').toEqual([1]), { timeout: 2_000 })
  expect(rig.of('storage-full').filter((m) => m.full)).toEqual([])
  expect(rig.of('worker-error')).toEqual([])
})
