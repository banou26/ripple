// A temporary torrent stays temporary in the engine, as in its list entry, when the engine tracks it again: a .torrent
// add once its hash is known, and a torrent made from the person's own files started again after a reload. Read off
// the park a temporary torrent gets when nobody watches it, which a kept one never gets.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024
const TEMPORARY = 'a'.repeat(40)
const KEPT = 'b'.repeat(40)
const SOURCE = 'c'.repeat(40)
// a .torrent's first byte names its hash here
const HASHES = [TEMPORARY, KEPT, SOURCE]

const engine = vi.hoisted(() => ({ hashes: [] as string[], log: [] as string[] }))
const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { DOWNLOADING, fakeSession } = await import('../utils/worker-rig')
  const layout = { storageIndex: 0, pieceLength: MiB, numPieces: 4, totalSize: 4 * MiB, contentSize: 4 * MiB, files: [
    { path: 'film.mkv', offset: 0, size: 4 * MiB, pad: false },
  ] }
  return {
    createSession: async () => fakeSession({
      addTorrentFile: (bytes: Uint8Array) => engine.hashes.push(HASHES[bytes[0]!]!),
      infohash: (h: number) => engine.hashes[h - 1] ?? null,
      infohashV2: () => null,
      status: () => DOWNLOADING,
      files: () => layout,
      clearStreamWindow: () => {},
      saveResumeData: async () => new Uint8Array([1]),
      pauseTorrent: (h: number) => { engine.log.push(`pause ${engine.hashes[h - 1]}`) },
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  // made temporary by the person before the reload
  store.set('ripple:torrents', [{
    infoHash: SOURCE, magnet: 'magnet:?xt=urn:btih:' + SOURCE, savePath: '/source/' + SOURCE, saveTo: 'source', addedAt: 1, started: true,
    ephemeral: true,
  }] satisfies Persisted[])
  store.set('ripple:torrent:' + SOURCE, new Uint8Array([2]))
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const entryOf = (hash: string) => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === hash)

/** A page holding the torrent and letting it go. */
const leave = (handle: number) => {
  rig.send({ type: 'watch', viewer: `page-${handle}`, handle, fileIndex: 0, fromOffset: 0, held: true })
  rig.send({ type: 'unwatch', viewer: `page-${handle}` })
}

it('keeps a temporary torrent temporary in the engine when it tracks it again', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([0]), ephemeral: true })
  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([1]) })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2))
  expect(entryOf(TEMPORARY)).toMatchObject({ ephemeral: true })
  expect(entryOf(KEPT)).toMatchObject({ ephemeral: false })
  leave(1)
  leave(2)
  await vi.waitFor(() => expect(engine.log, 'the temporary .torrent add was not parked').toContain(`pause ${TEMPORARY}`), { timeout: 2_000 })

  rig.send({ type: 'start-source', infoHash: SOURCE, handles: [{ name: 'film.mkv' }] })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(3))
  leave(3)
  await vi.waitFor(() => expect(engine.log, 'the temporary source was not parked').toContain(`pause ${SOURCE}`), { timeout: 2_000 })
  // THE CONTROL: the kept one is never parked
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  expect(engine.log).not.toContain(`pause ${KEPT}`)
  expect(entryOf(SOURCE)).toMatchObject({ ephemeral: true })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 15_000)
