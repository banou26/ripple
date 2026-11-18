// A temporary torrent started again with nobody watching checks its files first, and a pause stops a check where it
// is: parked before its check ended, one with every file on the device read Queued at 0% for good.
import type { TorrentSnapshot } from '../../src/torrent/client'
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { snapshotState } from '../../src/torrent/use-torrents'
import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

// hoisted, as the row's derivation imports the engine's module before this file's own top level runs
const { RESTARTED, MOVED, STARTED, CHECK_TICKS } = vi.hoisted(() => ({ RESTARTED: 'a'.repeat(40), MOVED: 'b'.repeat(40), STARTED: 'c'.repeat(40), CHECK_TICKS: 4 }))

/*
 * The engine as libtorrent behaves: an add has its layout only from a pump after a tick, and its status a tick after
 * that pump asked for it; one added from a .torrent checks its files over a few ticks and one from a saved state does
 * not; a check runs only while the torrent runs. A check `held` here waits until the test lets it go.
 */
const engine = vi.hoisted(() => ({
  hashes: new Map<number, string>(),
  checks: new Map<number, number>(),
  held: new Set<string>([STARTED]),
  queued: new Set<number>(),
  live: new Set<number>(),
  registered: new Set<number>(),
  asked: new Set<number>(),
  answered: new Set<number>(),
  upload: new Set<number>(),
  paused: new Set<number>(),
  log: [] as string[],
}))

// the saved state's directory, or the restore reads the origin as cleared and drops the state
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }), root: fakeDir('', [fakeDir('cache', [fakeDir(MOVED)])]) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async (importOriginal) => {
  const real = await importOriginal<typeof import('libtorrent-wasm')>()
  const { fakeSession } = await import('../utils/worker-rig')
  const UPLOAD = real.TORRENT_FLAG.uploadMode
  const MiB = 1024 * 1024
  const layout = { storageIndex: 0, pieceLength: MiB, numPieces: 4, totalSize: 4 * MiB, contentSize: 4 * MiB, files: [
    { path: 'film.mkv', offset: 0, size: 4 * MiB, pad: false },
  ] }
  const checking = (h: number) => (engine.checks.get(h) ?? CHECK_TICKS) < CHECK_TICKS
  const tick = () => {
    for (const h of engine.registered) {
      if (checking(h) && !engine.paused.has(h) && !engine.held.has(engine.hashes.get(h)!)) engine.checks.set(h, engine.checks.get(h)! + 1)
    }
    for (const h of engine.asked) if (engine.registered.has(h)) engine.answered.add(h)
    for (const h of engine.queued) engine.live.add(h)
    engine.queued.clear()
  }
  setInterval(tick, 250)
  let next = 0
  const add = (savePath: string, check: boolean) => {
    const h = ++next
    engine.hashes.set(h, savePath.slice(-40))
    if (check) engine.checks.set(h, 0)
    engine.queued.add(h)
    return h
  }
  const at = (h: number) => (checking(h) ? 'mid-check' : 'checked')
  return {
    ...real,
    createSession: async () => fakeSession({
      tick,
      addTorrentFile: (_: unknown, savePath: string) => add(savePath, true),
      addTorrentWithResume: (_: unknown, savePath: string) => add(savePath, false),
      removeTorrent: (h: number) => {
        for (const set of [engine.queued, engine.live, engine.registered, engine.asked, engine.answered, engine.upload, engine.paused]) set.delete(h)
      },
      popAlerts: () => { for (const h of engine.live) engine.registered.add(h); return [] },
      postStatus: (h: number) => { engine.asked.add(h) },
      status: (h: number) => (!engine.answered.has(h) ? null : {
        state: checking(h) ? 1 : 5, paused: engine.paused.has(h), autoManaged: !engine.paused.has(h), errorCode: 0,
        totalDone: 0, downloadRate: 0, numPeers: 0, activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
        progress: checking(h) ? engine.checks.get(h)! / CHECK_TICKS : 1,
      }),
      files: (h: number) => (engine.registered.has(h) ? layout : null),
      setFlags: (h: number, flags: number, mask: number) => {
        if (!(mask & UPLOAD) || engine.upload.has(h) === !!(flags & UPLOAD)) return
        if (flags & UPLOAD) engine.upload.add(h); else engine.upload.delete(h)
        engine.log.push(`${h} upload ${flags & UPLOAD ? 'on' : 'off'}`)
      },
      pauseTorrent: (h: number) => { engine.paused.add(h); engine.log.push(`${h} pause ${at(h)}`) },
      resumeTorrent: (h: number) => { engine.paused.delete(h); engine.log.push(`${h} resume`) },
      saveResumeData: async (h: number) => { engine.log.push(`${h} save`); return new Uint8Array([1]) },
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      prioritizePieces: () => {},
      setDownloadLimit: () => {},
      setUploadLimit: () => {},
    }),
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, usageOfStorage: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  const entry = (hash: string): Persisted => ({
    infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, savePath: `/cache/${hash}`, addedAt: 1, lastUsedAt: 1, started: true, paused: false, ephemeral: true,
  })
  const store = new Map<string, unknown>([
    ['ripple:torrents', [entry(RESTARTED), entry(MOVED), entry(STARTED)]],
    // every one keeps its .torrent; only MOVED has a saved state, so it comes back with no check
    ...[RESTARTED, MOVED, STARTED].map((hash) => [`ripple:torrent:${hash}`, new Uint8Array([1])] as const),
    [`ripple:resume:${MOVED}`, new Uint8Array([1])],
  ])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const handleOf = (hash: string) => Math.max(...[...engine.hashes].filter(([, of]) => of === hash).map(([h]) => h))
const of = (h: number) => engine.log.filter((line) => line.startsWith(`${h} `)).map((line) => line.slice(`${h} `.length))
// a finished torrent's state is saved again once per pause state, so what stays is the rest
const moves = (h: number) => of(h).filter((line) => line !== 'save')
/** What its row read on each report, from the first. */
const rows = (h: number) => rig.of('state').flatMap((m) => {
  const found = (m.torrents as TorrentSnapshot[]).find((t) => t.handle === h)
  return found ? [`${snapshotState(found)} ${Math.round((found.status?.progress ?? 0) * 100)}%`] : []
})
const pumps = (n: number) => new Promise((resolve) => setTimeout(resolve, n * 500 + 100))

it('parks a temporary torrent started again with no saved state once its check is over, and it stays parked', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  const h = handleOf(RESTARTED)

  // THE CONTROL: one with a saved state has no check to wait for, so the first pump with its status parks it
  await vi.waitFor(() => expect(of(handleOf(MOVED)).slice(0, 4)).toEqual(['upload on', 'pause checked', 'upload off', 'save']), { timeout: 3_000 })
  await vi.waitFor(() => expect(rows(h).at(-1)).toBe('completed 100%'), { timeout: 5_000 })
  expect(rows(h).filter((r) => r.startsWith('checking')).length, 'it never read Checking').toBeGreaterThan(0)
  // held while it checked, and not let go before the park's pause
  expect(of(h).slice(0, 4)).toEqual(['upload on', 'pause checked', 'upload off', 'save'])
  await pumps(3)
  expect(moves(h)).toEqual(['upload on', 'pause checked', 'upload off'])
  expect(rows(h).at(-1)).toBe('completed 100%')
}, 15_000)

it('parks a temporary torrent moved into the folder with nobody watching once the check of the folder is over', async () => {
  const before = handleOf(MOVED)
  rig.send({ type: 'relocate', infoHash: MOVED, to: 'folder' })
  await vi.waitFor(() => expect(handleOf(MOVED)).toBeGreaterThan(before))
  const h = handleOf(MOVED)
  await vi.waitFor(() => expect(rows(h).at(-1)).toBe('completed 100%'), { timeout: 5_000 })
  // THE CONTROL: the move added it again from its .torrent, which checked the files at the folder
  expect(rows(h).filter((r) => r.startsWith('checking')).length, 'it never read Checking').toBeGreaterThan(0)
  // a folder's upload mode is its own, so the park leaves it on
  expect(of(h).slice(0, 3)).toEqual(['upload on', 'pause checked', 'save'])
  await pumps(3)
  expect(moves(h)).toEqual(['upload on', 'pause checked'])
  expect(rows(h).at(-1)).toBe('completed 100%')
  expect(engine.upload.has(h)).toBe(true)
}, 15_000)

// the person's Start outranks the park, so the hold its check waited under goes
it('lets one the person started while it checked run, out of upload mode', async () => {
  const h = handleOf(STARTED)
  // THE CONTROL: it is still checking, held, and nothing parked it
  expect(rows(h).at(-1)).toMatch(/^checking /)
  expect(of(h)).toEqual(['upload on'])
  rig.send({ type: 'resume', handle: h })
  await vi.waitFor(() => expect(of(h)).toContain('upload off'), { timeout: 3_000 })
  engine.held.clear()
  await vi.waitFor(() => expect(rows(h).at(-1)).toBe('seeding 100%'), { timeout: 5_000 })
  await pumps(2)
  expect(of(h).filter((line) => /^(pause|upload)/.test(line))).toEqual(['upload on', 'upload off'])
  expect(rows(h).at(-1)).toBe('seeding 100%')
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
}, 15_000)
