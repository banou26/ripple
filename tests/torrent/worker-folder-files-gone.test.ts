import type { StorageBackend } from 'libtorrent-wasm/types'
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * A torrent kept in the person's folder whose files were deleted outside Ripple goes to "Files missing" once the
 * folder is allowed again, and never before.
 *
 * The engine restores a saved state without asking the storage anything (`no_verify_files`): measured on
 * libtorrent-wasm 0.3.28 in node, 2026-11-16, a torrent whose files were gone came back seeding at progress 1 with no
 * check asked. And until the page offers the folder, a file that is not there and a folder not allowed yet read the
 * same, so nothing may be given up at restore.
 */

const GONE = 'a'.repeat(40)
const KEPT = 'b'.repeat(40)
const REFUSED = 'c'.repeat(40)
const LAYOUTS: Record<string, { path: string, size: number }[]> = {
  [GONE]: [{ path: 'Gone/ep1.mkv', size: 50_000 }, { path: 'Gone/ep2.mkv', size: 50_000 }],
  [KEPT]: [{ path: 'Kept/film.mkv', size: 80_000 }],
  [REFUSED]: [{ path: 'Refused/film.mkv', size: 80_000 }],
}
// what the engine reports of a torrent restored from a saved state, whatever is on disk
const SEEDING = {
  state: 5, paused: false, autoManaged: true, errorCode: 0, totalDone: 1, downloadRate: 0, numPeers: 0, progress: 1,
  activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
}

const store = vi.hoisted(() => new Map<string, unknown>())
const handleOf = vi.hoisted(() => new Map<string, number>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const hashOf = (h: number) => [...handleOf].find(([, id]) => id === h)?.[0]
  return {
    createSession: async ({ storage }: { storage: StorageBackend }) => fakeSession({
      addTorrentWithResume: (_blob: Uint8Array, savePath: string) => {
        const hash = savePath.slice(-40)
        const h = handleOf.size + 1
        handleOf.set(hash, h)
        void storage.onNewStorage(h, savePath, LAYOUTS[hash]!)
        return h
      },
      status: (h: number) => (hashOf(h) ? SEEDING : null),
      files: (h: number) => {
        const files = LAYOUTS[hashOf(h)!]
        if (!files) return null
        let offset = 0
        const placed = files.map((f) => ({ ...f, offset: (offset += f.size) - f.size, pad: false }))
        return { storageIndex: h, pieceLength: 16_384, numPieces: 12, totalSize: offset, contentSize: offset, files: placed }
      },
      saveResumeData: async () => new Uint8Array([9]),
      pauseTorrent: () => {},
      resumeTorrent: () => {},
      clearStreamWindow: () => {},
      prioritizePieces: () => {},
      setSequential: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  store.set('ripple:torrents', Object.keys(LAYOUTS).map((infoHash): Persisted => ({
    infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/native/' + infoHash, saveTo: 'folder',
    addedAt: 1, lastUsedAt: 1, started: true, paused: false, ephemeral: false,
  })))
  for (const infoHash of Object.keys(LAYOUTS)) store.set('ripple:resume:' + infoHash, new Uint8Array([1]))
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

/** The person's folder: each file's size by its path, and the directories it refuses to open. */
const folder = (files: Record<string, number>, refused: string[] = []) => {
  const at = (prefix: string): FileSystemDirectoryHandle => ({
    keys: () => ({ next: async () => ({ done: true, value: undefined }) }),
    getDirectoryHandle: async (name: string) => {
      const under = prefix + name + '/'
      if (refused.includes(under)) throw new DOMException(under, 'NotAllowedError')
      if (!Object.keys(files).some((path) => path.startsWith(under))) throw new DOMException(under, 'NotFoundError')
      return at(under)
    },
    getFileHandle: async (name: string) => {
      const size = files[prefix + name]
      if (size === undefined) throw new DOMException(prefix + name, 'NotFoundError')
      return { getFile: async () => ({ size }) }
    },
  } as unknown as FileSystemDirectoryHandle)
  return at('')
}

const entryOf = (infoHash: string) => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === infoHash)
const pumps = (n: number) => new Promise((resolve) => setTimeout(resolve, n * 500 + 100))
const removed = () => sessions[0]!.removed

it('keeps every folder torrent and its saved state while the folder is not allowed yet', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  await pumps(3)
  expect(removed()).toEqual([])
  for (const infoHash of [GONE, KEPT, REFUSED]) {
    expect(store.get('ripple:resume:' + infoHash), infoHash).toBeDefined()
    expect(entryOf(infoHash), infoHash).toMatchObject({ started: true, savePath: '/native/' + infoHash })
  }
}, 20_000)

it('gives up one whose files are gone once the folder is allowed, and keeps one there or unreadable', async () => {
  rig.send({ type: 'set-folder', handle: folder({ 'Kept/film.mkv': 80_000 }, ['Refused/']) })
  await vi.waitFor(() => expect(entryOf(GONE)?.started).toBe(false), { timeout: 5_000 })
  // Files missing, with nothing claimed of a disk that has none of it, and a Download that fetches into browser storage
  expect(store.has('ripple:resume:' + GONE)).toBe(false)
  expect(entryOf(GONE)).toMatchObject({ savePath: '/dl/' + GONE, saveTo: 'folder' })
  expect(removed()).toEqual([handleOf.get(GONE)])
  await pumps(2)
  expect(removed()).toEqual([handleOf.get(GONE)])
  for (const infoHash of [KEPT, REFUSED]) {
    expect(store.get('ripple:resume:' + infoHash), infoHash).toBeDefined()
    expect(entryOf(infoHash), infoHash).toMatchObject({ started: true, savePath: '/native/' + infoHash })
  }
}, 20_000)

it('asks once per restore, so a folder offered later that holds none of them gives up nothing', async () => {
  rig.send({ type: 'set-folder', handle: null })
  rig.send({ type: 'set-folder', handle: folder({}) })
  await pumps(3)
  expect(removed()).toEqual([handleOf.get(GONE)])
  for (const infoHash of [KEPT, REFUSED]) expect(entryOf(infoHash)?.started, infoHash).toBe(true)
  expect(rig.of('worker-error')).toEqual([])
}, 20_000)
