import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A flush is answered once every torrent's resume blob is as of the flush, because the page replaces the
 * engine as soon as it is answered (a change of the VPN, an update). A save already under way is skipped by a
 * second one, so the flush used to be answered at once with that save still to land: on a download that had
 * just completed, 1 ms after it was asked, with no blob stored yet in 1 run of 3 (headless Chromium,
 * 2026-11-14). On the swarm rig a film watched with the VPN off and switched back on as it completed came
 * back as a magnet with no metadata and nothing held.
 */

const FILM = 'a'.repeat(40)

const engine = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  /** each save the engine was asked for and has not answered yet, oldest first */
  asked: [] as ((blob: Uint8Array) => void)[],
}))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      status: () => ({
        state: 3, paused: false, autoManaged: true, errorCode: 0, totalDone: 1, downloadRate: 0, numPeers: 0,
        activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
      }),
      saveResumeData: () => new Promise<Uint8Array>((resolve) => { engine.asked.push(resolve) }),
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

const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

it('answers a flush only once a save that was under way has landed and the torrent was saved again', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  // a save the engine has not answered yet, as the one a completed download starts by itself
  rig.send({ type: 'pause', handle: 1 })
  await vi.waitFor(() => expect(engine.asked).toHaveLength(1))

  rig.send({ type: 'flush-resume', id: 7 })
  await settled()
  expect(rig.of('answer'), 'answered while the save under way had not landed').toEqual([])
  expect(engine.asked, 'a second save was stacked on the first').toHaveLength(1)

  engine.asked[0]!(new Uint8Array([1]))
  await vi.waitFor(() => expect(engine.asked, 'the torrent was not saved again once the first save landed').toHaveLength(2))
  expect(engine.store.get('ripple:resume:' + FILM)).toEqual(new Uint8Array([1]))
  expect(rig.of('answer'), 'answered with the blob of before the flush').toEqual([])

  engine.asked[1]!(new Uint8Array([2]))
  await vi.waitFor(() => expect(rig.of('answer')).toEqual([{ type: 'answer', id: 7 }]))
  expect(engine.store.get('ripple:resume:' + FILM)).toEqual(new Uint8Array([2]))
})
