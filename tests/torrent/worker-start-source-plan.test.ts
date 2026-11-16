// A torrent made from the person's own files keeps the files they left out through a reload, as a download does.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024
const SOURCE = 'd'.repeat(40)
const PLAIN = 'a'.repeat(40)

// the handle each save path was added under, and each map the engine was given, by handle
const engine = vi.hoisted(() => ({ ids: new Map<string, number>(), plans: [] as string[] }))
const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { DOWNLOADING, fakeSession } = await import('../utils/worker-rig')
  const add = (key: string) => {
    const h = engine.ids.size + 1
    engine.ids.set(key, h)
    return h
  }
  // two files of 10 pieces each
  const layout = { storageIndex: 0, pieceLength: MiB, numPieces: 20, totalSize: 20 * MiB, contentSize: 20 * MiB, files: [
    { path: 'Pack/E01.mkv', offset: 0, size: 10 * MiB, pad: false },
    { path: 'Pack/E02.mkv', offset: 10 * MiB, size: 10 * MiB, pad: false },
  ] }
  return {
    createSession: async () => fakeSession({
      addMagnet: (magnet: string) => add(magnet),
      addTorrentFile: (_: Uint8Array, savePath: string) => add(savePath),
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
vi.mock('idb-keyval', () => {
  const entry = (infoHash: string, over: Partial<Persisted>): Persisted => ({
    infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/dl/' + infoHash, addedAt: 1, started: true, paused: false, ...over,
  })
  store.set('ripple:torrents', [
    entry(PLAIN, { wantedFiles: [1] }),
    entry(SOURCE, { wantedFiles: [0], saveTo: 'source', savePath: '/source/' + SOURCE }),
  ])
  store.set('ripple:torrent:' + SOURCE, new Uint8Array([1]))
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('writes a created torrent\'s stored file selection to the engine when the page starts it again', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  // THE CONTROL: a download restored with a file left out has it skipped
  const plain = engine.ids.get('magnet:?xt=urn:btih:' + PLAIN)!
  await vi.waitFor(() => expect(engine.plans).toContain(`${plain}: 0 4`))

  rig.send({ type: 'start-source', infoHash: SOURCE, handles: [{ name: 'E01.mkv' }, { name: 'E02.mkv' }] })
  await vi.waitFor(() => expect(engine.ids.get('/source/' + SOURCE)).toBeDefined())
  const source = engine.ids.get('/source/' + SOURCE)!
  await vi.waitFor(() => expect(engine.plans, 'the reload forgot the file left out').toContain(`${source}: 4 0`), { timeout: 3_000 })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
})
