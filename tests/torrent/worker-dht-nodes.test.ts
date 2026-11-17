import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/** The DHT's node count rides every state message for the strip, read from the engine once a second, not on each. */

const engine = vi.hoisted(() => ({ reads: 0 }))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({ dhtNodes: () => { engine.reads++; return 120 } }),
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

it('carries the DHT node count on each state, read from the engine once a second', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('state').at(-1)?.dhtNodes).toBe(120), { timeout: 3_000 })
  const [states, reads] = [rig.of('state').length, engine.reads]
  // six states, three seconds
  await vi.waitFor(() => expect(rig.of('state').length).toBeGreaterThanOrEqual(states + 6), { timeout: 6_000 })
  const read = engine.reads - reads
  expect(read, 'read on each state').toBeLessThanOrEqual(4)
  expect(read).toBeGreaterThanOrEqual(2)
  expect(rig.of('state').slice(states).map((state) => state.dhtNodes)).toEqual(Array(rig.of('state').length - states).fill(120))
}, 15_000)
