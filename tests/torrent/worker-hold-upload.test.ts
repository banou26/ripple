// A page-added torrent asks for no piece between its add and the pump that parks it, and saves no blob that asks for none.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const HELD = 'e'.repeat(40)
const AGAIN = 'f'.repeat(40)
const WATCHED = 'a'.repeat(40)
const KEPT = 'b'.repeat(40)
const UPLOAD = 1
const MiB = 1024 * 1024

// the fake keeps the engine's three rules this depends on: a call lands in the order it was made,
// from the add on, libtorrent-wasm gives a hash the same id every time it is added, and an add is
// reported on only by a pump after a tick (the session ticks itself every 250 ms)
const engine = vi.hoisted(() => ({
  ids: new Map<string, number>(),
  queued: new Set<number>(),
  live: new Set<number>(),
  registered: new Set<number>(),
  withMeta: new Set<string>(),
  upload: new Set<number>(),
  paused: new Set<number>(),
  log: [] as string[],
}))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const running = {
    state: 3, paused: false, autoManaged: true, errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: 0,
    activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
  }
  const layout = { storageIndex: 0, pieceLength: MiB, numPieces: 30, totalSize: 30 * MiB, contentSize: 30 * MiB, files: [
    { path: 'a.srt', offset: 0, size: MiB, pad: false },
    { path: 'b.mp4', offset: MiB, size: 29 * MiB, pad: false },
  ] }
  const hashOf = (h: number) => [...engine.ids].find(([, id]) => id === h)?.[0]
  const added = (h: number) => engine.queued.has(h) || engine.live.has(h)
  const tick = () => { for (const h of engine.queued) engine.live.add(h); engine.queued.clear() }
  setInterval(tick, 250)
  return {
    createSession: async () => fakeSession({
      tick,
      addMagnet: (magnet: string) => {
        const hash = /btih:(\w{40})/.exec(magnet)![1]!
        if (!engine.ids.has(hash)) engine.ids.set(hash, engine.ids.size + 1)
        const h = engine.ids.get(hash)!
        engine.queued.add(h)
        return h
      },
      removeTorrent: (h: number) => {
        for (const set of [engine.queued, engine.live, engine.registered, engine.upload, engine.paused]) set.delete(h)
      },
      popAlerts: () => { for (const h of engine.live) engine.registered.add(h); return [] },
      status: (h: number) => (!engine.registered.has(h) ? null
        : engine.paused.has(h) ? { ...running, paused: true, autoManaged: false } : running),
      files: (h: number) => (engine.registered.has(h) && engine.withMeta.has(hashOf(h)!) ? layout : null),
      // like libtorrent: a removed torrent ignores it, and an unchanged flag changes nothing
      setFlags: (h: number, flags: number, mask: number) => {
        if (!added(h) || !(mask & UPLOAD) || engine.upload.has(h) === !!(flags & UPLOAD)) return
        if (flags & UPLOAD) engine.upload.add(h); else engine.upload.delete(h)
        engine.log.push(`${hashOf(h)} upload ${flags & UPLOAD ? 'on' : 'off'}`)
      },
      postStatus: (h: number) => { engine.log.push(`${hashOf(h)} pump`) },
      pauseTorrent: (h: number) => {
        if (added(h)) engine.paused.add(h)
        engine.log.push(`${hashOf(h)} pause`)
      },
      resumeTorrent: (h: number) => { engine.paused.delete(h) },
      saveResumeData: async (h: number) => {
        engine.log.push(`${hashOf(h)} save ${engine.upload.has(h) ? 'in upload mode' : 'plain'}`)
        return new Uint8Array([1])
      },
      clearStreamWindow: () => {},
      prioritizePieces: () => {},
      setSequential: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: UPLOAD },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const add = async (hash: string, hold: boolean, ephemeral = true) => {
  const before = rig.of('added').length
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${hash}`, ephemeral, hold })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(before + 1))
  return rig.of('added').at(-1)!.handle as number
}
const of = (hash: string) => engine.log.filter((line) => line.startsWith(hash)).map((line) => line.slice(41))
const saved = (hash: string) => of(hash).filter((line) => line.startsWith('save'))

it('holds a page-added torrent in upload mode from its add to the pump that parks it, and out of every resume blob', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  const h = await add(HELD, true)

  // before any pump has seen it: the metadata can land before the next one
  expect(of(HELD)[0]).toBe('upload on')
  // a page closing now flushes every torrent's resume data
  rig.send({ type: 'flush-resume' })
  await vi.waitFor(() => expect(of(HELD).filter((line) => line === 'pump').length).toBeGreaterThan(1), { timeout: 2_000 })

  engine.withMeta.add(HELD)
  await vi.waitFor(() => expect(saved(HELD).length).toBeGreaterThan(0), { timeout: 2_000 })
  // parked, then out of upload mode, then the park's blob: never a moment with the layout, running
  // and asking, and never a blob that comes back in upload mode
  expect(of(HELD).filter((line) => line !== 'pump')).toEqual(['upload on', 'pause', 'upload off', 'save plain'])
  expect(rig.of('worker-error')).toEqual([])
}, 20_000)

it('asks nothing of a torrent the player adds', async () => {
  const h = await add(WATCHED, false)
  engine.withMeta.add(WATCHED)
  await vi.waitFor(() => expect(engine.registered.has(h)).toBe(true))
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  expect(of(WATCHED).filter((line) => line.startsWith('upload'))).toEqual([])
})

it('forgets the hold of a torrent removed before its metadata, so the same hash added again saves its resume data', async () => {
  const h = await add(AGAIN, true)
  await vi.waitFor(() => expect(engine.upload.has(h)).toBe(true), { timeout: 2_000 })
  rig.send({ type: 'remove', handle: h })
  await vi.waitFor(() => expect(engine.live.has(h)).toBe(false))

  expect(await add(AGAIN, false)).toBe(h)
  engine.withMeta.add(AGAIN)
  await vi.waitFor(() => expect(engine.registered.has(h)).toBe(true))
  rig.send({ type: 'pause', handle: h })
  await vi.waitFor(() => expect(saved(AGAIN)).toEqual(['save plain']), { timeout: 2_000 })
  expect(rig.of('worker-error')).toEqual([])
})

it('takes a held torrent the library keeps before its metadata out of upload mode', async () => {
  const h = await add(KEPT, true)
  await vi.waitFor(() => expect(engine.upload.has(h)).toBe(true), { timeout: 2_000 })
  expect(await add(KEPT, false, false)).toBe(h)

  engine.withMeta.add(KEPT)
  await vi.waitFor(() => expect(of(KEPT)).toContain('upload off'), { timeout: 2_000 })
  expect(of(KEPT)).not.toContain('pause')
  expect(rig.of('worker-error')).toEqual([])
})
