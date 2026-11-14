// A torrent on a backend that refuses every write is in upload mode from its add, before any pump reports on it.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const MOVED = 'c'.repeat(40)
const MADE = 'd'.repeat(40)
const UPLOAD = 1

// the engine's rule this depends on: a call lands in the order it was made, from the add on
const engine = vi.hoisted(() => ({ next: 1, hashes: new Map<number, string>(), log: [] as string[] }))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const add = (hash: string) => {
    const h = engine.next++
    engine.hashes.set(h, hash)
    engine.log.push(`${hash} add`)
    return h
  }
  return {
    createSession: async () => fakeSession({
      addMagnet: (magnet: string) => add(/btih:(\w{40})/.exec(magnet)![1]!),
      addTorrentFile: () => add(MADE),
      popAlerts: () => { engine.log.push('pump'); return [] },
      setFlags: (h: number, flags: number, mask: number) => {
        if (mask & UPLOAD) engine.log.push(`${engine.hashes.get(h)} upload ${flags & UPLOAD ? 'on' : 'off'}`)
      },
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: UPLOAD },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

/** What the engine was told of this torrent from its last add up to the next pump. */
const withLastAdd = (hash: string) => {
  const from = engine.log.lastIndexOf(`${hash} add`)
  const pump = engine.log.indexOf('pump', from)
  return engine.log.slice(from, pump < 0 ? undefined : pump).filter((line) => line.startsWith(hash)).map((line) => line.slice(41))
}

it('sets upload mode with the add of a torrent moved to a folder and of one made from the user\'s own files', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${MOVED}`, ephemeral: false })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  rig.send({ type: 'relocate', infoHash: MOVED, to: 'folder' })
  rig.send({
    type: 'create-source',
    infoHash: MADE,
    magnet: `magnet:?xt=urn:btih:${MADE}`,
    bytes: new Uint8Array([1, 2, 3]),
    handles: [{ kind: 'file', name: 'a.mkv' }],
    name: 'Pack',
    size: 1_000,
    files: [{ name: 'Pack/a.mkv', size: 1_000 }],
  })
  await vi.waitFor(() => expect(engine.log.filter((line) => line === `${MOVED} add`)).toHaveLength(2))
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2))

  expect(withLastAdd(MOVED)).toEqual(['add', 'upload on'])
  expect(withLastAdd(MADE)).toEqual(['add', 'upload on'])
  expect(rig.of('worker-error')).toEqual([])
})
