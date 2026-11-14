import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * The engine learns a handle at the first pump after its add, and never answers a save asked for before that:
 * the wait gave up 8 s later as "save_resume_data timed out". A flush sent to an engine as it started, which
 * two changes of the VPN in a row do, waited for it, and the engine that stayed logged an error (the 20 changes
 * of tests/vpn-off.spec.ts on a CI runner, 2026-11-14).
 */

const FILM = 'a'.repeat(40)

const engine = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  /** whether the engine has reported on the torrent */
  known: false,
  asked: 0,
}))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { DOWNLOADING, fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      status: () => engine.known ? DOWNLOADING : null,
      saveResumeData: () => {
        engine.asked++
        return engine.known ? Promise.resolve(new Uint8Array([1])) : new Promise<Uint8Array>(() => {})
      },
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
  const entry: Persisted = { infoHash: FILM, magnet: 'magnet:?xt=urn:btih:' + FILM, savePath: '/dl/' + FILM, addedAt: 1, lastUsedAt: 1, started: true }
  store.set('ripple:torrents', [entry])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('asks the engine for no save before it has reported on the torrent, and answers the flush', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  rig.send({ type: 'flush-resume', id: 7 })
  await vi.waitFor(() => expect(rig.of('answer'), 'the flush waited for a save the engine never answers').toEqual([{ type: 'answer', id: 7 }]))
  expect(engine.asked).toBe(0)

  engine.known = true
  rig.send({ type: 'flush-resume', id: 8 })
  await vi.waitFor(() => expect(rig.of('answer')).toHaveLength(2))
  expect(engine.asked, 'a torrent the engine reports on was not saved').toBe(1)
  expect(engine.store.get('ripple:resume:' + FILM)).toEqual(new Uint8Array([1]))
})
