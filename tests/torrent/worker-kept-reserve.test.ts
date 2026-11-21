import type { Admit } from '../../src/torrent/opfs-storage'

import { expect, it, vi } from 'vitest'

import { RESERVE_BYTES } from '../../src/torrent/storage-budget'
import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * The room downloads the person keeps leave for a temporary film (RIPPLE-185), on a room Firefox holds fixed at
 * 10 GiB. The storages ask the engine before a write grows what browser storage is charged; this drives that question
 * the way their writes do, with the browser's own refusal past the real limit.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const LIMIT = 10 * GiB
const STEP = 512 * MiB
const KEPT_HASH = 'a'.repeat(40)
const FILM_HASH = 'f'.repeat(40)

const state = vi.hoisted(() => ({
  used: 0, floating: false, reads: 0, held: 0, refused: undefined as number | undefined, admit: undefined as Admit | undefined,
  // the next estimate reads the usage, then answers only once this settles
  slow: null as Promise<void> | null,
}))

// Chromium's floats 10 GiB above whatever is held
const quota = () => (state.floating ? state.used + 10 * 1024 * 1024 * 1024 : 10 * 1024 * 1024 * 1024)
const rig = installWorkerGlobals({
  estimate: async () => {
    state.reads++
    const usage = state.used
    const slow = state.slow
    state.slow = null
    if (slow) await slow
    return { usage, quota: quota() }
  },
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  const MiB = 1024 * 1024
  const GiB = 1024 * MiB
  const layout = (storageIndex: number, size: number) =>
    ({ storageIndex, pieceLength: 16 * MiB, numPieces: size / (16 * MiB), totalSize: size, contentSize: size, files: [{ path: 'film.mkv', offset: 0, size, pad: false }] })
  return {
    createSession: async () => fakeSession({
      // the person's own download is handle 1, the temporary film handle 2
      files: (h: number) => (h === 1 ? layout(1, 4 * GiB) : h === 2 ? layout(2, 3 * GiB) : null),
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
      pauseTorrent: () => {},
      resumeTorrent: () => {},
      setDownloadLimit: () => {},
      saveResumeData: async () => new Uint8Array([1]),
      forgetPieces: () => ({ forgotten: 0, busy: 0 }),
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1, paused: 16, autoManaged: 32 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({
    usageOf: async () => 0,
    usageOfStorage: async (id: number) => (id === 1 ? state.held : 0),
    refusedFile: (id: number) => (id === 1 ? state.refused : undefined),
  }),
}))
vi.mock('../../src/torrent/chunked-storage', () => ({
  createChunkedStorage: (_chunkBytes: number, admit: Admit) => {
    state.admit = admit
    return { chunkBytesOf: () => 64 * 1024 * 1024, chunksOf: () => [], footprint: () => 0, drop: async () => {} }
  },
}))
vi.mock('idb-keyval', () => {
  // a session before saw the ceiling hold, as Firefox's does
  const store = new Map<string, unknown>([['ripple:ceiling-fixed', true]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

// a write as it lands: the engine is asked first, then the browser refuses what is past its limit
const grow = (id: number, bytes: number) => {
  if (!state.admit!(id, bytes) || state.used + bytes > quota()) return false
  state.used += bytes
  return true
}

// an add starts a pass, and each is a torrent of its own, since adding one again does not
let adds = 0
const pass = async () => {
  const before = state.reads
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + String(++adds).padStart(40, '0') })
  await vi.waitFor(() => expect(state.reads).toBeGreaterThanOrEqual(before + 2))
  await new Promise((resolve) => setTimeout(resolve, 300))
}

const windowed = () => (rig.of('state').at(-1)?.torrents as { handle: number, windowed: boolean }[] | undefined)
  ?.find((t) => t.handle === 2)?.windowed

const full = () => rig.of('storage-full').at(-1)?.full ?? false

const ephemeral = (handle: number) => (rig.of('state').at(-1)?.torrents as { handle: number, ephemeral: boolean }[] | undefined)
  ?.find((t) => t.handle === handle)?.ephemeral

it('stops a download the person keeps short of the reserve, and a temporary film then plays through its window', async () => {
  // room for seven steps past the reserve
  state.used = LIMIT - RESERVE_BYTES - 7 * STEP
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + KEPT_HASH })
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH, ephemeral: true })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2))
  await pass()

  let admitted = 0
  for (let step = 0; step < 20 && grow(1, STEP); step++) admitted++
  expect(admitted).toBe(7)
  expect(LIMIT - state.used).toBe(RESERVE_BYTES)

  rig.send({ type: 'watch', viewer: 'player', handle: 2, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(windowed()).toBe(true), { timeout: 5_000 })
  expect(full(), 'the film was called too big').toBe(false)

  // the film's own writes are never refused, whatever the person's downloads have left
  expect(grow(2, STEP)).toBe(true)
  expect(grow(1, 1)).toBe(false)
  rig.send({ type: 'unwatch', viewer: 'player' })
})

// Ripple's own player on the person's download while the film plays: the 3 GiB that download is short of will never be
// written past the reserve, so it is no room the film has to leave
it('keeps the film its window while a download the person keeps, stopped at the reserve, is watched too', async () => {
  state.used = LIMIT - RESERVE_BYTES
  state.held = GiB
  rig.send({ type: 'watch', viewer: 'library-player', handle: 1, fileIndex: 0, fromOffset: 0 })
  await pass()
  await vi.waitFor(() => expect(windowed()).toBe(false), { timeout: 5_000 })

  rig.send({ type: 'watch', viewer: 'player', handle: 2, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(windowed()).toBe(true), { timeout: 5_000 })
  expect(full(), 'the film was called too big').toBe(false)

  // a library already two chunks into the reserve leaves the film 22, too few for a window
  state.used = LIMIT - RESERVE_BYTES + 2 * 64 * MiB
  await pass()
  await vi.waitFor(() => expect(windowed()).toBe(false), { timeout: 5_000 })
  rig.send({ type: 'unwatch', viewer: 'player' })
  rig.send({ type: 'unwatch', viewer: 'library-player' })
})

it('says a download the person keeps is out of storage space when the reserve refuses it', async () => {
  // 2 GiB free, and the download page's file owes 1 GiB of its 4
  state.used = LIMIT - 2 * GiB
  state.held = 3 * GiB
  rig.send({ type: 'watch', viewer: 'page', handle: 1, fileIndex: 0, fromOffset: 0, held: true })
  await pass()
  expect(full(), 'THE CONTROL: nothing was refused').toBe(false)

  state.refused = 0
  await pass()
  expect(full()).toBe('kept')

  // the person removed a download: the room is back, and so is the line
  state.used = LIMIT - 4 * GiB
  await pass()
  expect(full()).toBe(false)
  rig.send({ type: 'unwatch', viewer: 'page' })
  state.refused = undefined
})

it('counts a write that lands while the browser is being asked, which the figure it gives may not hold', async () => {
  state.used = LIMIT - 5 * GiB
  await pass()
  let answer = () => {}
  state.slow = new Promise<void>((resolve) => { answer = resolve })
  const before = state.reads
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + 'b'.repeat(40) })
  await vi.waitFor(() => expect(state.reads).toBeGreaterThan(before))
  expect(grow(1, GiB)).toBe(true)
  answer()
  await vi.waitFor(() => expect(state.reads).toBeGreaterThanOrEqual(before + 2))
  await new Promise((resolve) => setTimeout(resolve, 300))
  // the pass measured 5 GiB free, the gigabyte written meanwhile not among it
  const left = 5 * GiB - RESERVE_BYTES - GiB
  expect(grow(1, left + 1)).toBe(false)
  expect(grow(1, left)).toBe(true)
})

// Stub's frame shares this engine, and drops its film on a full origin: only a player of the person's own torrent stops
it('tells a temporary film playing in the reserve that only the person\'s own downloads are out of room', async () => {
  state.used = LIMIT - RESERVE_BYTES
  state.held = GiB
  rig.send({ type: 'watch', viewer: 'page', handle: 1, fileIndex: 0, fromOffset: 0, held: true })
  rig.send({ type: 'watch', viewer: 'player', handle: 2, fileIndex: 0, fromOffset: 0 })
  await pass()
  await vi.waitFor(() => expect(windowed()).toBe(true), { timeout: 5_000 })
  expect(full(), 'THE CONTROL: nothing was refused').toBe(false)

  expect(grow(1, 64 * MiB)).toBe(false)
  state.refused = 0
  await pass()
  expect(windowed()).toBe(true)
  expect(full()).toBe('kept')
  expect([ephemeral(1), ephemeral(2)]).toEqual([false, true])
  rig.send({ type: 'unwatch', viewer: 'player' })
  rig.send({ type: 'unwatch', viewer: 'page' })
  state.refused = undefined
  await pass()
})

// Chromium states 10 GiB above whatever is written and takes it all, so a 40 GiB extent was accepted (Chromium 149,
// 2026-10-19): only the browser refuses there, once a filling disk makes the ceiling read as fixed
it('leaves a ceiling that floats to the browser', async () => {
  state.floating = true
  await pass()
  expect(grow(2, 128 * MiB)).toBe(true)
  await pass()
  expect(grow(1, 8 * GiB)).toBe(true)
})
