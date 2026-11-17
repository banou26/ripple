// A magnet add whose saved state has the metadata and no .torrent kept from it yet (one saved before they were kept),
// moved before its next save, is added again from a .torrent built off that state.
import type { Persisted } from '../../src/torrent/library'

import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

const fixture = vi.hoisted(() => ({
  INFO: `d6:lengthi11e4:name5:x.bin12:piece lengthi16384e6:pieces20:${'p'.repeat(20)}e`,
  store: new Map<string, unknown>(),
  engine: { files: [] as string[], magnets: [] as string[] },
}))
const HASH = createHash('sha1').update(fixture.INFO).digest('hex')

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }),
  root: fakeDir('', [fakeDir('dl', [fakeDir(HASH)])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { DOWNLOADING, fakeSession } = await import('../utils/worker-rig')
  let next = 1
  return {
    createSession: async () => fakeSession({
      addTorrentWithResume: () => next++,
      addTorrentFile: (bytes: Uint8Array) => { fixture.engine.files.push(new TextDecoder().decode(bytes)); return next++ },
      addMagnet: (magnet: string) => { fixture.engine.magnets.push(magnet); return next++ },
      // downloading, which the engine saves only every 15 s, so nothing saved since the restore
      status: () => DOWNLOADING,
      saveResumeData: async () => new Uint8Array(),
      pauseTorrent: () => {},
      resumeTorrent: () => {},
    }),
    PRIORITY: { skip: 0, normal: 4, top: 7 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, usageOfStorage: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => fixture.store.get(key),
  set: async (key: string, value: unknown) => { fixture.store.set(key, value) },
  del: async (key: string) => { fixture.store.delete(key) },
  update: async (key: string, fn: (prev: unknown) => unknown) => { fixture.store.set(key, fn(fixture.store.get(key))) },
}))

it('adds a moved magnet add from its saved state\'s metadata, not from the bare magnet', async () => {
  const entry: Persisted = { infoHash: HASH, magnet: `magnet:?xt=urn:btih:${HASH}&dn=x.bin`, savePath: '/dl/' + HASH, addedAt: 1, started: true, paused: false }
  fixture.store.set('ripple:torrents', [entry])
  fixture.store.set('ripple:resume:' + HASH, new TextEncoder().encode(`d4:info${fixture.INFO}e`))

  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  expect(fixture.store.has('ripple:torrent:' + HASH), 'the control: no .torrent kept before the move').toBe(false)

  rig.send({ type: 'relocate', infoHash: HASH, to: 'folder' })
  await vi.waitFor(() => expect(fixture.engine.files.length + fixture.engine.magnets.length).toBe(1))
  expect(fixture.engine.magnets, 'the move added the bare magnet, which waits for a peer to send the file list').toEqual([])
  expect(fixture.engine.files).toEqual([`d4:info${fixture.INFO}e`])
  expect(fixture.store.has('ripple:resume:' + HASH), 'the state from before the move was kept').toBe(false)
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
})
