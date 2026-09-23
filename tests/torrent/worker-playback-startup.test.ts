// Playback needs the container tail before the demuxer discovers it; bulk downloads do not.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const state = vi.hoisted(() => ({
  metadata: false,
  setStreamWindow: vi.fn(() => true),
  clearStreamWindow: vi.fn(),
  read: vi.fn(),
}))
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })
const files = [
  { path: 'intro.txt', offset: 0, size: 100, pad: false },
  { path: 'episode.mkv', offset: 100, size: 10_000_000, pad: false },
  { path: 'next.mkv', offset: 10_000_100, size: 20_000_000, pad: false },
]

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      files: () => state.metadata ? {
        storageIndex: 0, pieceLength: 1_048_576, numPieces: 29,
        totalSize: 30_000_100, contentSize: 30_000_100, files,
      } : null,
      setStreamWindow: state.setStreamWindow,
      clearStreamWindow: state.clearStreamWindow,
      read: state.read,
      cancelPieceRequests: () => {},
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

it('plans the selected file head and tail on metadata arrival, preserving bulk and held claims', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))

  rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 1, fromOffset: 0 })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(state.setStreamWindow).not.toHaveBeenCalled()
  state.metadata = true
  await vi.waitFor(() => expect(state.setStreamWindow).toHaveBeenCalledWith(1, [
    { fileIndex: 1, offset: 0 },
    { fileIndex: 1, offset: 9_999_999 },
  ], expect.objectContaining({ unclaimedPriority: 0, deadlines: true })))

  state.read.mockRejectedValueOnce(new Error('pieces did not arrive')).mockResolvedValueOnce(new Uint8Array(50))
  const plansBeforeRead = state.setStreamWindow.mock.calls.length
  rig.send({ type: 'read', id: 1, viewer: 'player', handle: 1, fileIndex: 1, offset: 9_999_950, len: 50 })
  await vi.waitFor(() => expect(rig.of('read-result')).toHaveLength(1))
  expect(rig.of('read-stalled')).toHaveLength(1)
  expect(state.setStreamWindow.mock.calls.length).toBeGreaterThan(plansBeforeRead)
  expect(state.setStreamWindow).toHaveBeenLastCalledWith(1, [
    { fileIndex: 1, offset: 0 },
    { fileIndex: 1, offset: 9_999_999 },
  ], expect.anything())

  rig.send({ type: 'watch', viewer: 'save', handle: 1, fileIndex: 2, fromOffset: 0, bulk: true })
  await vi.waitFor(() => expect(state.setStreamWindow).toHaveBeenLastCalledWith(1, [
    { fileIndex: 1, offset: 0 },
    { fileIndex: 1, offset: 9_999_999 },
    { fileIndex: 2, offset: 0 },
  ], expect.objectContaining({ deadlines: true })))

  rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 1, fromOffset: 4_000_000 })
  await vi.waitFor(() => expect(state.setStreamWindow).toHaveBeenLastCalledWith(1, [
    { fileIndex: 1, offset: 4_000_000 },
    { fileIndex: 1, offset: 9_999_999 },
    { fileIndex: 2, offset: 0 },
  ], expect.anything()))

  rig.send({ type: 'unwatch', viewer: 'player' })
  await vi.waitFor(() => expect(state.setStreamWindow).toHaveBeenLastCalledWith(1, [
    { fileIndex: 2, offset: 0 },
  ], expect.objectContaining({ deadlines: false })))

  rig.send({ type: 'watch', viewer: 'save', handle: 1, fileIndex: 2, fromOffset: 0, held: true })
  await vi.waitFor(() => expect(state.clearStreamWindow).toHaveBeenCalled())
  expect(rig.of('worker-error')).toEqual([])
})
