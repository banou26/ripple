import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A torrent copied in from the player: listed before any of it is in the engine, then added with the
 * blob the tab rewrote, at the chunk directory it copied into, as a library download. The player's
 * blob carries its own download limit, a window's trickle included, so the engine is told none, and
 * its piece priorities, a window's skips included, which the priority reset writes over. This engine
 * does what libtorrent-wasm 0.3.21 was measured doing (node, 2026-10-23): an add with a blob takes the
 * blob's limit and pause, and a command sent before the alert pump has registered the handle is dropped.
 */

const TRICKLE = 16 * 1024
const HASH = 'c'.repeat(40)
const MAGNET = 'magnet:?xt=urn:btih:' + HASH + '&dn=Film'

const engine = vi.hoisted(() => ({
  added: [] as { blob: Uint8Array, savePath: string }[],
  registered: new Set<number>(),
  limit: new Map<number, number>(),
  paused: new Set<number>(),
  cleared: [] as number[],
  store: new Map<string, unknown>(),
}))

const blobLimited = (limit: number) => new TextEncoder().encode(`d19:download_rate_limiti${limit}e6:pausedi1ee`)
const limitIn = (blob: Uint8Array) => Number(/download_rate_limiti(-?\d+)e/.exec(new TextDecoder().decode(blob))?.[1] ?? -1)
const PIECE = 16 * 1024

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const running = {
    state: 3, paused: false, autoManaged: false, errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: 0,
    activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
  }
  return {
    createSession: async () => fakeSession({
      addTorrentWithResume: (blob: Uint8Array, savePath: string) => {
        engine.added.push({ blob, savePath })
        const h = engine.added.length
        engine.limit.set(h, limitIn(blob))
        if (/6:pausedi1e/.test(new TextDecoder().decode(blob))) engine.paused.add(h)
        return h
      },
      popAlerts: () => { for (let h = 1; h <= engine.added.length; h++) engine.registered.add(h); return [] },
      status: (h: number) => (engine.registered.has(h) ? { ...running, paused: engine.paused.has(h) } : null),
      files: (h: number) => (engine.registered.has(h)
        ? { storageIndex: 0, pieceLength: PIECE, numPieces: 1, totalSize: PIECE, contentSize: PIECE, files: [{ path: 'film.mkv', offset: 0, size: PIECE, pad: false }] }
        : null),
      clearStreamWindow: (h: number) => { if (engine.registered.has(h)) engine.cleared.push(h) },
      setDownloadLimit: (h: number, limit: number) => { if (engine.registered.has(h)) engine.limit.set(h, limit) },
      setUploadLimit: () => {},
      pauseTorrent: () => {},
      resumeTorrent: (h: number) => { if (engine.registered.has(h)) engine.paused.delete(h) },
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => engine.store.get(key),
  set: async (key: string, value: unknown) => { engine.store.set(key, value) },
  del: async (key: string) => { engine.store.delete(key) },
  update: async (key: string, fn: (prev: unknown) => unknown) => { engine.store.set(key, fn(engine.store.get(key))) },
}))

const listed = () => (engine.store.get('ripple:torrents') as Persisted[] | undefined) ?? []

it('lists the torrent while it copies, then adds it from the copy at full speed', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  rig.send({ type: 'import-start', id: 1, infoHash: HASH, magnet: MAGNET })
  // answered once the entry is written, which is what lets the tab start writing
  await vi.waitFor(() => expect(rig.of('answer')).toEqual([{ type: 'answer', id: 1, value: true }]))
  expect(listed()).toHaveLength(1)
  expect(listed()[0]).toMatchObject({ infoHash: HASH, magnet: MAGNET, savePath: '/cache/' + HASH, ephemeral: false, started: true, paused: false })
  // a library row, and nothing in the engine yet
  expect(engine.added).toEqual([])
  expect(rig.of('list').at(-1)?.list).toEqual(listed())

  const resume = blobLimited(TRICKLE)
  rig.send({ type: 'import', infoHash: HASH, magnet: MAGNET, resume })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  expect(engine.added).toEqual([{ blob: resume, savePath: '/cache/' + HASH }])
  // kept for a reload, which adds it with the same blob rather than checking the files
  expect(engine.store.get('ripple:resume:' + HASH)).toBe(resume)
  expect(engine.limit.get(1), 'the blob brings its trickle').toBe(TRICKLE)
  expect(engine.paused.has(1), 'the blob brings its pause').toBe(true)
  await vi.waitFor(() => expect(engine.limit.get(1)).toBe(0))
  // the entry says started, so the blob's pause is undone, and its priorities with the window's
  await vi.waitFor(() => expect(engine.paused.has(1)).toBe(false))
  await vi.waitFor(() => expect(engine.cleared).toContain(1))

  // a second import of a torrent the engine already has adds nothing
  rig.send({ type: 'import', infoHash: HASH, magnet: MAGNET, resume })
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(engine.added).toHaveLength(1)
})
