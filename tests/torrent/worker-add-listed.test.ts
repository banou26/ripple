// A player claims a torrent from a state message, and its claim is what starts the torrent, so a new add is listed at
// once rather than on the next 500 ms pass.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession(),
    offlineHost: () => ({ net: {}, dgram: {} }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const listed = (handle: number) =>
  rig.of('state').some((state) => (state.torrents as { handle: number }[]).some((torrent) => torrent.handle === handle))

it('lists a new add in a state at once, not on the next pass', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  // just after a pass, so the next one is as far away as it gets
  const states = rig.of('state').length
  await vi.waitFor(() => expect(rig.of('state').length).toBeGreaterThan(states), { timeout: 1_000, interval: 5 })
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1), { interval: 1 })
  const addedAt = performance.now()
  await vi.waitFor(() => expect(listed(1)).toBe(true), { timeout: 1_000, interval: 1 })
  expect(performance.now() - addedAt).toBeLessThan(100)
  expect(rig.of('worker-error')).toEqual([])
})
