import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * Cache still inside its grace counts as room when a refused write is judged, without being given up.
 *
 * The frame stub plays ripple in, on Firefox 157 (2026-10-19): a partition held to 10 GiB, and the
 * 9.9 GiB film opened while the 1.4 GB episode before it was used seconds ago. The tail is refused
 * while the episode is there, the episode goes once its grace ends, and the film plays after the
 * restart. So the film is not too big, and saying it is would send the viewer away from a film that
 * is about to play.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const LIMIT = 10_737_418_240
const FILM = 10_624_058_159
const EARLIER = 1_400_000_000
const USED = EARLIER + 16 * MiB + 491_520
const EARLIER_HASH = 'e'.repeat(40)
const FILM_HASH = 'f'.repeat(40)

const state = vi.hoisted(() => ({ size: 0, usageOf: [] as unknown[][] }))
state.size = FILM

const earlier: Persisted = {
  infoHash: EARLIER_HASH,
  magnet: 'magnet:?xt=urn:btih:' + EARLIER_HASH,
  savePath: '/dl/' + EARLIER_HASH,
  addedAt: 1,
  // seconds ago, inside the grace that keeps a just-played episode from being given up
  lastUsedAt: Date.now(),
  started: true,
  ephemeral: true,
}

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: USED, quota: LIMIT }),
  root: fakeDir('', [fakeDir('dl', [fakeDir(EARLIER_HASH), fakeDir(FILM_HASH)])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      // the restored episode is handle 1, the film handle 2
      files: (h: number) => h === 2 ? {
        storageIndex: 0, pieceLength: 8 * MiB, numPieces: Math.ceil(state.size / (8 * MiB)), totalSize: state.size, contentSize: state.size,
        files: [{ path: 'film.mkv', offset: 0, size: state.size, pad: false }],
      } : null,
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({
    usageOf: async (...args: unknown[]) => {
      state.usageOf.push(args)
      return String(args[0]).endsWith(EARLIER_HASH) ? EARLIER : 16 * MiB
    },
    // the film's tail
    refusedFile: (savePath: string) => savePath.endsWith(FILM_HASH) ? 0 : undefined,
  }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>([['ripple:torrents', [earlier]]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('does not call a film too big while the cache it needs is only waiting out its grace', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 100))

  state.usageOf.length = 0
  rig.send({ type: 'watch', viewer: 'player', handle: 2, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(state.usageOf, 'no pass reached the cache').toContainEqual(['/dl/' + EARLIER_HASH]))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(rig.of('storage-full')).toEqual([])
  expect(sessions[0]?.removed, 'the episode went inside its grace').toEqual([])

  // THE CONTROL: the same refusal for a file no cache could make room for is reported
  state.size = 20 * GiB
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + 'c'.repeat(40) })
  await vi.waitFor(() => expect(rig.of('storage-full')).toEqual([
    { type: 'storage-full', full: true, usedBytes: USED, limitBytes: LIMIT },
  ]))
})
