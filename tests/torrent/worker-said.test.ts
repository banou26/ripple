import { describe, expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

// The worker loads no catalogue, so what it says to the viewer leaves it as one of ripple's messages, which the page
// words in its own language (wordsOf, src/i18n). A string here would be English on every page.

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  // the engine's -2, an unparseable magnet, widened as it comes back
  return { createSession: async () => fakeSession({ addMagnet: () => 0xFFFFFFFE }), PRIORITY: { skip: 0 }, TORRENT_FLAG: { uploadMode: 1 } }
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

describe('what the worker tells the viewer', () => {
  it('is one of ripple\'s messages, for the page to word: a refused add, and a read of a torrent it no longer has', async () => {
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready'), 'the engine never started').toHaveLength(1))

    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:nonsense', savePath: '/dl/x', ephemeral: false })
    await vi.waitFor(() => expect(rig.of('add-failed')).toHaveLength(1))
    expect(rig.of('add-failed')[0]).toEqual({ type: 'add-failed', message: { message: 'That is not a valid magnet link' } })

    rig.send({ type: 'read', id: 1, handle: 99, fileIndex: 0, offset: 0, len: 16 })
    await vi.waitFor(() => expect(rig.of('read-error')).toHaveLength(1))
    expect(rig.of('read-error')[0]).toEqual({ type: 'read-error', id: 1, error: { message: 'torrent removed' } })
  })
})
