// How a first watch's window is planned: on the pump that brings the layout, not the next 500 ms pass, with a band of
// exactly the first read's pieces and the file's tail. The band's last piece joins on the drain that brings those
// pieces in; a seek is planned whole at once.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A film of 60 MB in 512 KiB pieces (115 of them, the last 114), as on the swarm rig. As in libtorrent-wasm, a layout
 * and a piece reach the worker only through the next `popAlerts`, `arriving` is what that drain brings, and a read is
 * answered by the drain that brings its last piece.
 */
const engine = vi.hoisted(() => ({
  arriving: { listed: new Set<number>(), held: [] as [number, number][] },
  listed: new Set<number>(),
  held: new Map<number, Set<number>>(),
  reads: [] as { handle: number, pieces: number[], answer: () => void }[],
  setStreamWindow: vi.fn((_handle: number, _claims: unknown[], _opts: unknown) => true),
}))
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })
const SIZE = 60_000_000
const LAYOUT = {
  storageIndex: 0, pieceLength: 524_288, numPieces: 115, totalSize: SIZE, contentSize: SIZE,
  files: [{ path: 'film.mp4', offset: 0, size: SIZE, pad: false }],
}

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const bits = (h: number) => {
    const pieces = new Uint8Array(15)
    for (const p of engine.held.get(h) ?? []) pieces[p >> 3] = (pieces[p >> 3] ?? 0) | (0x80 >> (p & 7))
    return pieces
  }
  return {
    createSession: async () => fakeSession({
      popAlerts: () => {
        for (const h of engine.arriving.listed) engine.listed.add(h)
        for (const [h, p] of engine.arriving.held) engine.held.set(h, new Set([...engine.held.get(h) ?? [], p]))
        engine.arriving = { listed: new Set(), held: [] }
        for (const read of engine.reads.filter((r) => r.pieces.every((p) => engine.held.get(r.handle)?.has(p)))) {
          engine.reads.splice(engine.reads.indexOf(read), 1)
          read.answer()
        }
        return []
      },
      files: (h: number) => engine.listed.has(h) ? LAYOUT : null,
      bitfield: (h: number) => engine.listed.has(h) ? { numPieces: 115, pieceLength: 524_288, length: 115, pieces: bits(h) } : null,
      setStreamWindow: engine.setStreamWindow,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
      read: (handle: number, _fileIndex: number, offset: number, len: number) => new Promise((resolve) => {
        const pieces = Array.from({ length: Math.floor((offset + len - 1) / 524_288) - Math.floor(offset / 524_288) + 1 }, (_, i) => Math.floor(offset / 524_288) + i)
        engine.reads.push({ handle, pieces, answer: () => resolve(new Uint8Array(len)) })
      }),
    }),
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

/** Resolves just after the 500 ms pass posts its state, so that pass is as far away as it gets. */
const afterPass = async () => {
  const states = rig.of('state').length
  await vi.waitFor(() => expect(rig.of('state').length).toBeGreaterThan(states), { timeout: 1_000, interval: 5 })
}
const plansOf = (handle: number) => engine.setStreamWindow.mock.calls.filter(([h]) => h === handle)
/** A first watch of a new add, its file list not in yet. */
const firstWatch = async (handle: number) => {
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${String(handle).repeat(40)}`, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added').some((m) => m.handle === handle)).toBe(true))
  rig.send({ type: 'watch', viewer: `player-${handle}`, handle, fileIndex: 0, fromOffset: 0 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(plansOf(handle)).toEqual([])
}

it('plans a first watch on the pump that brings its file list', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  await firstWatch(1)
  await afterPass()
  const listedAt = performance.now()
  engine.arriving.listed.add(1)
  await vi.waitFor(() => expect(plansOf(1)).toHaveLength(1), { timeout: 1_000, interval: 1 })
  expect(performance.now() - listedAt).toBeLessThan(100)
  expect(rig.of('worker-error')).toEqual([])
}, 10_000)

const HEAD = { fileIndex: 0, offset: 0 }
const TAIL = { fileIndex: 0, offset: SIZE - 1 }
/** The player's first read, 2,500,000 bytes from the start: pieces 0 to 4. */
const FIRST_READ = [0, 1, 2, 3, 4]

const firstPlan = (handle: number) => [handle, [HEAD, TAIL], expect.objectContaining({ windowPieces: FIRST_READ.length, deadlines: true })]
const wholePlan = (handle: number) => [handle, [HEAD, TAIL], expect.objectContaining({ windowPieces: 6, deadlines: true })]

it('asks for the first read\'s pieces and the tail, not the band\'s last piece', () => {
  expect(plansOf(1)).toEqual([firstPlan(1)])
})

it('adds the band\'s last piece on the pump that brings the last of the first read\'s pieces', async () => {
  rig.send({ type: 'read', id: 1, viewer: 'player-1', handle: 1, fileIndex: 0, offset: 0, len: 2_500_000 })
  for (const p of FIRST_READ.slice(0, -1)) engine.arriving.held.push([1, p])
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(plansOf(1), 'four of the five are not enough').toEqual([firstPlan(1)])
  await afterPass()
  const inAt = performance.now()
  for (const p of FIRST_READ.slice(-1)) engine.arriving.held.push([1, p])
  await vi.waitFor(() => expect(plansOf(1).at(-1)).toEqual(wholePlan(1)), { timeout: 1_000, interval: 1 })
  expect(performance.now() - inAt).toBeLessThan(100)
  await vi.waitFor(() => expect(rig.of('read-result')).toHaveLength(1))
}, 10_000)

it('adds it on the pass when no read waits on those pieces', async () => {
  await firstWatch(2)
  engine.arriving.listed.add(2)
  await vi.waitFor(() => expect(plansOf(2)).toEqual([firstPlan(2)]))
  for (const p of FIRST_READ) engine.arriving.held.push([2, p])
  await vi.waitFor(() => expect(plansOf(2).at(-1)).toEqual(wholePlan(2)), { timeout: 1_500, interval: 5 })
}, 10_000)

it('plans a seek whole at once, though the first read\'s pieces are not in', async () => {
  await firstWatch(3)
  engine.arriving.listed.add(3)
  await vi.waitFor(() => expect(plansOf(3)).toEqual([firstPlan(3)]))
  rig.send({ type: 'watch', viewer: 'player-3', handle: 3, fileIndex: 0, fromOffset: 30_000_000 })
  await vi.waitFor(() => expect(plansOf(3).at(-1)).toEqual([3, [{ fileIndex: 0, offset: 30_000_000 }, TAIL], expect.objectContaining({ windowPieces: 6 })]))
  expect(rig.of('worker-error')).toEqual([])
}, 10_000)
