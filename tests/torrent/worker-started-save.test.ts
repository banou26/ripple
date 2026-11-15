// A Save that wakes a parked temporary torrent parks it again once it ends, unless the person started
// it: then it runs, after the Save and through players coming and going, until the person stops it.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024
const CHUNK = 64 * 1024

const engine = vi.hoisted(() => ({
  // one handle per torrent, by the first letter of its hash
  ids: new Map<string, number>(),
  queued: new Set<number>(),
  live: new Set<number>(),
  registered: new Set<number>(),
  paused: new Set<number>(),
  log: [] as string[],
  // a read at this offset waits for the test to let it go, as one waiting on its pieces does
  slow: { at: -1, go: () => {} },
}))

const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const running = {
    state: 3, paused: false, autoManaged: true, errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: 0,
    activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
  }
  // a poster in the first piece, which is on disk, and a film after it, which is not
  const layout = { storageIndex: 0, pieceLength: MiB, numPieces: 30, totalSize: 30 * MiB, contentSize: 30 * MiB, files: [
    { path: 'poster.jpg', offset: 0, size: MiB, pad: false },
    { path: 'film.mp4', offset: MiB, size: 29 * MiB, pad: false },
  ] }
  const name = (h: number) => [...engine.ids].find(([, id]) => id === h)?.[0]
  const tick = () => { for (const h of engine.queued) engine.live.add(h); engine.queued.clear() }
  setInterval(tick, 250)
  return {
    createSession: async () => fakeSession({
      tick,
      addMagnet: (magnet: string) => {
        const c = /btih:(\w)/.exec(magnet)![1]!
        if (!engine.ids.has(c)) engine.ids.set(c, engine.ids.size + 1)
        const h = engine.ids.get(c)!
        engine.queued.add(h)
        return h
      },
      popAlerts: () => { for (const h of engine.live) engine.registered.add(h); return [] },
      status: (h: number) => (!engine.registered.has(h) ? null
        : engine.paused.has(h) ? { ...running, paused: true, autoManaged: false } : running),
      files: (h: number) => (engine.registered.has(h) ? layout : null),
      bitfield: (h: number) => (engine.registered.has(h) ? { pieces: new Uint8Array([0x80, 0, 0, 0]), numPieces: 30, pieceLength: MiB, length: 30 * MiB } : null),
      read: async (_h: number, _file: number, offset: number, len: number) => {
        if (offset === engine.slow.at) await new Promise<void>((resolve) => { engine.slow.go = resolve })
        return new Uint8Array(len)
      },
      setStreamWindow: () => true,
      pauseTorrent: (h: number) => { engine.paused.add(h); engine.log.push(`pause ${name(h)}`) },
      resumeTorrent: (h: number) => { engine.paused.delete(h); engine.log.push(`resume ${name(h)}`) },
      // libtorrent's check clears a pause itself
      forceRecheck: (h: number) => { engine.paused.delete(h); engine.log.push(`recheck ${name(h)}`) },
      saveResumeData: async () => new Uint8Array([1]),
      setDownloadLimit: () => {},
      setUploadLimit: () => {},
      clearStreamWindow: () => {},
      prioritizePieces: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  // what a reload finds: two films watched earlier and kept as cache, and one of the person's own
  const entry = (c: string, ephemeral = true): Persisted => ({
    infoHash: c.repeat(40), magnet: `magnet:?xt=urn:btih:${c.repeat(40)}`, savePath: `/${ephemeral ? 'cache' : 'dl'}/${c.repeat(40)}`,
    addedAt: 1, lastUsedAt: 1, started: true, paused: false, ephemeral,
  })
  store.set('ripple:torrents', [entry('e'), entry('g'), entry('1', false)])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const handleOf = (c: string) => engine.ids.get(c)!
const of = (c: string) => engine.log.filter((line) => line.endsWith(` ${c}`)).map((line) => line.split(' ')[0])
const entryOf = (c: string) => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === c.repeat(40))
const pumps = (n: number) => new Promise((resolve) => setTimeout(resolve, n * 500 + 100))
// what the worker waits for after the last read with no viewer before it parks the torrent again
const quiet = () => new Promise((resolve) => setTimeout(resolve, 6_500))

// the library's Save reads with priority and no viewer
const save = async (id: string, c: string, offset: number) => {
  rig.send({ type: 'read', id, handle: handleOf(c), fileIndex: 1, offset, len: CHUNK })
  await vi.waitFor(() => expect(rig.posted.find((m) => m.id === id)).toBeDefined())
  await pumps(2)
  return rig.posted.find((m) => m.id === id)!
}

const comeAndGo = (c: string, viewer: string) => {
  rig.send({ type: 'watch', viewer, handle: handleOf(c), fileIndex: 1, fromOffset: 0 })
  rig.send({ type: 'unwatch', viewer })
}

it('parks again a temporary torrent nobody started once the Save that woke it ends', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  // the reload parks both, as nobody watches them
  await vi.waitFor(() => expect([of('e'), of('g')]).toEqual([['pause'], ['pause']]), { timeout: 2_000 })
  expect((await save('save', 'e', 2 * MiB)).type).toBe('read-result')
  expect(of('e')).toEqual(['pause', 'resume'])
  await vi.waitFor(() => expect(of('e')).toEqual(['pause', 'resume', 'pause']), { timeout: 8_000 })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('never parks after a Save one the person started before it', async () => {
  rig.send({ type: 'resume', handle: handleOf('e') })
  await vi.waitFor(() => expect(entryOf('e')).toMatchObject({ paused: false, resumed: true }))
  expect((await save('their save', 'e', 4 * MiB)).type).toBe('read-result')
  expect((await save('its end', 'e', 6 * MiB)).type).toBe('read-result')
  await quiet()
  expect(of('e')).toEqual(['pause', 'resume', 'pause', 'resume'])
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

// without the person's Resume the Save would park it again once it ends, as above; their Resume outranks every park
it('keeps running one the person resumed while a Save read it, after the Save and through a player', async () => {
  engine.slow.at = 4 * MiB
  rig.send({ type: 'read', id: 'slow save', handle: handleOf('g'), fileIndex: 1, offset: 4 * MiB, len: CHUNK })
  await vi.waitFor(() => expect(of('g')).toEqual(['pause', 'resume']))
  rig.send({ type: 'resume', handle: handleOf('g') })
  await vi.waitFor(() => expect(entryOf('g')).toMatchObject({ paused: false, resumed: true }))
  engine.slow.at = -1
  engine.slow.go()
  await vi.waitFor(() => expect(rig.posted.find((m) => m.id === 'slow save')?.type).toBe('read-result'))
  expect((await save('next chunk', 'g', 6 * MiB)).type).toBe('read-result')
  await quiet()
  expect(of('g')).toEqual(['pause', 'resume', 'resume'])
  comeAndGo('g', 'player:1')
  await pumps(2)
  expect(of('g')).toEqual(['pause', 'resume', 'resume'])
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 25_000)

it('ends the Start with the person\'s Stop, so once a check has cleared the Stop it is parked as before', async () => {
  rig.send({ type: 'pause', handle: handleOf('g') })
  await vi.waitFor(() => expect(entryOf('g')).toMatchObject({ paused: true, resumed: false }))
  // a check clears the person's pause, as libtorrent's does
  rig.send({ type: 'recheck', handle: handleOf('g') })
  await vi.waitFor(() => expect(entryOf('g')).toMatchObject({ paused: false }))
  comeAndGo('g', 'player:2')
  await vi.waitFor(() => expect(of('g')).toEqual(['pause', 'resume', 'resume', 'pause', 'recheck', 'pause']), { timeout: 2_000 })
  expect((await save('after the check', 'g', 8 * MiB)).type).toBe('read-result')
  await vi.waitFor(() => expect(of('g').slice(6)).toEqual(['resume', 'pause']), { timeout: 8_000 })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 20_000)

it('parks a library torrent the person started once they make it temporary', async () => {
  // held and then started, as the add dialog's Start does
  rig.send({ type: 'pause', handle: handleOf('1') })
  rig.send({ type: 'resume', handle: handleOf('1') })
  await vi.waitFor(() => expect(of('1')).toEqual(['pause', 'resume']))
  rig.send({ type: 'set-temporary', infoHash: '1'.repeat(40), temporary: true })
  await vi.waitFor(() => expect(entryOf('1')).toMatchObject({ ephemeral: true, resumed: false }))
  comeAndGo('1', 'player:3')
  await vi.waitFor(() => expect(of('1')).toEqual(['pause', 'resume', 'pause']), { timeout: 2_000 })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
})

it('keeps the person\'s Start through a Force recheck', async () => {
  rig.send({ type: 'resume', handle: handleOf('g') })
  await vi.waitFor(() => expect(entryOf('g')).toMatchObject({ paused: false, resumed: true }))
  rig.send({ type: 'recheck', handle: handleOf('g') })
  await vi.waitFor(() => expect(of('g').slice(8)).toEqual(['resume', 'recheck']))
  comeAndGo('g', 'player:4')
  await pumps(2)
  expect(of('g').slice(8)).toEqual(['resume', 'recheck'])
  expect(entryOf('g')).toMatchObject({ paused: false, resumed: true })
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
})
