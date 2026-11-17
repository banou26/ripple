// How a first watch's window is planned: on the pump that brings the layout, not the next 500 ms pass.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A film of 60 MB in 512 KiB pieces (115 of them, the last 114), as on the swarm rig. As in libtorrent-wasm, a layout
 * and a piece reach the worker only through the next `popAlerts`: `arriving` is what that drain brings.
 */
const engine = vi.hoisted(() => ({
  arriving: { listed: new Set<number>(), held: [] as [number, number][] },
  listed: new Set<number>(),
  held: new Map<number, Set<number>>(),
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
    for (const p of engine.held.get(h) ?? []) pieces[p >> 3] |= 0x80 >> (p & 7)
    return pieces
  }
  return {
    createSession: async () => fakeSession({
      popAlerts: () => {
        for (const h of engine.arriving.listed) engine.listed.add(h)
        for (const [h, p] of engine.arriving.held) engine.held.set(h, new Set([...engine.held.get(h) ?? [], p]))
        engine.arriving = { listed: new Set(), held: [] }
        return []
      },
      files: (h: number) => engine.listed.has(h) ? LAYOUT : null,
      bitfield: (h: number) => engine.listed.has(h) ? { numPieces: 115, pieceLength: 524_288, length: 115, pieces: bits(h) } : null,
      setStreamWindow: engine.setStreamWindow,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
      read: () => new Promise(() => {}),
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
