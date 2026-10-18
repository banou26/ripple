import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * A pass runs as soon as a viewer attaches with the layout known, and gives up cold cache for what
 * the watched file owes on disk.
 *
 * The numbers are the frame stub plays ripple in, on Firefox 157 (2026-10-19): a partition held to
 * 10 GiB, an earlier episode of 1.4 GB still cached, and a film of 10,624,058,159 bytes with its
 * 16 MiB head written. Its tail goes in seconds after it opens, since the engine fetches it with the
 * head, and Firefox refuses it while the episode is there. The ten second timer is too late for
 * that, so the eviction has to come from the attach, including when a pass that read what the films
 * owe before the layout arrived is still running at that moment.
 */

const MiB = 1024 * 1024
const LIMIT = 10_737_418_240
const FILM = 10_624_058_159
const EARLIER = 1_400_000_000
const EARLIER_HASH = 'e'.repeat(40)
const FILM_HASH = 'f'.repeat(40)

const state = vi.hoisted(() => {
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  return { metadata: false, windowed: false, usageOf: [] as unknown[][], held, release: () => release() }
})

const earlier: Persisted = {
  infoHash: EARLIER_HASH,
  magnet: 'magnet:?xt=urn:btih:' + EARLIER_HASH,
  savePath: '/dl/' + EARLIER_HASH,
  addedAt: 1,
  lastUsedAt: 1,
  started: true,
  ephemeral: true,
}

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: EARLIER + 16 * MiB + 491_520, quota: LIMIT }),
  root: fakeDir('', [fakeDir('dl', [fakeDir(EARLIER_HASH), fakeDir(FILM_HASH)])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      // the restored episode is handle 1, the film handle 2
      files: (h: number) => state.metadata && h === 2 ? {
        storageIndex: 0, pieceLength: 8 * MiB, numPieces: 1267, totalSize: FILM, contentSize: FILM,
        files: [{ path: 'Penguin Highway.mkv', offset: 0, size: FILM, pad: false }],
      } : null,
      setStreamWindow: () => { state.windowed = true; return true },
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
      if (!String(args[0]).endsWith(EARLIER_HASH)) return 16 * MiB
      // the first pass to measure the episode is held there, with what the films owe already read
      await state.held
      return EARLIER
    },
    refusedFile: () => undefined,
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

it('gives up the cached episode the moment the film it owes room to has a layout', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  rig.send({ type: 'watch', viewer: 'player', handle: 2, fileIndex: 0, fromOffset: 0 })

  await vi.waitFor(() => expect(state.usageOf, 'no pass reached the cache').toContainEqual(['/dl/' + EARLIER_HASH]))
  // THE CONTROL: the passes so far knew no layout, so they had nothing to make room for
  expect(sessions[0]?.removed, 'the episode went before anything owed room').toEqual([])

  state.metadata = true
  await vi.waitFor(() => expect(state.windowed, 'the film never attached').toBe(true))
  state.release()
  // well inside the ten second timer, so the pass that did it is the one the attach asked for
  await vi.waitFor(() => expect(sessions[0]?.removed).toEqual([1]), { timeout: 2_000 })
  // and it asked what the film holds on disk, rather than counting its missing pieces
  expect(state.usageOf).toContainEqual(['/dl/' + FILM_HASH, 0])
  expect(rig.of('worker-error')).toEqual([])
})
