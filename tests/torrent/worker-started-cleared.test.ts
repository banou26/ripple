// A temporary torrent the person started whose files the browser cleared keeps no Start once it is downloaded again
// from its row, like one Ripple deleted for room (worker-started-evicted.test.ts).
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const HASH = 'c'.repeat(40)
const store = vi.hoisted(() => new Map<string, unknown>())

// no directory in OPFS, which the restore reads as storage the browser cleared
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return { createSession: async () => fakeSession(), PRIORITY: { skip: 0 }, TORRENT_FLAG: { uploadMode: 1 } }
})
vi.mock('idb-keyval', () => {
  const hash = 'c'.repeat(40)
  const entry: Persisted = {
    infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, savePath: `/cache/${hash}`,
    addedAt: 1, lastUsedAt: 1, started: true, paused: false, resumed: true, ephemeral: true,
  }
  store.set('ripple:torrents', [entry])
  store.set(`ripple:resume:${hash}`, new Uint8Array([1]))
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const entryOf = () => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === HASH)

it('keeps no Start on a temporary torrent whose files were cleared once it is downloaded again', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  // the CONTROL: the restore found its files gone
  await vi.waitFor(() => expect(entryOf()).toMatchObject({ started: false }))
  expect(store.has(`ripple:resume:${HASH}`)).toBe(false)

  rig.send({ type: 'start', infoHash: HASH })
  await vi.waitFor(() => expect(entryOf()).toMatchObject({ started: true, ephemeral: false }))
  expect(entryOf()).toMatchObject({ resumed: false })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
})
