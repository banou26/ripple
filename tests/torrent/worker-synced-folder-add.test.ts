import type { StorageBackend } from 'libtorrent-wasm/types'
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * Play and an opened link add a torrent rather than start it, and a synced row carries the other device's save path, which
 * takes no writes here. So the add fetches into browser storage as a Download does, keeping a folder choice, and writes
 * that path to the entry the next load restores from. A torrent this device made keeps its own path.
 */

const FOLDER = 'a'.repeat(40)
const PICKED = 'b'.repeat(40)
const MADE = 'c'.repeat(40)
const FILE = 'd'.repeat(40)
const COPIED = 'e'.repeat(40)
const LAYOUT = [{ path: 'Show/ep1.mkv', size: 65_536 }]

const engine = vi.hoisted(() => ({
  storage: null as StorageBackend | null, adds: [] as string[], written: [] as number[], hashes: new Map<number, string>(),
}))
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
      const add = (savePath: string, infoHash?: string) => {
        engine.adds.push(savePath)
        const h = engine.adds.length
        if (infoHash) engine.hashes.set(h, infoHash)
        void storage.onNewStorage(storageOf(h), savePath, LAYOUT)
        return h
      }
      return fakeSession({
        addMagnet: (_magnet: string, savePath: string) => add(savePath),
        // the .torrent of the synced row FILE, or of COPIED when its first byte is 2
        addTorrentFile: (bytes: Uint8Array, savePath: string) => add(savePath, bytes[0] === 2 ? COPIED : FILE),
        infohash: (h: number) => engine.hashes.get(h) ?? null,
        infohashV2: () => null,
        clearStreamWindow: () => {},
        prioritizePieces: () => {},
      })
    },
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1, sequentialDownload: 2 },
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
  const synced = (infoHash: string, root: string): Persisted => ({
    infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: root + infoHash, addedAt: 1, started: false, ephemeral: false,
  })
  // and a torrent made here from picked files, waiting for the person to allow them again
  const made: Persisted = { ...synced(MADE, '/source/'), started: true, saveTo: 'source' }
  store.set('ripple:torrents', [synced(FOLDER, '/native/'), synced(PICKED, '/source/'), made, synced(FILE, '/native/'), synced(COPIED, '/native/')])
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

// as the player opens a torrent
const play = (infoHash: string) => rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + infoHash, ephemeral: true })

it('plays a synced folder torrent from browser storage, and keeps it meant for the folder', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  const lists = rig.of('list').length
  play(FOLDER)
  await vi.waitFor(() => expect(entryOf(FOLDER)?.started).toBe(true))
  expect(await firstPiece(1)).toBe(true)
  expect(engine.adds).toEqual(['/dl/' + FOLDER])
  expect(entryOf(FOLDER)).toMatchObject({ savePath: '/dl/' + FOLDER, saveTo: 'folder', ephemeral: false })
  expect(rig.of('list').slice(lists).at(-1)?.list).toContainEqual(expect.objectContaining({ infoHash: FOLDER, savePath: '/dl/' + FOLDER, saveTo: 'folder' }))
  expect([...rig.of('add-failed'), ...rig.of('worker-error')]).toEqual([])
}, 20_000)

it('plays a torrent made from files picked on another device from browser storage', async () => {
  play(PICKED)
  await vi.waitFor(() => expect(entryOf(PICKED)?.started).toBe(true))
  expect(await firstPiece(2)).toBe(true)
  expect(engine.adds.at(-1)).toBe('/dl/' + PICKED)
  expect(entryOf(PICKED)?.savePath).toBe('/dl/' + PICKED)
  expect(entryOf(PICKED)?.saveTo).toBeUndefined()
}, 20_000)

it('keeps a torrent made here on its own files while it waits for them to be allowed again', async () => {
  play(MADE)
  await vi.waitFor(() => expect(engine.adds).toHaveLength(3))
  expect(engine.adds.at(-1)).toBe('/source/' + MADE)
  await vi.waitFor(() => expect(entryOf(MADE)?.lastUsedAt).toBeGreaterThan(1))
  expect(entryOf(MADE)).toMatchObject({ savePath: '/source/' + MADE, saveTo: 'source', started: true })
}, 20_000)

it('writes where a .torrent of a synced folder torrent fetches to, for the next load to restore it there', async () => {
  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([1]) })
  await vi.waitFor(() => expect(entryOf(FILE)?.started).toBe(true))
  expect(engine.adds.at(-1)).toBe('/dl')
  expect(entryOf(FILE)).toMatchObject({ savePath: '/dl', saveTo: 'folder' })
  expect([...rig.of('add-failed'), ...rig.of('worker-error')]).toEqual([])
}, 20_000)

// a torrent made here and copied into browser storage, which a synced folder row already names: its own files must
// never be moved into the save folder
it('keeps the browser choice of a torrent made here over the folder choice of the synced row it matches', async () => {
  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([2]), savePath: '/dl/' + COPIED, saveTo: 'browser', created: true })
  await vi.waitFor(() => expect(entryOf(COPIED)?.started).toBe(true))
  expect(engine.adds.at(-1)).toBe('/dl/' + COPIED)
  expect(entryOf(COPIED)).toMatchObject({ savePath: '/dl/' + COPIED, saveTo: 'browser', created: true })
  expect([...rig.of('add-failed'), ...rig.of('worker-error')]).toEqual([])
}, 20_000)
