import { describe, expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A window plans around one reader, and the rest of what reads the torrent keeps its bytes: another
 * viewer's chunk and a read in flight are never dropped or have their requests taken back, and the
 * room is shared with every other file being watched.
 *
 * The ceiling is known to be fixed from an earlier session, so the first pass windows without the
 * usage having to move. Numbers as in `worker-window.test.ts`: a fixed 10 GiB, 25 GiB films of
 * 16 MiB pieces in 64 MiB chunks.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const C = 64 * MiB
const PIECE = 16 * MiB
const FILM = 25 * GiB
const LAST = FILM / C - 1
const PACK = 'a'.repeat(40)
const A = 'b'.repeat(40)
const LIBRARY = 'c'.repeat(40)
const B = 'd'.repeat(40)

const state = vi.hoisted(() => ({
  chunks: new Map<string, number[]>(),
  keeps: new Map<number, unknown[]>(),
  events: [] as (string | number)[][],
  cancels: [] as number[],
  forgets: new Map<string, number>(),
  // the engine's handles, to the torrent each was added for
  hashes: new Map<number, string>(),
  // what a resume save waits on before it lands
  saving: Promise.resolve() as Promise<unknown>,
  // whether the pack's every piece is held, which is what lets a prepare beside its film go ahead
  packHeld: false,
  claims: new Map<number, { fileIndex: number }[]>(),
}))

// what every chunk held costs, and a MiB besides
const usage = () => [...state.chunks.values()].reduce((sum, held) => sum + held.length * C, MiB)
const rig = installWorkerGlobals({ estimate: async () => ({ usage: usage(), quota: 10 * GiB }) })

const one = (path: string, size: number) =>
  ({ storageIndex: 0, pieceLength: PIECE, numPieces: Math.ceil(size / PIECE), totalSize: size, contentSize: size, files: [{ path, offset: 0, size, pad: false }] })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      addMagnet: (magnet: string) => { const h = state.hashes.size + 1; state.hashes.set(h, magnet.slice(-40)); return h },
      // a pack of a film and a short extra, a library download, and films; the rest have no layout
      files: (h: number) => {
        const hash = state.hashes.get(h)
        if (hash === 'a'.repeat(40)) return { storageIndex: 0, pieceLength: PIECE, numPieces: (FILM + 4 * PIECE) / PIECE, totalSize: FILM + 4 * PIECE, contentSize: FILM + 4 * PIECE, files: [{ path: 'p/film.mkv', offset: 0, size: FILM, pad: false }, { path: 'p/extra.mkv', offset: FILM, size: 4 * PIECE, pad: false }] }
        if (hash === 'c'.repeat(40)) return one('library.mkv', 3 * GiB)
        return hash === 'b'.repeat(40) || hash === 'd'.repeat(40) ? one('film.mkv', FILM) : null
      },
      bitfield: (h: number) => state.packHeld && state.hashes.get(h) === 'a'.repeat(40) ? { pieces: new Uint8Array(256).fill(255) } : null,
      setStreamWindow: (h: number, claims: unknown, opts: { keep?: unknown }) => {
        state.keeps.set(h, [...state.keeps.get(h) ?? [], opts.keep])
        state.claims.set(h, claims as { fileIndex: number }[])
        return true
      },
      clearStreamWindow: () => {},
      cancelPieceRequests: (_h: number, piece: number) => { state.cancels.push(piece) },
      pauseTorrent: () => {},
      resumeTorrent: () => {},
      setDownloadLimit: () => {},
      saveResumeData: async () => { await state.saving; return new Uint8Array([1]) },
      // a read of a piece nobody has yet: it waits
      read: () => new Promise(() => {}),
      forgetPieces: (h: number, pieces: Iterable<number>) => {
        const chunk = Math.floor([...pieces][0]! * PIECE / C)
        const key = `${h}/${chunk}`
        const call = (state.forgets.get(key) ?? 0) + 1
        state.forgets.set(key, call)
        state.events.push(['forget', h, chunk])
        return { forgotten: call === 1 ? 4 : 0, busy: 0 }
      },
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({
    usageOf: async (savePath: string) => (state.chunks.get(savePath.slice(-40))?.length ?? 0) * C,
    refusedFile: () => undefined,
  }),
}))
vi.mock('../../src/torrent/chunked-storage', () => ({
  CHUNK_BYTES: 64 * 1024 * 1024,
  createChunkedStorage: () => ({
    chunkBytesOf: () => 64 * 1024 * 1024,
    chunksOf: (savePath: string, fileIndex: number) => (fileIndex === 0 ? [...state.chunks.get(savePath.slice(-40)) ?? []] : []),
    footprint: () => 0,
    drop: async (savePath: string, _fileIndex: number, chunk: number) => {
      const hash = savePath.slice(-40)
      state.events.push(['drop', chunk])
      state.chunks.set(hash, (state.chunks.get(hash) ?? []).filter((c) => c !== chunk))
    },
  }),
}))
vi.mock('idb-keyval', () => {
  // what an earlier session saw of the ceiling
  const store = new Map<string, unknown>([['ripple:ceiling-fixed', true]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const chunks = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)
const drops = () => state.events.filter(([what]) => what === 'drop').map(([, chunk]) => chunk)
const forgotten = (h: number) => state.events.filter(([what, of]) => what === 'forget' && of === h).map(([, , chunk]) => chunk)
const lastKeep = (h: number) => state.keeps.get(h)?.at(-1) as { start: number, end: number }[] | undefined
// the stretch the window wants ahead of the reader, in pieces
const stretch = (h: number) => { const keep = lastKeep(h)!; return keep[1]!.end - keep[1]!.start }
const pass = (n: number) => rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + String(n).repeat(40) })
const add = async (hash: string, ephemeral: boolean): Promise<number> => {
  const before = rig.of('added').length
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + hash, ephemeral })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(before + 1))
  return rig.of('added').at(-1)!.handle as number
}
let pack = 0
let a = 0
let b = 0
let library = 0

describe('a window and everything else reading', () => {
  it('gives players on two files of one torrent the whole-file plan', async () => {
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
    pack = await add(PACK, true)
    rig.send({ type: 'watch', viewer: 'p1', handle: pack, fileIndex: 0, fromOffset: 0 })
    rig.send({ type: 'watch', viewer: 'p2', handle: pack, fileIndex: 1, fromOffset: 0 })
    pass(1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(state.keeps.get(pack)?.length).toBeGreaterThan(1)
    expect(state.keeps.get(pack)!.every((keep) => keep === undefined)).toBe(true)
    // THE CONTROL: the same film watched alone windows
    rig.send({ type: 'unwatch', viewer: 'p2' })
    await vi.waitFor(() => expect(lastKeep(pack)).toBeDefined())
    rig.send({ type: 'unwatch', viewer: 'p1' })
  })

  it('plans the window on the first pass, from the ceiling an earlier session saw', async () => {
    state.chunks.set(A, [0, LAST])
    a = await add(A, true)
    rig.send({ type: 'watch', viewer: 'a', handle: a, fileIndex: 0, fromOffset: 0 })
    await vi.waitFor(() => expect(lastKeep(a)).toBeDefined())
    expect(lastKeep(a)).toContainEqual({ start: 0, end: 4 })
  })

  it('keeps the chunk another viewer is reading, and takes back none of its requests', async () => {
    // 159 chunks, four more than the room's 155, so the farthest from the first viewer go
    state.chunks.set(A, [...chunks(0, 20), ...chunks(200, 338), LAST])
    rig.send({ type: 'watch', viewer: 'b', handle: a, fileIndex: 0, fromOffset: 336 * C })
    // the four farthest from the first viewer, less the one the second is reading
    await vi.waitFor(() => expect(drops()).toEqual([333, 334, 335, 337]))
    expect(forgotten(a)).not.toContain(336)
    expect(state.cancels).toEqual([])
  })

  it('keeps the chunk a read in flight is waiting on', async () => {
    state.events.length = 0
    state.chunks.set(A, [...chunks(0, 20), ...chunks(200, 338), LAST])
    rig.send({ type: 'read', id: 7, handle: a, fileIndex: 0, offset: 333 * C + 5 * MiB, len: MiB })
    pass(2)
    await vi.waitFor(() => expect(drops()).toEqual([332, 334, 335, 337]))
    rig.send({ type: 'cancel-read', handle: a, id: 7 })
  })

  it('keeps a chunk a read starts on while the drop is saving', async () => {
    state.events.length = 0
    state.chunks.set(A, [...chunks(0, 20), ...chunks(200, 338), LAST])
    let land = () => {}
    state.saving = new Promise<void>((resolve) => { land = resolve })
    pass(6)
    await vi.waitFor(() => expect(forgotten(a)).toEqual([333, 334, 335, 337]))
    rig.send({ type: 'read', id: 8, handle: a, fileIndex: 0, offset: 334 * C, len: MiB })
    land()
    await vi.waitFor(() => expect(drops()).toEqual([333, 335, 337]))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(drops()).toEqual([333, 335, 337])
    rig.send({ type: 'cancel-read', handle: a, id: 8 })
    rig.send({ type: 'unwatch', viewer: 'b' })
  })

  it('leaves the room a library download being watched still has to fill', async () => {
    state.chunks.set(A, [0, LAST])
    pass(3)
    // 10 GiB less the margin and the MiB is 158 chunks: three are the allowance, and the head, the
    // slack and the last chunk take three more
    await vi.waitFor(() => expect(stretch(a)).toBe((158 - 6) * 4))
    library = await add(LIBRARY, false)
    rig.send({ type: 'watch', viewer: 'l', handle: library, fileIndex: 0, fromOffset: 0 })
    pass(4)
    // three GiB it owes is 48 chunks
    await vi.waitFor(() => expect(stretch(a)).toBe((158 - 48 - 6) * 4))
    rig.send({ type: 'unwatch', viewer: 'l' })
  })

  it('shares the room with another film being watched', async () => {
    state.chunks.set(B, [0, LAST])
    b = await add(B, true)
    rig.send({ type: 'watch', viewer: 'bb', handle: b, fileIndex: 0, fromOffset: 0 })
    pass(5)
    // half of 10 GiB less the margin and the MiB each: 79 chunks
    await vi.waitFor(() => expect(stretch(a)).toBe((79 - 6) * 4))
    await vi.waitFor(() => expect(stretch(b)).toBe((79 - 6) * 4))
  })

  // a prepared file wants its head and tail, a few MiB the margin covers, never its size
  it('takes none of the room for a file only prepared', async () => {
    rig.send({ type: 'watch', viewer: 'next', handle: library, fileIndex: 0, fromOffset: 0, prepare: true })
    pass(7)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(stretch(a)).toBe((79 - 6) * 4)
    // THE CONTROL: the same file watched owes its size
    rig.send({ type: 'watch', viewer: 'l', handle: library, fileIndex: 0, fromOffset: 0 })
    pass(8)
    await vi.waitFor(() => expect(stretch(a)).not.toBe((79 - 6) * 4))
    rig.send({ type: 'unwatch', viewer: 'l' })
    rig.send({ type: 'unwatch', viewer: 'next' })
  })

  it('leaves a film its window beside the next file of its torrent being prepared', async () => {
    rig.send({ type: 'unwatch', viewer: 'a' })
    rig.send({ type: 'unwatch', viewer: 'bb' })
    state.packHeld = true
    rig.send({ type: 'watch', viewer: 'p1', handle: pack, fileIndex: 0, fromOffset: 0 })
    rig.send({ type: 'watch', viewer: 'next', handle: pack, fileIndex: 1, fromOffset: 0, prepare: true })
    pass(9)
    await vi.waitFor(() => expect(state.claims.get(pack)?.map(claim => claim.fileIndex)).toEqual([0, 0, 1, 1]))
    expect(lastKeep(pack)).toContainEqual({ start: 0, end: 4 })
    rig.send({ type: 'unwatch', viewer: 'p1' })
    rig.send({ type: 'unwatch', viewer: 'next' })
  })
})
