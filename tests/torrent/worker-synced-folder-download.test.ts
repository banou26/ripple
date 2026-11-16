import type { StorageBackend } from 'libtorrent-wasm/types'
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A torrent synced from another device arrives with that device's save path, and its Download here fetches into
 * browser storage whatever the path says: a folder takes no writes, and neither do files picked on another device.
 * One kept in a folder there keeps its choice, so it moves into this device's folder once it finishes.
 */

const FOLDER = 'a'.repeat(40)
const PICKED = 'b'.repeat(40)
const LAYOUT = [{ path: 'Show/ep1.mkv', size: 65_536 }]

const engine = vi.hoisted(() => ({ storage: null as StorageBackend | null, adds: [] as string[], written: [] as number[] }))
const store = vi.hoisted(() => new Map<string, unknown>())
// the engine numbers its storages apart from its handles
const storageOf = (h: number) => h + 100

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async ({ storage }: { storage: StorageBackend }) => {
      engine.storage = storage
      return fakeSession({
        addMagnet: (_magnet: string, savePath: string) => {
          engine.adds.push(savePath)
          const h = engine.adds.length
          void storage.onNewStorage(storageOf(h), savePath, LAYOUT)
          return h
        },
        clearStreamWindow: () => {},
        prioritizePieces: () => {},
      })
    },
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
// browser storage, which takes every write
vi.mock('../../src/torrent/opfs-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/opfs-storage')>()),
  createResilientStorage: () => ({
    onNewStorage: () => {},
    onRemoveStorage: () => {},
    read: (_id: number, _file: number, _offset: number, len: number) => new Uint8Array(len),
    write: (id: number, _file: number, _offset: number, bytes: Uint8Array) => { engine.written.push(id); return bytes.length },
    usageOf: async () => 0,
    usageOfStorage: async () => 0,
    refusedFile: () => undefined,
  }),
}))
vi.mock('idb-keyval', () => {
  // as the list import writes a row from another device: its save path, no save location, not started here
  store.set('ripple:torrents', [[FOLDER, '/native/'], [PICKED, '/source/']].map(([infoHash, root]): Persisted => ({
    infoHash: infoHash!, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: root + infoHash!, addedAt: 1, started: false, ephemeral: false,
  })))
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const entryOf = (infoHash: string) => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === infoHash)

// the first piece the swarm sends, written where the engine was told to keep the torrent
const firstPiece = async (h: number) => {
  await engine.storage!.write(storageOf(h), 0, 0, new Uint8Array(16_384))
  return engine.written.includes(storageOf(h))
}

it('fetches a synced folder torrent into browser storage, and keeps it meant for the folder', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'start', infoHash: FOLDER })
  await vi.waitFor(() => expect(entryOf(FOLDER)?.started).toBe(true))
  expect(await firstPiece(1)).toBe(true)
  expect(engine.adds).toEqual(['/dl/' + FOLDER])
  expect(entryOf(FOLDER)).toMatchObject({ savePath: '/dl/' + FOLDER, saveTo: 'folder' })
  expect(rig.of('add-failed')).toEqual([])
}, 20_000)

it('fetches a torrent made from files picked on another device into browser storage', async () => {
  rig.send({ type: 'start', infoHash: PICKED })
  await vi.waitFor(() => expect(entryOf(PICKED)?.started).toBe(true))
  expect(await firstPiece(2)).toBe(true)
  expect(engine.adds).toEqual(['/dl/' + FOLDER, '/dl/' + PICKED])
  expect(entryOf(PICKED)?.savePath).toBe('/dl/' + PICKED)
  expect(entryOf(PICKED)?.saveTo).toBeUndefined()
  expect([...rig.of('add-failed'), ...rig.of('worker-error')]).toEqual([])
}, 20_000)
