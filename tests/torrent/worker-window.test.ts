import { describe, expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A cache film bigger than a fixed ceiling plays through a window: the worker plans it, gives back
 * the chunks it no longer keeps in the order a restore can trust, and holds a full window at a
 * trickle.
 *
 * The numbers are the stub frame on Firefox: a fixed 10 GiB, a 25 GiB remux of 16 MiB pieces in
 * 64 MiB chunks. The ceiling is seen to be fixed from two estimates, so the usage moves between them.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const C = 64 * MiB
const PIECE = 16 * MiB
const FILM = 25 * GiB
const FILM_HASH = 'f'.repeat(40)
const OTHER_HASH = '0'.repeat(40)

type Reply = { forgotten: number, busy: number }

const state = vi.hoisted(() => ({
  used: 0,
  held: 0,
  chunks: [] as number[],
  events: [] as (string | number)[][],
  keeps: [] as unknown[],
  limits: [] as number[][],
  saveFails: false,
  // chunks a read brings a piece of back between the first forget and the second
  cameBack: new Set<number>(),
  // chunks with a piece still downloading the first time they are forgotten
  busyOnce: new Set<number>(),
  cancels: [] as number[],
  forgets: new Map<number, number>(),
  bitfield: null as null | { numPieces: number, pieceLength: number, length: number, pieces: Uint8Array },
  // what every estimate waits on, so a test can hold the budget pass off
  gate: Promise.resolve() as Promise<unknown>,
}))

const rig = installWorkerGlobals({ estimate: async () => { await state.gate; return { usage: state.used, quota: 10 * GiB } } })

// no pass can plan anything until the returned function is called, so what changes meanwhile is the
// handler's own doing
const holdPasses = () => {
  let open = () => {}
  state.gate = new Promise<void>((resolve) => { open = resolve })
  return () => { open(); state.gate = Promise.resolve() }
}

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
      cancelPieceRequests: (_h: number, piece: number) => { state.cancels.push(piece) },
      pauseTorrent: () => {},
      resumeTorrent: () => {},
      bitfield: (h: number) => (h === 1 ? state.bitfield : null),
      setDownloadLimit: (h: number, limit: number) => { state.limits.push([h, limit]) },
      saveResumeData: async () => {
        state.events.push(['save'])
        if (state.saveFails) throw new Error('save timed out')
        return new Uint8Array([1])
      },
      // a read of a piece nobody has yet: it waits
      read: () => new Promise(() => {}),
      forgetPieces: (_h: number, pieces: Iterable<number>): Reply => {
        // the engine takes them out of its bitfield at once
        for (const p of pieces) if (state.bitfield) state.bitfield.pieces[p >> 3]! &= ~(0x80 >> (p & 7))
        const chunk = Math.floor([...pieces][0]! * PIECE / C)
        const call = (state.forgets.get(chunk) ?? 0) + 1
        state.forgets.set(chunk, call)
        state.events.push(['forget', chunk])
        const n = state.busyOnce.has(chunk) ? call - 1 : call
        if (n === 0) return { forgotten: 0, busy: 4 }
        // held until the first forget; a piece that came back is held again for the second
        if (n === 2 && state.cameBack.has(chunk)) return { forgotten: 1, busy: 0 }
        return { forgotten: n === 1 ? 4 : 0, busy: 0 }
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
const chunks = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)
const LAST = FILM / C - 1

describe('a cache film bigger than a fixed ceiling', () => {
  it('plays through a window once the ceiling is seen to be fixed', async () => {
    state.held = 2 * C
    state.used = 2 * C + MiB
    state.chunks = [0, 1, 2, 200, 399]
    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH, ephemeral: true })
    await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
    rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })
    await vi.waitFor(() => expect(state.keeps.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 100))
    // THE CONTROL: one estimate says nothing about the ceiling, so the whole film is wanted
    expect(state.keeps.every((keep) => keep === undefined)).toBe(true)
    expect(drops()).toEqual([])

    // a chunk later, the quota has not moved: the ceiling is fixed, and a pass plans the window
    state.used += C
    state.held += C
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + OTHER_HASH })
    await vi.waitFor(() => expect(state.keeps.at(-1)).toBeDefined())
    expect(state.keeps.at(-1)).toContainEqual({ start: 0, end: 4 })
    await vi.waitFor(() => expect(windowed()).toBe(true))
  })

  it('keeps what it holds outside the stretch while the room has space for it', async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(drops()).toEqual([])
  })

  it('forgets, saves, forgets again and only then drops what the window no longer has room for', async () => {
    // more than the room: what was read at the start and a long stretch watched later
    state.chunks = [...chunks(0, 20), ...chunks(200, 340), LAST]
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '4'.repeat(40) })
    // the six farthest from the reader: the room is 10 GiB less the margin and a MiB, so 155 chunks
    // of it can be held, and the stretch wants 21
    await vi.waitFor(() => expect(drops()).toEqual(chunks(334, 340)))
    expect(state.events.filter(([, chunk]) => chunk === undefined || chunk === 339))
      .toEqual([['forget', 339], ['save'], ['forget', 339], ['drop', 339]])
  })

  it('keeps a chunk whose piece came back between the save and the delete', async () => {
    state.events.length = 0
    state.chunks = [...chunks(0, 5), ...chunks(100, 250), LAST]
    state.cameBack.add(2)
    // a seek far forward: the runway there is room the farthest of what is held has to give
    rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 300 * C })
    const gone = [1, 3, 4, ...chunks(100, 115)]
    await vi.waitFor(() => expect(drops()).toEqual(gone))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(drops()).toEqual(gone)
    expect(state.chunks).toContain(2)
  })

  it('deletes nothing when the save does not land', async () => {
    state.events.length = 0
    state.forgets.clear()
    state.cameBack.clear()
    state.saveFails = true
    state.chunks = [0, ...chunks(150, 310), LAST]
    rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 2 * C })
    await vi.waitFor(() => expect(state.events).toContainEqual(['save']))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(state.events.filter(([what]) => what === 'forget').map(([, chunk]) => chunk)).toEqual(chunks(285, 310))
    expect(drops()).toEqual([])
  })

  it('gives them back on a later pass once a save lands', async () => {
    state.saveFails = false
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '2'.repeat(40) })
    await vi.waitFor(() => expect(drops()).toEqual(chunks(285, 310)))
  })

  it('takes back the requests of a chunk still downloading, and drops it once they are gone', async () => {
    state.events.length = 0
    state.chunks = [0, ...chunks(70, 231), LAST]
    state.busyOnce.add(230)
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '3'.repeat(40) })
    await vi.waitFor(() => expect(state.cancels).toEqual([920, 921, 922, 923]))
    expect(drops()).not.toContain(230)
    // with nothing else asking for it, on its own retry
    await vi.waitFor(() => expect(drops()).toEqual(chunks(205, 231)), { timeout: 3_000 })
  })

  it('holds the torrent at a trickle once everything ahead is held, and lets it go when a piece is missing', async () => {
    // nothing held but the ends, so the stretch runs from the reader to the room's end
    state.chunks = [0, LAST]
    rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 2 * C })
    const pieces = new Uint8Array(FILM / PIECE / 8)
    state.bitfield = { numPieces: FILM / PIECE, pieceLength: PIECE, length: FILM, pieces }
    await new Promise((resolve) => setTimeout(resolve, 700))
    // THE CONTROL: nothing held ahead, nothing trickled
    expect(state.limits).toEqual([])
    state.events.length = 0
    pieces.fill(0xff)
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024]]))
    // and the slack, held too, is forgotten so the torrent still has a wanted piece missing
    expect(state.events).toContainEqual(['forget', 153])
    pieces.fill(0, 10, 11)
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024], [1, 0]]))
    expect(rig.of('storage-full')).toEqual([])
  })

  it('lets the trickle go while a read waits for a piece', async () => {
    state.limits.length = 0
    state.bitfield!.pieces.fill(0xff)
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024]]))
    // a piece outside the stretch, read by something that moves no window
    state.bitfield!.pieces.fill(0, 0, 1)
    rig.send({ type: 'read', id: 'r1', handle: 1, fileIndex: 0, offset: 0, len: 1024 })
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024], [1, 0]]))
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(state.limits, 'the trickle came back while the read still waited').toEqual([[1, 16 * 1024], [1, 0]])
    rig.send({ type: 'cancel-read', handle: 1, id: 'r1' })
  })

  it('holds a torrent at the trickle when its own limit is 0, as a restore leaves it', async () => {
    state.limits.length = 0
    rig.send({ type: 'set-limits', handle: 1, down: 0 })
    state.bitfield!.pieces.fill(0xff)
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024]]))
    state.bitfield!.pieces.fill(0, 10, 11)
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024], [1, 0]]))
  })

  it('keeps a limit the viewer set when the trickle lets go', async () => {
    state.limits.length = 0
    rig.send({ type: 'set-limits', handle: 1, down: 1_000_000 })
    state.bitfield!.pieces.fill(0xff)
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024]]))
    state.bitfield!.pieces.fill(0, 10, 11)
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024], [1, 1_000_000]]))
  })

  it('holds the torrent at the trickle when the room above the margin runs under a chunk between passes', async () => {
    state.limits.length = 0
    const held = state.held
    // the cache's own count grows past what the last estimate left free, less the margin
    state.held += 10 * GiB - state.used - 64 * MiB - C / 2
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024]]))
    state.held = held
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024], [1, 1_000_000]]))
  })

  it('lets the trickle go when the viewer leaves', async () => {
    state.limits.length = 0
    state.bitfield!.pieces.fill(0xff)
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024]]))
    rig.send({ type: 'unwatch', viewer: 'player' })
    await vi.waitFor(() => expect(state.limits).toEqual([[1, 16 * 1024], [1, 1_000_000]]))
    await vi.waitFor(() => expect(windowed()).toBe(false))
  })

  it('wants the whole film again once the viewer adds it to the library', async () => {
    rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 2 * C })
    await vi.waitFor(() => expect(windowed()).toBe(true))
    expect(state.keeps.at(-1)).toBeDefined()
    const release = holdPasses()
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + FILM_HASH })
    await vi.waitFor(() => expect(state.keeps.at(-1)).toBeUndefined())
    await vi.waitFor(() => expect(windowed()).toBe(false))
    release()

    // and back in the cache, a pass windows it again
    rig.send({ type: 'set-temporary', infoHash: FILM_HASH, temporary: true })
    rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + '5'.repeat(40) })
    await vi.waitFor(() => expect(windowed()).toBe(true))
  })

  it('wants the whole film again once the viewer keeps it', async () => {
    const release = holdPasses()
    rig.send({ type: 'set-temporary', infoHash: FILM_HASH, temporary: false })
    await vi.waitFor(() => expect(state.keeps.at(-1)).toBeUndefined())
    await vi.waitFor(() => expect(windowed()).toBe(false))
    release()
  })
})
