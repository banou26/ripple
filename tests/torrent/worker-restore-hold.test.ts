// A temporary torrent restored with no saved state asks for no piece before the pump that parks it,
// and every way out of a page's hold still leads out of this one.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

const PARKED = 'a'.repeat(40)
const WATCHED = 'b'.repeat(40)
const KEPT = 'c'.repeat(40)
const REMOVED = 'd'.repeat(40)
const PAUSED = 'e'.repeat(40)
const LIBRARY = '1'.repeat(40)
const SAVED = '2'.repeat(40)
const FROM_FILE = '3'.repeat(40)
const UPLOAD = 1
const MiB = 1024 * 1024

// the engine's rules from worker-hold-upload.test.ts: calls land in order, a hash keeps its id, an add
// is registered only by a pump after a tick, and one added from a .torrent or a saved state has its
// layout from the start
const engine = vi.hoisted(() => ({
  ids: new Map<string, number>(),
  queued: new Set<number>(),
  live: new Set<number>(),
  registered: new Set<number>(),
  withMeta: new Set<string>(['2'.repeat(40), '3'.repeat(40)]),
  upload: new Set<number>(),
  paused: new Set<number>(),
  log: [] as string[],
}))

// the saved state's directory, or the restore reads the origin as cleared and drops the blob
const rig = installWorkerGlobals({
  estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }),
  root: fakeDir('', [fakeDir('cache', [fakeDir(SAVED)])]),
})

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
  const tick = () => { for (const h of engine.queued) engine.live.add(h); engine.queued.clear() }
  setInterval(tick, 250)
  // every add names its save path, which ends in the hash
  const add = (hash: string) => {
    if (!engine.ids.has(hash)) engine.ids.set(hash, engine.ids.size + 1)
    const h = engine.ids.get(hash)!
    engine.queued.add(h)
    return h
  }
  const bySavePath = (_: unknown, savePath: string) => add(savePath.slice(-40))
  return {
    createSession: async () => fakeSession({
      tick,
      addMagnet: (magnet: string) => add(/btih:(\w{40})/.exec(magnet)![1]!),
      addTorrentFile: bySavePath,
      addTorrentWithResume: bySavePath,
      removeTorrent: (h: number) => {
        for (const set of [engine.queued, engine.live, engine.registered, engine.upload, engine.paused]) set.delete(h)
      },
      popAlerts: () => { for (const h of engine.live) engine.registered.add(h); return [] },
      status: (h: number) => (!engine.registered.has(h) ? null
        : engine.paused.has(h) ? { ...running, paused: true, autoManaged: false } : running),
      files: (h: number) => (engine.registered.has(h) && engine.withMeta.has(hashOf(h)!) ? layout : null),
      setFlags: (h: number, flags: number, mask: number) => {
        if (!engine.registered.has(h) || !(mask & UPLOAD) || engine.upload.has(h) === !!(flags & UPLOAD)) return
        if (flags & UPLOAD) engine.upload.add(h); else engine.upload.delete(h)
        engine.log.push(`${hashOf(h)} upload ${flags & UPLOAD ? 'on' : 'off'}`)
      },
      postStatus: (h: number) => { engine.log.push(`${hashOf(h)} pump`) },
      pauseTorrent: (h: number) => {
        if (engine.registered.has(h)) engine.paused.add(h)
        engine.log.push(`${hashOf(h)} pause`)
      },
      resumeTorrent: (h: number) => { engine.paused.delete(h); engine.log.push(`${hashOf(h)} resume`) },
      saveResumeData: async (h: number) => {
        engine.log.push(`${hashOf(h)} save ${engine.upload.has(h) ? 'in upload mode' : 'plain'}`)
        return new Uint8Array([1])
      },
      read: async (_h: number, _file: number, _offset: number, len: number) => new Uint8Array(len),
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      prioritizePieces: () => {},
      setSequential: () => {},
      setDownloadLimit: () => {},
      setUploadLimit: () => {},
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
  // what the next tab finds when the one running the engine closed before these had their metadata
  const entry = (hash: string, ephemeral: boolean): Persisted => ({
    infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, savePath: `/${ephemeral ? 'cache' : 'dl'}/${hash}`, addedAt: 1, lastUsedAt: 1, started: true, paused: false, ephemeral,
  })
  const store = new Map<string, unknown>([
    ['ripple:torrents', [
      ...['a', 'b', 'c', 'd', '2', '3'].map((c) => entry(c.repeat(40), true)),
      entry('1'.repeat(40), false),
      { ...entry('e'.repeat(40), true), paused: true },
    ]],
    // one parked earlier, which a resume blob brings back
    [`ripple:resume:${'2'.repeat(40)}`, new Uint8Array([1])],
    [`ripple:torrent:${'3'.repeat(40)}`, new Uint8Array([1])],
  ])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const of = (hash: string) => engine.log.filter((line) => line.startsWith(hash) && !line.endsWith(' pump')).map((line) => line.slice(41))
const handleOf = (hash: string) => engine.ids.get(hash)!
const pumps = (n: number) => new Promise((resolve) => setTimeout(resolve, n * 500 + 100))

it('holds a temporary torrent restored with no saved state until the pump that parks it', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  // a page closing flushes every torrent's resume data, and a .torrent restores with its layout, so
  // nothing may hand over a blob in upload mode either, before the pump that parks it
  rig.send({ type: 'flush-resume' })
  rig.send({ type: 'export-start', id: 'give', infoHash: FROM_FILE })
  await vi.waitFor(() => expect(rig.of('answer').find((m) => m.id === 'give')).toBeDefined())
  expect(rig.of('answer').find((m) => m.id === 'give')!.value).toBeNull()

  // before any pump has seen them
  for (const hash of [PARKED, WATCHED, KEPT, REMOVED, FROM_FILE, PAUSED]) {
    expect(engine.log.find((line) => line.startsWith(hash)), hash).toBe(`${hash} upload on`)
  }
  await pumps(2)
  for (const hash of [PARKED, WATCHED, KEPT, REMOVED]) expect(of(hash), hash).toEqual(['upload on'])
  expect(of(FROM_FILE)).toEqual(['upload on', 'pause', 'upload off', 'save plain'])
  // one the person paused runs until a pump pauses it, so it is held too
  expect(of(PAUSED)).toEqual(['upload on', 'pause'])
  // a saved state or a library download is not held, and the flush saved them
  expect(of(SAVED)).toContain('save plain')
  expect(of(LIBRARY)).toEqual(['save plain'])
  expect([...of(SAVED), ...of(LIBRARY)].filter((line) => line.startsWith('upload'))).toEqual([])

  engine.withMeta.add(PARKED)
  await vi.waitFor(() => expect(of(PARKED)).toContain('save plain'), { timeout: 2_000 })
  expect(of(PARKED)).toEqual(['upload on', 'pause', 'upload off', 'save plain'])
  // saved from, as one file chosen or Download all on the download page reads it
  rig.send({ type: 'read', id: 'save', handle: handleOf(PARKED), fileIndex: 0, offset: 0, len: 1024, viewer: 'page:1' })
  await vi.waitFor(() => expect(of(PARKED)).toContain('resume'))
  await pumps(1)
  expect(of(PARKED).filter((line) => line.startsWith('upload'))).toEqual(['upload on', 'upload off'])
  expect(engine.upload.has(handleOf(PARKED))).toBe(false)
}, 20_000)

it('lets a player watching it have it at once: out of upload mode before its metadata, and never parked', async () => {
  rig.send({ type: 'watch', viewer: 'player:1', handle: handleOf(WATCHED), fileIndex: 1, fromOffset: 0 })
  // not at the layout: a torrent in upload mode drops every seed the moment its metadata lands
  await vi.waitFor(() => expect(of(WATCHED)).toEqual(['upload on', 'upload off']), { timeout: 2_000 })
  engine.withMeta.add(WATCHED)
  await pumps(2)
  expect(of(WATCHED)).toEqual(['upload on', 'upload off'])
})

it('takes one the library keeps before its metadata out of upload mode', async () => {
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${KEPT}`, ephemeral: false })
  await vi.waitFor(() => expect(rig.of('added').some((m) => m.handle === handleOf(KEPT))).toBe(true))
  engine.withMeta.add(KEPT)
  await vi.waitFor(() => expect(of(KEPT)).toContain('upload off'), { timeout: 2_000 })
  await pumps(1)
  expect(of(KEPT)).toEqual(['upload on', 'upload off'])
})

it('parks one the person paused and resumed at its layout, out of upload mode', async () => {
  rig.send({ type: 'resume', handle: handleOf(PAUSED) })
  engine.withMeta.add(PAUSED)
  await vi.waitFor(() => expect(of(PAUSED)).toContain('save plain'), { timeout: 2_000 })
  expect(of(PAUSED)).toEqual(['upload on', 'pause', 'resume', 'pause', 'upload off', 'save plain'])
})

it('forgets the hold of one removed, so the same hash added again saves its resume data', async () => {
  const h = handleOf(REMOVED)
  rig.send({ type: 'remove', handle: h })
  await vi.waitFor(() => expect(engine.live.has(h)).toBe(false))
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${REMOVED}`, ephemeral: true })
  await vi.waitFor(() => expect(engine.live.has(h)).toBe(true))
  engine.withMeta.add(REMOVED)
  await vi.waitFor(() => expect(engine.registered.has(h)).toBe(true))
  rig.send({ type: 'pause', handle: h })
  await vi.waitFor(() => expect(of(REMOVED)).toContain('save plain'), { timeout: 2_000 })
  expect(of(REMOVED).filter((line) => line.startsWith('save'))).toEqual(['save plain'])
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
})
