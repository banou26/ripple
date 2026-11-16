// A torrent moved to the person's folder and back keeps the files they left out.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024
const MOVED = 'a'.repeat(40)

// each map the engine was given, by handle
const engine = vi.hoisted(() => ({ added: 0, plans: [] as string[] }))
const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { DOWNLOADING, fakeSession } = await import('../utils/worker-rig')
  // two files of 10 pieces each
  const layout = { storageIndex: 0, pieceLength: MiB, numPieces: 20, totalSize: 20 * MiB, contentSize: 20 * MiB, files: [
    { path: 'Pack/E01.mkv', offset: 0, size: 10 * MiB, pad: false },
    { path: 'Pack/E02.mkv', offset: 10 * MiB, size: 10 * MiB, pad: false },
  ] }
  return {
    createSession: async () => fakeSession({
      addMagnet: () => ++engine.added,
      status: () => DOWNLOADING,
      files: () => layout,
      clearStreamWindow: () => {},
      saveResumeData: async () => new Uint8Array([1]),
      prioritizePieces: (h: number, map: Uint8Array) => { engine.plans.push(`${h}: ${[...new Set(map)].join(' ')}`) },
    }),
    PRIORITY: { skip: 0, normal: 4, top: 7 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, usageOfStorage: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  const entry: Persisted = {
    infoHash: MOVED, magnet: 'magnet:?xt=urn:btih:' + MOVED, savePath: '/dl/' + MOVED, addedAt: 1, started: true, paused: false, wantedFiles: [1],
  }
  store.set('ripple:torrents', [entry])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('writes the stored file selection to the engine after a move to the folder and after a move back', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  // THE CONTROL: the restored torrent has its left-out file skipped
  await vi.waitFor(() => expect(engine.plans).toContain('1: 0 4'))

  rig.send({ type: 'relocate', infoHash: MOVED, to: 'folder' })
  await vi.waitFor(() => expect(engine.added).toBe(2))
  await vi.waitFor(() => expect(engine.plans, 'the move to the folder forgot the file selection').toContain('2: 0 4'), { timeout: 3_000 })

  rig.send({ type: 'relocate', infoHash: MOVED, to: 'browser' })
  await vi.waitFor(() => expect(engine.added).toBe(3))
  await vi.waitFor(() => expect(engine.plans, 'the move back forgot the file selection').toContain('3: 0 4'), { timeout: 3_000 })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
})
