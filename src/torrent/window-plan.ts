/**
 * Which part of a watched cache file stays on disk when the file is bigger than the room a fixed
 * browser ceiling leaves it, and what the engine downloads meanwhile. Pure, and decided in chunks of
 * the chunked storage (`chunked-storage.ts`).
 *
 * A file that fits keeps everything, which is the plan every other torrent has. Only a file bigger
 * than the room gets a window: its first chunk (the container header), its last (the index the
 * demuxer reads on seeks), a stretch ahead of the reader, and as much of what it already holds as the
 * room allows, behind the reader or wherever a seek left it.
 */

/** Room for the reader moving between two passes (2), and for a piece across a chunk edge (1). */
export const ALLOWANCE_CHUNKS = 3

/**
 * Wanted past the stretch and held at a trickle, so the torrent always has a missing wanted piece.
 *
 * With none, libtorrent calls `finished()`, drops its seeds and a seek then waits for peers again:
 * 28 to 34 s measured on the local swarm (libtorrent-wasm, 2026-10-19), where the trickle held them
 * and the same seek took 1.5 to 1.9 s. A slack of 8 MiB was filled by requests already in flight and
 * finished anyway.
 *
 * Only ever ahead of the stretch: the sequential walk takes the lowest missing wanted piece first, so
 * a slack behind the reader would download first, at full speed, and leave nothing missing once the
 * rest arrived. So in the last chunks of the file there is none, and the torrent may finish there.
 */
export const SLACK_CHUNKS = 2

/** The least kept ahead of the reader, whatever is held behind it. */
export const RUNWAY_CHUNKS = 16

/** Below this many chunks of room there is no window, and the file is refused as too big. */
export const MIN_WINDOW_CHUNKS = 2 + ALLOWANCE_CHUNKS + SLACK_CHUNKS + RUNWAY_CHUNKS

/** The download limit a full window holds its torrent at, in bytes per second. */
export const TRICKLE_BYTES_PER_SECOND = 16 * 1024

/** `start` inclusive, `end` exclusive. */
export type Range = { start: number, end: number }

/** Where a file sits in its torrent. */
export type FileGeometry = { offset: number, size: number, pieceLength: number }

export type WindowPlan = {
  /** The pieces to download: the first and last chunks, the stretch ahead of the reader and the slack. */
  want: Range[]
  /** The stretch's pieces, which have to be held before the trickle starts. */
  ahead: Range
  /** The slack's pieces, empty near the end of the file. */
  slack: Range
  /** The chunks to keep on disk, ascending. Every other chunk of the file goes. */
  keep: number[]
}

const NONE: Range = { start: 0, end: 0 }

/** The pieces covering bytes `[from, to)` of the file. */
export const piecesOf = (file: FileGeometry, from: number, to: number): Range => {
  const end = Math.min(to, file.size)
  if (end <= from) return NONE
  return {
    start: Math.floor((file.offset + from) / file.pieceLength),
    end: Math.floor((file.offset + end - 1) / file.pieceLength) + 1,
  }
}

export const piecesOfChunk = (file: FileGeometry, chunkBytes: number, chunk: number): Range =>
  piecesOf(file, chunk * chunkBytes, (chunk + 1) * chunkBytes)

/**
 * The chunks the given pieces reach into. Where pieces do not fall on chunk edges (every file of a
 * pack but the first, measured in the stub frame on 2026-10-19 with a 140 byte subtitle ahead of the
 * film), the piece at each end of a range reaches into the chunk beside it, and OPFS charges that
 * chunk whole for its few bytes.
 */
export const chunksReached = (file: FileGeometry, chunkBytes: number, pieces: Iterable<Range>): Set<number> => {
  const out = new Set<number>()
  for (const { start, end } of pieces) {
    const from = Math.max(0, start * file.pieceLength - file.offset)
    const to = Math.min(file.size, end * file.pieceLength - file.offset)
    for (let k = Math.floor(from / chunkBytes); from < to && k <= Math.floor((to - 1) / chunkBytes); k++) out.add(k)
  }
  return out
}

/**
 * The room each watched cache file may take on disk, its own bytes included, out of `pool`: a file
 * that fits in an even share gets its size, and the others split what is left evenly.
 */
export const shareRoom = (sizes: number[], pool: number): number[] => {
  const rooms: number[] = []
  let left = pool
  const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => a.size - b.size)
  order.forEach(({ size, i }, n) => {
    const room = Math.min(size, left / (order.length - n))
    rooms[i] = room
    left -= room
  })
  return rooms
}

/** Whether a file of `size` in `room` plays through a window. */
export const isWindowed = (size: number, room: number, chunkBytes: number): boolean =>
  size > room && Math.floor(room / chunkBytes) >= MIN_WINDOW_CHUNKS

/**
 * The window for one reader, or null when the file gets the whole-file plan.
 *
 * Every chunk held stays while the room allows. The stretch runs from the reader for at least
 * {@link RUNWAY_CHUNKS}, then on over what is held, and over what is missing only while the room
 * has space for it besides everything held. When the room is short, the held chunks farthest from
 * the reader go first, the one ahead on a tie. So reading on, the stretch stops growing once the
 * room is full and the oldest of what was watched goes as the runway moves; after a seek, what was
 * watched stays until the new stretch needs its room.
 *
 * `pinned` is pieces something is reading now (another viewer, a read in flight): their chunks are
 * kept, and counted against the room.
 */
export const planWindow = ({ file, chunkBytes, room, reader, held, pinned = [] }: {
  file: FileGeometry, chunkBytes: number, room: number, reader: number, held: Iterable<number>, pinned?: Range[],
}): WindowPlan | null => {
  if (!isWindowed(file.size, room, chunkBytes)) return null
  const last = Math.ceil(file.size / chunkBytes) - 1
  const r = Math.floor(Math.min(Math.max(reader, 0), file.size - 1) / chunkBytes)
  const budget = Math.floor(room / chunkBytes) - ALLOWANCE_CHUNKS
  const has = new Set(held)
  const head = piecesOf(file, 0, chunkBytes)
  // the slack and the last chunk stay past the stretch
  const aheadRoom = Math.max(0, last - SLACK_CHUNKS - r)
  const shape = (e: number) => {
    if (!aheadRoom) {
      const rest = piecesOf(file, r * chunkBytes, file.size)
      return { want: [head, rest], ahead: rest, slack: NONE }
    }
    const ahead = piecesOf(file, r * chunkBytes, e * chunkBytes)
    const slack = piecesOf(file, e * chunkBytes, (e + SLACK_CHUNKS) * chunkBytes)
    return { want: [head, ahead, slack, piecesOf(file, last * chunkBytes, file.size)], ahead, slack }
  }
  const needs = (e: number) => chunksReached(file, chunkBytes, [...shape(e).want, ...pinned])
  let e = r + Math.min(RUNWAY_CHUNKS, aheadRoom)
  let need = needs(e)
  while (e < r + aheadRoom) {
    const next = needs(e + 1)
    if (next.size > budget) break
    const grows = [...next].some((k) => !need.has(k) && !has.has(k))
    if (grows && new Set([...next, ...has]).size > budget) break
    e++
    need = next
  }
  const keep = new Set([...need, ...has])
  const spare = [...has].filter((k) => !need.has(k)).sort((a, b) => Math.abs(b - r) - Math.abs(a - r) || b - a)
  for (const k of spare) {
    if (keep.size <= budget) break
    keep.delete(k)
  }
  return { ...shape(e), keep: [...keep].sort((a, b) => a - b) }
}

/**
 * Whether to hold a windowed torrent at the trickle: the stretch is held, or the room left above the
 * margin is under a chunk. A full window leaves the allowance free, so the second means the window
 * has run two chunks past its room, and the margin is what the requests in flight then land in.
 */
export const shouldTrickle = (aheadHeld: boolean, roomLeftBytes: number, chunkBytes: number): boolean =>
  aheadHeld || roomLeftBytes < chunkBytes

/** `fixed` is undefined until a chunk of growth has shown which kind of ceiling it is. */
export type Ceiling = { usedBytes: number, headroomBytes: number, fixed?: boolean }

/**
 * Whether the browser's ceiling is fixed: once usage has risen by a chunk, the headroom the platform
 * states (`quota - usage` from `navigator.storage.estimate()` itself) fell by at least half of it.
 *
 * Firefox holds its quota while usage rises, so its headroom falls byte for byte (measured on Firefox
 * 157 in the stub frame, 2026-10-19). Chromium raises its quota by what was written, so its headroom
 * stays about 10 GiB and the file has room however big it is (measured on Chromium 149 in a frame,
 * 2026-10-19). `@banou/ponyfill`'s `estimate()` reports the narrowest quota it has seen, on purpose,
 * which makes both look fixed, so this reads the platform's own figures. Usage is the ponyfill's
 * measured one, since Chromium's own can leave OPFS out.
 */
export const watchCeiling = (
  was: Ceiling | undefined,
  now: { usedBytes: number, headroomBytes: number },
  chunkBytes: number,
): Ceiling => {
  // a first reading, an eviction, or a grant that raised the ceiling: measure from here
  if (!was || now.usedBytes < was.usedBytes || now.headroomBytes > was.headroomBytes) return { ...now, fixed: was?.fixed }
  const rose = now.usedBytes - was.usedBytes
  if (rose < chunkBytes) return was
  return { ...now, fixed: was.headroomBytes - now.headroomBytes >= rose / 2 }
}
