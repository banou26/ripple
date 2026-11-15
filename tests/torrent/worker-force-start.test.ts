// Force start runs a torrent outside libtorrent's queue, through a reload, a recheck, a move and a restart by
// recovery, until the person's Pause or Resume; and a player skips the queue while it watches.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const FORCED = 'a'.repeat(40)
const QUEUED = 'b'.repeat(40)
const GONE = 'c'.repeat(40)
const PAUSED = 16
const MANAGED = 32

// libtorrent's two flags per torrent, and a queue with no free slot, which parks every torrent it manages
const engine = vi.hoisted(() => ({
  ids: new Map<string, number>(),
  paused: new Map<number, boolean>(),
  managed: new Map<number, boolean>(),
  added: 0,
}))
const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  // an add starts paused and auto-managed, libtorrent's default
  const add = (magnet: string) => {
    const h = engine.ids.get(magnet) ?? ++engine.added
    engine.ids.set(magnet, h)
    engine.paused.set(h, true)
    engine.managed.set(h, true)
    return h
  }
  return {
    createSession: async () => fakeSession({
      addMagnet: add,
      popAlerts: () => { for (const [h, managed] of engine.managed) if (managed) engine.paused.set(h, true); return [] },
      status: (h: number) => (!engine.paused.has(h) ? null : {
        state: 3, paused: engine.paused.get(h), autoManaged: engine.managed.get(h), errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: 0,
        activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
      }),
      pauseTorrent: (h: number) => { engine.managed.set(h, false); engine.paused.set(h, true) },
      resumeTorrent: (h: number) => { engine.managed.set(h, true); engine.paused.set(h, false) },
      forceRecheck: (h: number) => { engine.managed.set(h, true); engine.paused.set(h, false) },
      setFlags: (h: number, flags: number, mask: number) => {
        if (mask & PAUSED) engine.paused.set(h, (flags & PAUSED) !== 0)
        if (mask & MANAGED) engine.managed.set(h, (flags & MANAGED) !== 0)
      },
      saveResumeData: async () => new Uint8Array([1]),
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1, paused: PAUSED, autoManaged: MANAGED },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  const entry = (infoHash: string, over: Partial<Persisted> = {}): Persisted => ({
    infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/dl/' + infoHash, addedAt: 1, lastUsedAt: 1, started: true, ...over,
  })
  // forced in an earlier session; one in the queue; one forced whose files went, now a row to download again
  store.set('ripple:torrents', [entry(FORCED, { forced: true }), entry(QUEUED), entry(GONE, { forced: true, started: false })])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const entryOf = (infoHash: string) => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === infoHash)
const flagsOf = (h: number) => ({ paused: engine.paused.get(h), managed: engine.managed.get(h) })
const RUNNING = { paused: false, managed: false }
const HELD = { paused: true, managed: true }
// two pumps, so anything a message set off has reached the engine and the queue has had its turn
const pumps = () => new Promise((resolve) => setTimeout(resolve, 1_100))

it('keeps a force started torrent out of the queue until a pause or resume, and a watched one while it is watched', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  const forced = engine.ids.get('magnet:?xt=urn:btih:' + FORCED)!
  const queued = engine.ids.get('magnet:?xt=urn:btih:' + QUEUED)!
  await pumps()
  // THE CONTROL: the queue holds what it manages
  expect(flagsOf(queued)).toEqual(HELD)
  expect(flagsOf(forced), 'a reload lost the Force start').toEqual(RUNNING)

  rig.send({ type: 'force-start', handle: queued })
  await vi.waitFor(() => expect(entryOf(QUEUED)).toMatchObject({ forced: true }))
  await pumps()
  expect(flagsOf(queued)).toEqual(RUNNING)

  rig.send({ type: 'recheck', handle: queued })
  await pumps()
  expect(flagsOf(queued), 'a recheck handed it back to the queue').toEqual(RUNNING)

  rig.send({ type: 'relocate', infoHash: QUEUED, to: 'folder' })
  await vi.waitFor(() => expect(entryOf(QUEUED)).toMatchObject({ saveTo: 'folder' }))
  await pumps()
  expect(flagsOf(queued), 'a move handed it back to the queue').toEqual(RUNNING)

  rig.send({ type: 'pause', handle: queued })
  await vi.waitFor(() => expect(entryOf(QUEUED)).toMatchObject({ paused: true, forced: false }))
  rig.send({ type: 'force-start', handle: queued })
  await vi.waitFor(() => expect(entryOf(QUEUED)).toMatchObject({ paused: false, forced: true }))
  rig.send({ type: 'resume', handle: queued })
  await vi.waitFor(() => expect(entryOf(QUEUED)).toMatchObject({ forced: false }))
  await pumps()
  expect(flagsOf(queued), 'Resume hands it back to the queue').toEqual(HELD)

  // a player skips the queue while it watches, and gives the torrent back when it leaves
  rig.send({ type: 'watch', viewer: 'player', handle: queued, fileIndex: 0, fromOffset: 0 })
  await pumps()
  expect(flagsOf(queued), 'the queue held a torrent somebody is watching').toEqual(RUNNING)
  rig.send({ type: 'unwatch', viewer: 'player' })
  await pumps()
  expect(flagsOf(queued)).toEqual(HELD)
  // and leaves a forced one forced
  rig.send({ type: 'watch', viewer: 'player', handle: forced, fileIndex: 0, fromOffset: 0 })
  rig.send({ type: 'unwatch', viewer: 'player' })
  await pumps()
  expect(flagsOf(forced)).toEqual(RUNNING)

  // downloaded again, a row whose files went starts as any download does
  rig.send({ type: 'start', infoHash: GONE })
  await vi.waitFor(() => expect(entryOf(GONE)).toMatchObject({ started: true, forced: false }))

  // stopped by the engine, recovery starts it again outside the queue, once its hold and its first wait are over
  engine.paused.set(forced, true)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.now() + 11_000)
    await pumps()
    vi.setSystemTime(Date.now() + 6_000)
    await pumps()
    expect(flagsOf(forced), 'recovery handed it back to the queue').toEqual(RUNNING)
  } finally {
    vi.useRealTimers()
  }
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 30_000)
