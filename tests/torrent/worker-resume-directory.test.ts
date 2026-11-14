import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A resume blob never stands without its torrent's directory in OPFS. A magnet has no directory until its
 * first write, and the restore reads a blob with no directory behind it as storage the browser cleared: it
 * deletes the blob and stops the torrent. So a magnet that had found nobody yet was stopped by the next start
 * of an engine, and a player showing it never got it back (measured on the swarm rig, 2026-11-14: a watch page
 * behind the relay, the VPN switched off before a byte arrived, and the new engine listed no torrent).
 */

const SEARCHING = 'a'.repeat(40)
const IN_A_FOLDER = 'b'.repeat(40)

const engine = vi.hoisted(() => ({ store: new Map<string, unknown>() }))

const entry = (infoHash: string, savePath: string): Persisted => ({
  infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath, addedAt: 1, lastUsedAt: 1, started: true,
})

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      // still looking for its metadata, with nothing written
      status: () => ({
        state: 2, paused: false, autoManaged: true, errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: 0,
        activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
      }),
      saveResumeData: async (h: number) => new Uint8Array([h]),
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
  store.set('ripple:torrents', [entry(SEARCHING, '/cache/' + SEARCHING), entry(IN_A_FOLDER, '/native/' + IN_A_FOLDER)])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const directory = async (...path: string[]) => {
  let dir = rig.root
  for (const segment of path) dir = await dir.getDirectoryHandle(segment)
  return dir
}

it('makes the directory of a torrent that has written nothing as its resume blob is stored', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  // as the restore found it: no directory anywhere
  expect([...rig.root.children.keys()]).toEqual([])

  rig.send({ type: 'flush-resume', id: 7 })
  await vi.waitFor(() => expect(rig.of('answer')).toEqual([{ type: 'answer', id: 7 }]))

  expect(engine.store.get('ripple:resume:' + SEARCHING)).toEqual(new Uint8Array([1]))
  await expect(directory('cache', SEARCHING)).resolves.toMatchObject({ kind: 'directory' })
  // THE CONTROL: a torrent kept in a folder of the person's own has its blob too, and nothing made in OPFS for it
  expect(engine.store.get('ripple:resume:' + IN_A_FOLDER)).toEqual(new Uint8Array([2]))
  expect([...rig.root.children.keys()]).toEqual(['cache'])
})
