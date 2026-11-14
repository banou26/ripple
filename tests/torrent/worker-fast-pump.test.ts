// A player waiting on a file list, and a read waiting on pieces, are answered by a pump of the engine's alerts, which
// runs every 50 ms while they wait and never otherwise.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * The engine's contract as libtorrent-wasm states it (`read`, `tick`, `popAlerts`): a status is asked with
 * `postStatus`, answered inside a tick with what the engine holds at that moment, and reaches the have-bits and
 * the file list only once `popAlerts` drains it. The engine also ticks itself every 250 ms. Handle 1 is a film
 * already on the device once `onDisk` is set; handle 2 has its file list and never gets a piece.
 */
const engine = vi.hoisted(() => ({
  onDisk: false,
  ready: false,
  layout: false,
  have: false,
  asked: new Set<number>(),
  answered: new Map<number, boolean>(),
  waiters: [] as { handle: number, resolve: () => void }[],
  pumps: 0,
}))
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })
const LAYOUT = { storageIndex: 0, pieceLength: 1_048_576, numPieces: 10, totalSize: 10_000_000, contentSize: 10_000_000, files: [{ path: 'film.mkv', offset: 0, size: 10_000_000, pad: false }] }

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const tick = () => {
    for (const h of engine.asked) engine.answered.set(h, h === 1 && engine.ready)
    engine.asked.clear()
    if (engine.onDisk) engine.ready = true
    for (const w of engine.waiters) engine.asked.add(w.handle)
  }
  return {
    createSession: async () => {
      setInterval(tick, 250)
      return fakeSession({
        tick,
        postStatus: (h: number) => { engine.asked.add(h) },
        popAlerts: () => {
          engine.pumps++
          if (engine.ready) engine.layout = true
          if (engine.answered.get(1)) engine.have = true
          engine.answered.clear()
          for (const w of engine.waiters.filter((w) => w.handle === 1 && engine.have)) {
            engine.waiters.splice(engine.waiters.indexOf(w), 1)
            w.resolve()
          }
          return []
        },
        files: (h: number) => h === 2 || engine.layout ? LAYOUT : null,
        bitfield: (h: number) => h === 1 && engine.have ? { numPieces: 10, pieceLength: 1_048_576, length: 10, pieces: new Uint8Array([0xff, 0xc0]) } : null,
        read: async (h: number, _fileIndex: number, _offset: number, len: number) => {
          if (!(h === 1 && engine.have)) {
            engine.asked.add(h)
            await new Promise<void>((resolve) => engine.waiters.push({ handle: h, resolve }))
          }
          return new Uint8Array(len)
        },
        setStreamWindow: () => true,
        clearStreamWindow: () => {},
        cancelPieceRequests: () => {},
      })
    },
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const pumpsOver = async (ms: number) => {
  const before = engine.pumps
  await sleep(ms)
  return engine.pumps - before
}
/** Resolves just after the 500 ms pass posts its state, so that pass is as far away as it gets. */
const afterPass = async () => {
  const states = rig.of('state').length
  await vi.waitFor(() => expect(rig.of('state').length).toBeGreaterThan(states), { timeout: 1_000, interval: 5 })
}

it('nothing waits, so nothing pumps but the 500 ms pass: not a download page\'s held claim either', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` })
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2))
  expect(await pumpsOver(2_000)).toBeLessThanOrEqual(5)

  rig.send({ type: 'watch', viewer: 'download-page', handle: 1, fileIndex: 0, fromOffset: 0, held: true })
  expect(await pumpsOver(1_000)).toBeLessThanOrEqual(3)
  rig.send({ type: 'unwatch', viewer: 'download-page' })
}, 10_000)

let listedAt = 0

it('a film on the device: its file list comes within 100 ms of the player, and the open panel keeps its detail', async () => {
  rig.send({ type: 'inspect', handle: 1 })
  await afterPass()
  const watchedAt = performance.now()
  engine.onDisk = true
  rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(rig.of('state').at(-1)?.torrents).toContainEqual(expect.objectContaining({ handle: 1, files: LAYOUT })), { timeout: 2_000, interval: 1 })
  listedAt = performance.now()
  expect(listedAt - watchedAt).toBeLessThan(100)
  expect(rig.of('state').at(-1)).toMatchObject({ detail: { handle: 1 }, transport: 'relay', inboundNow: expect.any(Object), rateLimits: { down: 0, up: 0 } })
}, 10_000)

it('its first read, of bytes on the device, comes within 100 ms of the file list', async () => {
  rig.send({ type: 'read', id: 1, viewer: 'player', handle: 1, fileIndex: 0, offset: 0, len: 1_000 })
  await vi.waitFor(() => expect(rig.of('read-result')).toHaveLength(1), { timeout: 2_000, interval: 1 })
  expect(performance.now() - listedAt).toBeLessThan(100)
}, 10_000)

it('the pump stops once the read is answered and the list is in', async () => {
  expect(await pumpsOver(2_000)).toBeLessThanOrEqual(5)
}, 10_000)

it('an engine being replaced is not pumped, though a read still waits in it', async () => {
  rig.send({ type: 'read', id: 2, viewer: 'player', handle: 2, fileIndex: 0, offset: 0, len: 1_000 })
  expect(await pumpsOver(1_000), 'the read waiting on pieces is pumped').toBeGreaterThanOrEqual(10)

  rig.send({ type: 'close-sockets', id: 3 })
  await vi.waitFor(() => expect(rig.of('answer').filter((m) => m.id === 3)).toHaveLength(1))
  expect(await pumpsOver(1_000)).toBeLessThanOrEqual(3)
  expect(rig.of('worker-error')).toEqual([])
}, 10_000)
