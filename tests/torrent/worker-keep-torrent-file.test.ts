// A magnet add keeps a .torrent once its metadata is known, built from its saved state, and a .torrent add's own file stays.
import type { Persisted } from '../../src/torrent/library'

import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

const fixture = vi.hoisted(() => {
  const encoder = new TextEncoder()
  const str = (value: string) => `${encoder.encode(value).length}:${value}`
  const info = (name: string) => `d6:lengthi11e4:name${str(name)}12:piece lengthi16384e6:pieces20:${'p'.repeat(20)}e`
  const TRACKER = 'udp://tracker.example:1337/announce'
  return {
    str,
    TRACKER,
    MAGNET_INFO: info('From a magnet'),
    FILE_INFO: info('From a file'),
    ORIGINAL: encoder.encode(`d8:announce${str('https://tracker.own.example/announce')}4:info${info('From a file')}e`),
    blob: (infoDict: string) => encoder.encode(`d4:info${infoDict}e`),
    store: new Map<string, unknown>(),
    /** Keys a plain read misses although the store holds them, as a value written right after the read. */
    unseen: new Set<string>(),
  }
})

const hashOf = (infoDict: string) => createHash('sha1').update(infoDict).digest('hex')
const MAGNET_ADD = hashOf(fixture.MAGNET_INFO)
const FILE_ADD = hashOf(fixture.FILE_INFO)

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }),
  root: fakeDir('', [fakeDir('dl', [fakeDir(MAGNET_ADD), fakeDir(FILE_ADD)])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { DOWNLOADING, fakeSession } = await import('../utils/worker-rig')
  const added: number[] = []
  return {
    createSession: async () => fakeSession({
      addTorrentWithResume: () => { added.push(added.length + 1); return added.length },
      status: () => ({ ...DOWNLOADING, state: 5 }),
      // the state the engine saves, which carries each torrent's info dict as the swarm sent it
      saveResumeData: async (h: number) => fixture.blob(h === 1 ? fixture.MAGNET_INFO : fixture.FILE_INFO),
      pauseTorrent: () => {},
      resumeTorrent: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, usageOfStorage: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => (fixture.unseen.has(key) ? undefined : fixture.store.get(key)),
  set: async (key: string, value: unknown) => { fixture.store.set(key, value) },
  del: async (key: string) => { fixture.store.delete(key) },
  update: async (key: string, fn: (prev: unknown) => unknown) => { fixture.store.set(key, fn(fixture.store.get(key))) },
}))

const entry = (infoHash: string, magnet: string): Persisted =>
  ({ infoHash, magnet, savePath: '/dl/' + infoHash, addedAt: 1, started: true, paused: false })

it('keeps a .torrent for a magnet add from its saved state, and leaves a .torrent add\'s own file as it was', async () => {
  const { str, TRACKER } = fixture
  fixture.store.set('ripple:torrents', [
    entry(MAGNET_ADD, `magnet:?xt=urn:btih:${MAGNET_ADD}&dn=x&tr=${encodeURIComponent(TRACKER)}`),
    entry(FILE_ADD, `magnet:?xt=urn:btih:${FILE_ADD}`),
  ])
  // an older state, from before the metadata, so the restore is not where the file comes from
  fixture.store.set('ripple:resume:' + MAGNET_ADD, new TextEncoder().encode('d4:spami1ee'))
  fixture.store.set('ripple:resume:' + FILE_ADD, new TextEncoder().encode('d4:spami1ee'))
  fixture.store.set('ripple:torrent:' + FILE_ADD, fixture.ORIGINAL)
  // so its file is first seen inside the write, as a .torrent add landing between the save's look and its write
  fixture.unseen.add('ripple:torrent:' + FILE_ADD)
  expect(fixture.store.has('ripple:torrent:' + MAGNET_ADD), 'the control: a magnet add keeps no file before').toBe(false)

  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  await vi.waitFor(() => expect(fixture.store.get('ripple:torrent:' + MAGNET_ADD), 'the magnet add kept no .torrent once its state carried the metadata').toBeDefined(), { timeout: 5_000 })

  const kept = new TextDecoder().decode(fixture.store.get('ripple:torrent:' + MAGNET_ADD) as Uint8Array)
  // the info dict byte for byte, so the file names the same torrent, and the magnet's tracker around it
  expect(kept).toBe(`d8:announce${str(TRACKER)}13:announce-listll${str(TRACKER)}ee4:info${fixture.MAGNET_INFO}e`)
  // THE CONTROL: the .torrent add saved its state too, so its file had the same chance to be written over
  const saved = (hash: string) => new TextDecoder().decode(fixture.store.get('ripple:resume:' + hash) as Uint8Array)
  await vi.waitFor(() => expect(saved(FILE_ADD)).toContain('4:info'))
  expect(fixture.store.get('ripple:torrent:' + FILE_ADD), 'a .torrent add\'s own file was written over').toBe(fixture.ORIGINAL)
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
})
