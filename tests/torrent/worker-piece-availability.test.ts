import type { Posted } from '../utils/worker-rig'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A torrent's piece availability costs a read of every piece, so the engine reads it for the one torrent an open
 * details panel shows and for no other, never while no panel is open, and hands it to the page transferred. An
 * empty one, which libtorrent answers for a torrent with every piece or one checking its files, is left out.
 */

const HASHES = ['a'.repeat(40), 'b'.repeat(40)]

const engine = vi.hoisted(() => ({ read: [] as number[] }))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      pieceAvailability: (handle: number) => {
        engine.read.push(handle)
        return handle === 1 ? new Uint16Array(0) : new Uint16Array([0, 1, handle])
      },
    }),
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

type Detail = { handle: number, availability?: Uint16Array } | null

/** The state messages posted from now on, once `count` of them that `which` takes have been. */
const nextStates = async (count: number, which: (detail: Detail) => boolean) => {
  const since = rig.posted.length
  const taken = () => rig.posted.slice(since).filter((m) => m.type === 'state' && which(m.detail as Detail))
  await vi.waitFor(() => expect(taken().length).toBeGreaterThanOrEqual(count), { timeout: 4_000 })
  return taken()
}

it('reads the availability of the torrent a panel shows, only while it shows it, and transfers it to the page', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  for (const hash of HASHES) rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${hash}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2))

  await nextStates(3, (detail) => detail === null)
  expect(engine.read, 'read with no panel open').toEqual([])

  rig.send({ type: 'inspect', handle: 1 })
  for (const state of await nextStates(2, (detail) => detail?.handle === 1)) {
    expect(state.detail).not.toHaveProperty('availability')
    expect(rig.transferOf(state)).toEqual([])
  }

  rig.send({ type: 'inspect', handle: 2 })
  await nextStates(1, (detail) => detail?.handle === 2)
  engine.read.length = 0
  const shown: Posted[] = await nextStates(3, (detail) => detail?.handle === 2)
  for (const state of shown) {
    const { availability } = state.detail as { availability: Uint16Array }
    expect(availability).toEqual(new Uint16Array([0, 1, 2]))
    expect(rig.transferOf(state), 'copied rather than transferred').toEqual([availability.buffer])
  }
  expect(new Set(engine.read), 'read for a torrent no panel shows').toEqual(new Set([2]))

  rig.send({ type: 'inspect', handle: null })
  await nextStates(1, (detail) => detail === null)
  const reads = engine.read.length
  await nextStates(3, (detail) => detail === null)
  expect(engine.read.length, 'read after the panel closed').toBe(reads)
}, 20_000)
