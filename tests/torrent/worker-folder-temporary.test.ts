// A torrent in the person's folder, a .torrent added at the shared root and one made from the person's own files, each
// made temporary, are never given up for room, while the temporary one in its own directory in browser storage beside
// them is. Its storage here counts every torrent's bytes, which the real one does not for the folder's or the source's.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const ROOM = 10 * GiB
const IN_FOLDER = 'f'.repeat(40)
const AT_ROOT = 'd'.repeat(40)
const MADE = 'e'.repeat(40)
const CACHED = 'c'.repeat(40)
const NEVER = [IN_FOLDER, AT_ROOT, MADE]

const store = vi.hoisted(() => new Map<string, unknown>())
// each torrent given up frees 1 GiB
const space = vi.hoisted(() => ({ free: 5 * 1024 ** 3, given: [] as number[], measured: 0 }))

const rig = installWorkerGlobals({ estimate: async () => { space.measured++; return { usage: ROOM - space.free, quota: ROOM } } })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      removeTorrent: (h: number) => { space.given.push(h); space.free += 1024 ** 3 },
      clearStreamWindow: () => {},
      pauseTorrent: () => {},
      resumeTorrent: () => {},
      saveResumeData: async () => new Uint8Array([1]),
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => GiB, usageOfStorage: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  // the three are the older, so a pass that could take one would take it first
  store.set('ripple:torrents', [
    { infoHash: IN_FOLDER, magnet: 'magnet:?xt=urn:btih:' + IN_FOLDER, savePath: '/native/' + IN_FOLDER, saveTo: 'folder', addedAt: 1, lastUsedAt: 1, started: true },
    { infoHash: CACHED, magnet: 'magnet:?xt=urn:btih:' + CACHED, savePath: '/cache/' + CACHED, addedAt: 2, lastUsedAt: 2, started: true, ephemeral: true },
    { infoHash: AT_ROOT, magnet: 'magnet:?xt=urn:btih:' + AT_ROOT, savePath: '/dl', addedAt: 1, lastUsedAt: 1, started: true },
    { infoHash: MADE, magnet: 'magnet:?xt=urn:btih:' + MADE, savePath: '/source/' + MADE, saveTo: 'source', addedAt: 1, lastUsedAt: 1, started: true },
  ] satisfies Persisted[])
  // what start-source adds the made one from, as the restore never adds it
  store.set('ripple:torrent:' + MADE, new Uint8Array([1]))
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const entryOf = (hash: string) => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === hash)

/** Leaves 8 MiB free, under what a pass keeps, and runs a pass, as every add does. */
const fill = async (hash: string) => {
  space.free = 8 * MiB
  const from = space.measured
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + hash })
  await vi.waitFor(() => expect(space.measured, 'no pass ran').toBeGreaterThan(from))
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}

it('never gives up a temporary torrent in the folder, at the shared root or made from the person\'s files, and gives up one in its own directory', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'start-source', infoHash: MADE, handles: [{ kind: 'file' }] })
  await vi.waitFor(() => expect(entryOf(MADE)?.lastUsedAt).toBeGreaterThan(1))
  // used long ago, as it is once the page has been open a while
  store.set('ripple:torrents', (store.get('ripple:torrents') as Persisted[]).map((e) => (e.infoHash === MADE ? { ...e, lastUsedAt: 1 } : e)))
  for (const hash of NEVER) rig.send({ type: 'set-temporary', infoHash: hash, temporary: true })
  await vi.waitFor(() => expect(NEVER.map((hash) => entryOf(hash)?.ephemeral)).toEqual([true, true, true]))
  expect(space.given).toEqual([])

  // THE CONTROL: the pass gives up the temporary torrent in browser storage, after which the room is enough
  await fill('a'.repeat(40))
  expect(space.given).toEqual([2])
  expect(entryOf(CACHED)).toMatchObject({ started: false })
  const kept = () => NEVER.map((hash) => entryOf(hash)).map((e) => e && { started: e.started, ephemeral: e.ephemeral, savePath: e.savePath })
  const asWere = [
    { started: true, ephemeral: true, savePath: '/native/' + IN_FOLDER },
    { started: true, ephemeral: true, savePath: '/dl' },
    { started: true, ephemeral: true, savePath: '/source/' + MADE },
  ]
  expect(kept()).toEqual(asWere)

  // full again, with nothing else left to give up
  await fill('b'.repeat(40))
  expect(space.given).toEqual([2])
  expect(kept()).toEqual(asWere)
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 15_000)
