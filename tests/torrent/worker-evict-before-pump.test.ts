import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

/**
 * A cached film the restore's first budget pass gives up leaves the engine, bytes and all.
 *
 * That pass runs before the worker's first alert pump, and the worker forgets the film as it gives it up, so the remove
 * it sends then is the only one. libtorrent-wasm 0.3.22 and older dropped a remove for a handle the pump had not
 * registered yet: on Firefox (2026-11-06, about 1 run in 10) the film's 1.6 GiB stayed in a 2 GiB room and the release
 * opened next was called too big. This engine removes any handle it gave out, as the real one does since then
 * (`worker-early-remove.test.ts`).
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const FILM = 1664 * MiB
const OWN = 320 * MiB
const FILM_HASH = 'c'.repeat(40)

const engine = vi.hoisted(() => ({ added: [] as number[], removed: [] as number[] }))
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
      removeTorrent: (h: number, deleteFiles?: boolean) => { if (engine.added.includes(h) && deleteFiles) engine.removed.push(h) },
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
