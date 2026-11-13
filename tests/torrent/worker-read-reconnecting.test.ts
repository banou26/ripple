// A read that waits while the engine reopens its sockets after a relay outage, and the bound on that wait.
import { beforeEach, expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const state = vi.hoisted(() => ({
  healing: false,
  // past READ_ATTEMPTS + READ_RECONNECTING_ATTEMPTS (38), so a read the worker never gives up on still ends
  failures: 0,
  read: vi.fn(),
}))
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })
const files = [{ path: 'episode.mkv', offset: 0, size: 10_000_000, pad: false }]

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      files: () => ({ storageIndex: 0, pieceLength: 1_048_576, numPieces: 10, totalSize: 10_000_000, contentSize: 10_000_000, files }),
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      read: state.read,
      cancelPieceRequests: () => {},
      reachable: () => ({ port: 40_000, listeners: [{ transport: 'udp', port: 40_000, up: !state.healing, healing: state.healing, attempts: 1 }] }),
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

const LIMIT = 60

// the engine answers each attempt with a timeout until `failures` have been given, then with the bytes
beforeEach(() => {
  state.read.mockReset()
  state.read.mockImplementation(async () => {
    if (state.read.mock.calls.length <= Math.min(state.failures, LIMIT)) throw new Error('pieces did not arrive')
    return new Uint8Array(50)
  })
})

const read = async (id: number) => {
  state.read.mockClear()
  rig.send({ type: 'read', id, viewer: 'player', handle: 1, fileIndex: 0, offset: 0, len: 50 })
  await vi.waitFor(() => expect([...rig.of('read-result'), ...rig.of('read-error')].filter((m) => m.id === id)).toHaveLength(1))
  return { result: rig.of('read-result').some((m) => m.id === id), attempts: state.read.mock.calls.length }
}

it('a read waits through the reconnect, and the attempts it waited are not counted', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))

  // without the reconnect, 18 attempts are all a read gets
  state.healing = false
  state.failures = 18
  expect(await read(1)).toEqual({ result: false, attempts: 18 })

  // 15 attempts end while the sockets are being reopened and 15 after, 30 in all, more than a read gets
  state.healing = true
  state.failures = 30
  state.read.mockImplementation(async () => {
    const n = state.read.mock.calls.length
    if (n > 15) state.healing = false
    if (n <= state.failures) throw new Error('pieces did not arrive')
    return new Uint8Array(50)
  })
  expect(await read(2)).toEqual({ result: true, attempts: 31 })
})

it('the wait through a reconnect ends: 20 attempts, then the 18 a read always gets', async () => {
  state.healing = true
  state.failures = LIMIT
  expect(await read(3)).toEqual({ result: false, attempts: 38 })
  expect(rig.of('worker-error')).toEqual([])
})
