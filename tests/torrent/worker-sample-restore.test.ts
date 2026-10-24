import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { DEMO_MAGNET, DEMO_SAVE_PATH } from '../../src/torrent/constants'
import { magnetInfoHash } from '../../src/torrent/magnet'
import { fakeDir, installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * The sample, reloaded mid-download, goes on downloading like a torrent of one's own.
 *
 * It is temporary, and the restore used to idle-park it like a cache torrent nobody was watching,
 * inside its check, where the row offers neither Pause nor Resume: "0 B / 129.3 MB, Checking" for
 * as long as anybody waited (ripple 7229a26, 2026-10-24). Every other temporary torrent is still
 * parked, Sintel included when a page opens it: telling the two apart by infohash alone kept the
 * download page's held Sintel downloading.
 */

const SINTEL = magnetInfoHash(DEMO_MAGNET)!
const CACHED = 'c'.repeat(40)
const SAMPLE_HANDLE = 1
const CACHED_HANDLE = 2
const PAGE_HANDLE = 3

const engine = vi.hoisted(() => ({ added: [] as number[], registered: new Set<number>(), paused: [] as number[] }))

const entry = (infoHash: string, savePath: string): Persisted => ({
  infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath, addedAt: 1, lastUsedAt: 1, started: true, paused: false, ephemeral: true,
})

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }),
  root: fakeDir('', [fakeDir('dl', [fakeDir(SINTEL)]), fakeDir('cache', [fakeDir(CACHED)])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const size = 129_241_752
  const running = {
    state: 3, paused: false, autoManaged: true, errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: 0,
    activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
  }
  const add = () => {
    const h = engine.added.length + 1
    engine.added.push(h)
    return h
  }
  return {
    createSession: async () => fakeSession({
      addTorrentWithResume: add,
      addMagnet: add,
      popAlerts: () => { for (const h of engine.added) engine.registered.add(h); return [] },
      status: (h: number) => (engine.registered.has(h) ? running : null),
      files: (h: number) => engine.registered.has(h) ? {
        storageIndex: 0, pieceLength: 131_072, numPieces: Math.ceil(size / 131_072), totalSize: size, contentSize: size,
        files: [{ path: 'Sintel/Sintel.mp4', offset: 0, size, pad: false }],
      } : null,
      clearStreamWindow: () => {},
      setDownloadLimit: () => {},
      setUploadLimit: () => {},
      saveResumeData: async () => new Uint8Array([1]),
      pauseTorrent: (h: number) => { engine.paused.push(h) },
      resumeTorrent: () => {},
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
  const store = new Map<string, unknown>([
    ['ripple:torrents', [entry(SINTEL, DEMO_SAVE_PATH), entry(CACHED, '/cache/' + CACHED)]],
    ['ripple:resume:' + SINTEL, new Uint8Array([1])],
    ['ripple:resume:' + CACHED, new Uint8Array([1])],
  ])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('keeps a reloaded sample downloading, and still parks every other temporary torrent', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  // THE CONTROL: the pump reached the idle park, which decides both torrents in the same pass
  await vi.waitFor(() => expect(engine.paused).toContain(CACHED_HANDLE))
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  expect(engine.paused, 'the sample was parked').not.toContain(SAMPLE_HANDLE)

  // the same torrent opened by the download page, which holds it once its file list is in
  rig.send({ type: 'remove', handle: SAMPLE_HANDLE })
  await vi.waitFor(() => expect(sessions[0]?.removed).toEqual([SAMPLE_HANDLE]))
  rig.send({ type: 'add-magnet', magnet: DEMO_MAGNET, ephemeral: true, hold: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  await vi.waitFor(() => expect(engine.paused, 'Sintel opened by a page was not parked').toContain(PAGE_HANDLE))
})
