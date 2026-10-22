import { describe, expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A cache film playing through a window in a frame, handed to Ripple's own tab: the engine answers
 * with a fresh blob and the chunks it holds, and keeps every one of them until the handover ends.
 * The rig is `worker-window.test.ts`'s: a fixed 10 GiB, a 25 GiB film of 16 MiB pieces.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const C = 64 * MiB
const PIECE = 16 * MiB
const FILM = 25 * GiB
const FILM_HASH = 'f'.repeat(40)
const MAGNET = 'magnet:?xt=urn:btih:' + FILM_HASH
const LAST = FILM / C - 1

const state = vi.hoisted(() => ({
  used: 0,
  held: 0,
  chunks: [] as number[],
  events: [] as (string | number)[][],
  keeps: [] as unknown[],
  forgot: new Set<number>(),
  bitfield: null as null | { numPieces: number, pieceLength: number, length: number, pieces: Uint8Array },
}))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: state.used, quota: 10 * GiB }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      files: (h: number) => h === 1
        ? { storageIndex: 0, pieceLength: PIECE, numPieces: FILM / PIECE, totalSize: FILM, contentSize: FILM, files: [{ path: 'remux.mkv', offset: 0, size: FILM, pad: false }] }
        : { storageIndex: 1, pieceLength: PIECE, numPieces: 1, totalSize: PIECE, contentSize: PIECE, files: [{ path: 'small.mkv', offset: 0, size: PIECE, pad: false }] },
      setStreamWindow: (h: number, _claims: unknown, opts: { keep?: unknown }) => { if (h === 1) state.keeps.push(opts.keep); return true },
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
      pauseTorrent: () => {},
      resumeTorrent: () => {},
      bitfield: (h: number) => (h === 1 ? state.bitfield : null),
      setDownloadLimit: () => {},
      saveResumeData: async () => { state.events.push(['save']); return new Uint8Array([7, 7]) },
      read: () => new Promise(() => {}),
      // held until the first forget, and nothing comes back before the second
      forgetPieces: (_h: number, pieces: Iterable<number>) => {
        const chunk = Math.floor([...pieces][0]! * PIECE / C)
        state.events.push(['forget', chunk])
        const first = !state.forgot.has(chunk)
        state.forgot.add(chunk)
        return { forgotten: first ? 4 : 0, busy: 0 }
      },
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({
    usageOf: async (savePath: string) => (savePath.endsWith(FILM_HASH) ? state.held : 0),
    refusedFile: () => undefined,
  }),
}))
vi.mock('../../src/torrent/chunked-storage', () => ({
  CHUNK_BYTES: 64 * 1024 * 1024,
  createChunkedStorage: () => ({
    chunkBytesOf: () => 64 * 1024 * 1024,
    chunksOf: () => [...state.chunks],
    footprint: () => state.held,
    drop: async (_savePath: string, _fileIndex: number, chunk: number) => {
      state.events.push(['drop', chunk])
      state.chunks = state.chunks.filter((c) => c !== chunk)
    },
    readChunk: async (_savePath: string, fileIndex: number, chunk: number) => new Uint8Array([fileIndex, chunk]),
  }),
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

const windowed = () => {
  const states = rig.of('state')
  const last = states[states.length - 1]?.torrents as { handle: number, windowed: boolean }[] | undefined
  return last?.find((t) => t.handle === 1)?.windowed
}
const drops = () => state.events.filter(([what]) => what === 'drop').map(([, chunk]) => chunk)
const forgets = () => state.events.filter(([what]) => what === 'forget').map(([, chunk]) => chunk)
const chunks = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)
const answer = (id: number) => rig.of('answer').find((m) => m.id === id)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// commands run one after another, but a chunk read jumps the line: this waits out the ones sent before
let asked = 100
const settled = async () => {
  const id = ++asked
  rig.send({ type: 'export-start', id, infoHash: 'e'.repeat(40) })
  await vi.waitFor(() => expect(answer(id)).toBeDefined())
}

describe('a windowed cache film handed to Ripple\'s own tab', () => {
  it('plays through a window', async () => {
    state.held = 3 * C
    state.used = 3 * C + MiB
    state.chunks = [0, 1, 2]
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
    rig.send({ type: 'add-magnet', magnet: MAGNET, ephemeral: true })
    await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
    rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })
    await vi.waitFor(() => expect(state.keeps.length).toBeGreaterThan(0))
    // a second estimate with the quota where it was: the ceiling is fixed
    state.used += C
    state.held += C
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '0'.repeat(40) })
    await vi.waitFor(() => expect(windowed()).toBe(true))
  })

  it('answers with a fresh blob, the magnet and every chunk it holds', async () => {
    state.chunks = [...chunks(0, 20), ...chunks(200, 340), LAST]
    rig.send({ type: 'export-start', id: 1, infoHash: FILM_HASH })
    await vi.waitFor(() => expect(answer(1)).toBeDefined())
    expect(answer(1)!.value).toEqual({
      magnet: MAGNET,
      resume: new Uint8Array([7, 7]),
      chunkBytes: C,
      chunks: state.chunks.map((chunk) => ({ fileIndex: 0, chunk })),
    })
    rig.send({ type: 'export-chunk', id: 2, infoHash: FILM_HASH, fileIndex: 0, chunk: 201 })
    await vi.waitFor(() => expect(answer(2)?.value).toEqual(new Uint8Array([0, 201])))
  })

  it('drops nothing outside the window while it is handed over, and gives it back after', async () => {
    state.events.length = 0
    // a pass that, without the handover, gives back the six chunks farthest from the reader
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '4'.repeat(40) })
    await sleep(1_500)
    expect(drops(), 'a chunk the tab was offered was deleted').toEqual([])
    expect(forgets()).toEqual([])
    rig.send({ type: 'export-end', infoHash: FILM_HASH })
    await vi.waitFor(() => expect(drops()).toEqual(chunks(334, 340)), { timeout: 3_000 })
  })

  it('forgets no slack while it is handed over, and does again after', async () => {
    state.chunks = [0, LAST]
    rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 2 * C })
    await vi.waitFor(() => expect(state.keeps.at(-1)).toBeDefined())
    rig.send({ type: 'export-start', id: 3, infoHash: FILM_HASH })
    await vi.waitFor(() => expect(answer(3)).toBeDefined())
    state.events.length = 0
    state.bitfield = { numPieces: FILM / PIECE, pieceLength: PIECE, length: FILM, pieces: new Uint8Array(FILM / PIECE / 8).fill(0xff) }
    await sleep(1_200)
    expect(forgets(), 'a held piece was forgotten under the tab').toEqual([])
    rig.send({ type: 'export-end', infoHash: FILM_HASH })
    await vi.waitFor(() => expect(forgets()).toContain(153))
  })

  it('answers nothing for a torrent it cannot hand over, and refuses a chunk it was not asked to start', async () => {
    rig.send({ type: 'export-start', id: 4, infoHash: 'e'.repeat(40) })
    await vi.waitFor(() => expect(answer(4)).toBeDefined())
    expect(answer(4)!.value).toBeNull()
    // a library torrent in `/dl`, kept as whole files rather than chunks
    rig.send({ type: 'export-start', id: 6, infoHash: '0'.repeat(40) })
    await vi.waitFor(() => expect(answer(6)).toBeDefined())
    expect(answer(6)!.value).toBeNull()
    rig.send({ type: 'export-chunk', id: 5, infoHash: FILM_HASH, fileIndex: 0, chunk: 0 })
    await vi.waitFor(() => expect(answer(5)?.error).toMatch(/not being handed over/))
  })

  it('hands it over until the last of two tabs taking it is done', async () => {
    rig.send({ type: 'export-start', id: 7, infoHash: FILM_HASH })
    rig.send({ type: 'export-start', id: 8, infoHash: FILM_HASH })
    await vi.waitFor(() => expect(answer(8)).toBeDefined())
    rig.send({ type: 'export-end', infoHash: FILM_HASH })
    await settled()
    rig.send({ type: 'export-chunk', id: 9, infoHash: FILM_HASH, fileIndex: 0, chunk: 0 })
    await vi.waitFor(() => expect(answer(9)).toBeDefined())
    expect(answer(9)!.value, 'the first tab to finish cut the second short').toEqual(new Uint8Array([0, 0]))
    rig.send({ type: 'export-end', infoHash: FILM_HASH })
    await settled()
    rig.send({ type: 'export-chunk', id: 10, infoHash: FILM_HASH, fileIndex: 0, chunk: 0 })
    await vi.waitFor(() => expect(answer(10)?.error).toMatch(/not being handed over/))
  })

  it('gives the chunks back once a handover nobody ends has gone 30 s without a read', async () => {
    rig.send({ type: 'export-start', id: 11, infoHash: FILM_HASH })
    await vi.waitFor(() => expect(answer(11)).toBeDefined())
    state.events.length = 0
    await sleep(1_200)
    expect(forgets()).toEqual([])
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 31_000)
      await vi.waitFor(() => expect(forgets(), 'the handover never lapsed').toContain(153), { timeout: 3_000 })
    } finally {
      vi.useRealTimers()
    }
  })
})
