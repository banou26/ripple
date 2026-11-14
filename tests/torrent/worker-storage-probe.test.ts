import { describe, expect, it, vi } from 'vitest'

import { collectableHandles } from '../utils/memory-opfs'
import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: 0, quota: 10_000_000_000 }),
  root: collectableHandles(fakeDir('')),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return { createSession: async () => fakeSession(), PRIORITY: { skip: 0 }, TORRENT_FLAG: { uploadMode: 1 } }
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

describe('the storage probe the engine waits for', () => {
  it('answers on a file handle nothing else holds, so the engine starts', async () => {
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready'), 'the engine never started').toHaveLength(1), { timeout: 2_000 })
    expect(rig.of('storage-unavailable')).toEqual([])
  })
})
