// The next episode's file, prepared: only its head and tail, and only once the file playing is held to its end.
import { expect, it, vi } from 'vitest'

import { READ_SIZE } from '../../src/torrent/stream-plan'
import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024
const PLAYING = 'a'.repeat(40)
const NEXT = 'b'.repeat(40)
const PACK = 'c'.repeat(40)

const state = vi.hoisted(() => ({
  hashes: new Map<number, string>(),
  held: new Map<number, Set<number>>(),
  setStreamWindow: vi.fn((_h: number, _claims: unknown, _opts: unknown) => true),
  clearStreamWindow: vi.fn(),
}))
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })

const layout = (sizes: number[]) => {
  const files = sizes.map((size, i) => ({ path: `e${i + 1}.mkv`, offset: sizes.slice(0, i).reduce((a, b) => a + b, 0), size, pad: false }))
  const total = sizes.reduce((a, b) => a + b, 0)
  return { storageIndex: 0, pieceLength: MiB, numPieces: total / MiB, totalSize: total, contentSize: total, files }
}

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      addMagnet: (magnet: string) => { const h = state.hashes.size + 1; state.hashes.set(h, /btih:(\w{40})/.exec(magnet)![1]!); return h },
      files: (h: number) => {
        const hash = state.hashes.get(h)
        return hash === PLAYING ? layout([10 * MiB]) : hash === NEXT ? layout([20 * MiB]) : hash === PACK ? layout([10 * MiB, 20 * MiB]) : null
      },
      bitfield: (h: number) => {
        const pieces = new Uint8Array(8)
        for (const p of state.held.get(h) ?? []) pieces[p >> 3]! |= 0x80 >> (p & 7)
        return { pieces }
      },
      setStreamWindow: state.setStreamWindow,
      clearStreamWindow: state.clearStreamWindow,
      pauseTorrent: () => {},
      resumeTorrent: () => {},
      setSequential: () => {},
      prioritizePieces: () => {},
      saveResumeData: async () => new Uint8Array(),
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

const range = (from: number, to: number) => new Set(Array.from({ length: to - from }, (_, i) => from + i))
const plansOf = (h: number) => state.setStreamWindow.mock.calls.filter(([handle]) => handle === h)
const add = async (hash: string, hold = false) => {
  const before = rig.of('added').length
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${hash}`, ephemeral: true, hold })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(before + 1))
  return rig.of('added').at(-1)!.handle as number
}

it('claims nothing of the next torrent until the file playing is held from its reader to its end, then only its two bands', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  const playing = await add(PLAYING)
  const next = await add(NEXT, true)
  state.held.set(playing, range(0, 6))

  rig.send({ type: 'watch', viewer: 'player', handle: playing, fileIndex: 0, fromOffset: 0 })
  rig.send({ type: 'watch', viewer: 'next', handle: next, fileIndex: 0, fromOffset: 0, prepare: true })
  await vi.waitFor(() => expect(plansOf(playing).length).toBeGreaterThan(0))
  await new Promise(resolve => setTimeout(resolve, 1_200))
  expect(plansOf(next)).toEqual([])
  // the player's own plan is untouched by the claim waiting beside it
  expect(plansOf(playing).at(-1)![1]).toEqual([{ fileIndex: 0, offset: 0 }, { fileIndex: 0, offset: 10 * MiB - 1 }])

  state.held.set(playing, range(0, 10))
  await vi.waitFor(() => expect(plansOf(next)).toHaveLength(1), { timeout: 2_000 })
  expect(plansOf(next)[0]).toEqual([next, [{ fileIndex: 0, offset: 0 }, { fileIndex: 0, offset: 20 * MiB - READ_SIZE }], expect.objectContaining({ unclaimedPriority: 0, keep: [], deadlines: false })])

  // a seek into what the player does not hold yet takes the bandwidth back
  const cleared = state.clearStreamWindow.mock.calls.filter(([h]) => h === next).length
  state.held.set(playing, range(0, 6))
  rig.send({ type: 'watch', viewer: 'player', handle: playing, fileIndex: 0, fromOffset: 5 * MiB })
  await vi.waitFor(() => expect(state.clearStreamWindow.mock.calls.filter(([h]) => h === next).length).toBeGreaterThan(cleared), { timeout: 2_000 })
  expect(plansOf(next)).toHaveLength(1)

  // left open as the last pass found it, with nobody playing
  state.held.set(playing, range(0, 10))
  await vi.waitFor(() => expect(plansOf(next)).toHaveLength(2), { timeout: 2_000 })
  rig.send({ type: 'unwatch', viewer: 'player' })
  rig.send({ type: 'unwatch', viewer: 'next' })
  expect(rig.of('worker-error')).toEqual([])
})

it('prepares the next file of the torrent playing beside the player, keeping the rest of that file skipped', async () => {
  const pack = await add(PACK)
  // read from where the player is: the start of its file is not what it still has to play
  state.held.set(pack, range(2, 5))
  rig.send({ type: 'watch', viewer: 'player', handle: pack, fileIndex: 0, fromOffset: 2 * MiB })
  rig.send({ type: 'watch', viewer: 'next', handle: pack, fileIndex: 1, fromOffset: 0, prepare: true })
  await new Promise(resolve => setTimeout(resolve, 1_200))
  // never once, not even before the next pass reads the gate again
  expect(plansOf(pack).filter(([, claims]) => (claims as { fileIndex: number }[]).some(claim => claim.fileIndex === 1))).toEqual([])
  state.held.set(pack, range(2, 10))
  await vi.waitFor(() => expect(plansOf(pack).at(-1)).toEqual([pack, [
    { fileIndex: 0, offset: 2 * MiB },
    { fileIndex: 0, offset: 10 * MiB - 1 },
    { fileIndex: 1, offset: 0 },
    { fileIndex: 1, offset: 20 * MiB - READ_SIZE },
  ], expect.objectContaining({ keep: [{ start: 0, end: 10 }], deadlines: true })]), { timeout: 2_000 })
  expect(rig.of('worker-error')).toEqual([])
})
