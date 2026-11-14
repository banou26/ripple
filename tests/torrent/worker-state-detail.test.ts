// A detail panel shows what the last state message said of its torrent, and a message with no `detail` empties it.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const OPEN = 'a'.repeat(40)
const GHOST = 'b'.repeat(40)

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })

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

it('a Download on a row from another device keeps the open panel\'s detail', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${OPEN}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  rig.send({ type: 'inspect', handle: 1 })
  rig.send({ type: 'import-list', list: [{ infoHash: GHOST, magnet: `magnet:?xt=urn:btih:${GHOST}`, savePath: '/ghost', addedAt: 1 }] })
  await vi.waitFor(() => expect(rig.of('list').at(-1)?.list).toContainEqual(expect.objectContaining({ infoHash: GHOST, started: false })))
  const since = rig.posted.length

  rig.send({ type: 'start', infoHash: GHOST })
  await vi.waitFor(() => expect(rig.of('list').at(-1)?.list).toContainEqual(expect.objectContaining({ infoHash: GHOST, started: true })))
  const states = rig.posted.slice(since).filter((m) => m.type === 'state')
  expect(states.length).toBeGreaterThan(0)
  for (const state of states) expect(state).toMatchObject({ detail: { handle: 1 }, transport: 'relay', inboundNow: expect.any(Object), rateLimits: { down: 0, up: 0 } })
  expect(rig.of('worker-error')).toEqual([])
})
