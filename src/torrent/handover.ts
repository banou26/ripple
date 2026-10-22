import type { Bencode } from './torrent-file'

import { decode, isPad } from './torrent-file'

/**
 * What the embedded player hands Ripple's own tab when "Open this torrent in Ripple" is pressed.
 *
 * Inside another site's page the player keeps its data in a storage partition Ripple's own tab
 * cannot see, so the tab, opened with the player as its opener, asks for the torrent and the player
 * sends its chunk files over `postMessage`. Every message is checked for the sender's window and
 * origin on both sides.
 *
 * The tab trusts none of the bytes: each piece is hashed against the torrent's own v1 hash as it
 * lands, and only the pieces that pass are claimed in the resume blob the torrent is added with,
 * which libtorrent then believes without a check of its own.
 */

/** Tab to player: `{ type, infoHash }`. */
export const TAKE = 'ripple:take'
/** Player to tab: `{ type, infoHash, offer }`, `offer` null when there is nothing to give. */
export const GIVE = 'ripple:give'
/** Player to tab: `{ type, fileIndex, chunk, bytes }`, one chunk file, its buffer transferred. */
export const CHUNK = 'ripple:chunk'
/** Tab to player, one per chunk written: the player keeps at most {@link CREDIT} unanswered. */
export const ACK = 'ripple:ack'
/** Player to tab: no more chunks are coming. */
export const DONE = 'ripple:done'
/** Tab to player: send nothing more. */
export const STOP = 'ripple:stop'

export const CREDIT = 2

/** One chunk file of a cache torrent, `<fileIndex>-<chunk>` under its size directory. */
export type Chunk = { fileIndex: number, chunk: number }

/** What the player's engine has of a torrent: its resume blob and the chunk files holding bytes. */
export type Offer = { magnet: string, resume: Uint8Array, chunkBytes: number, chunks: Chunk[] }

export type Layout = {
  pieceLength: number
  /** The v1 `pieces`, 20 bytes per piece. */
  hashes: Uint8Array
  /** In libtorrent's own order and numbering, pads included. */
  files: { offset: number, size: number, pad: boolean }[]
}

/** The piece geometry and hashes of an info dictionary, or null for one with no v1 hashes to check. */
export const layoutOf = (info: Uint8Array): Layout | null => {
  try {
    const [dict] = decode(info, 0)
    if (!(dict instanceof Map)) return null
    const pieceLength = dict.get('piece length')
    const hashes = dict.get('pieces')
    if (typeof pieceLength !== 'number' || pieceLength <= 0 || !(hashes instanceof Uint8Array) || hashes.length % 20) return null
    const list = dict.get('files')
    const entries: Bencode[] = Array.isArray(list) ? list : [new Map([['length', dict.get('length') ?? -1]])]
    const files: Layout['files'] = []
    let offset = 0
    for (const entry of entries) {
      const size = entry instanceof Map ? entry.get('length') : undefined
      if (!(entry instanceof Map) || typeof size !== 'number' || size < 0) return null
      files.push({ offset, size, pad: isPad(entry) })
      offset += size
    }
    return Math.ceil(offset / pieceLength) === hashes.length / 20 ? { pieceLength, hashes, files } : null
  } catch {
    return null
  }
}

/** Whether a chunk names bytes of a real file of this torrent. */
export const fits = (layout: Layout, chunkBytes: number, { fileIndex, chunk }: Chunk): boolean => {
  const file = Number.isInteger(fileIndex) ? layout.files[fileIndex] : undefined
  return !!file && !file.pad && Number.isInteger(chunk) && chunk >= 0 && chunk * chunkBytes < file.size
}

/** Reads `len` bytes at `at` of one chunk file; a shorter answer reads as zeros past its end. */
export type ReadChunk = (chunk: Chunk, at: number, len: number) => Promise<Uint8Array<ArrayBuffer>>

/**
 * Hash every piece a chunk holds a byte of, once it lands. `have` is one byte per piece, 1 for a piece
 * whose bytes match the torrent's hash: a piece that runs into a chunk not here yet reads zeros there
 * and fails, until that chunk lands and it is hashed again.
 */
export const createPieceCheck = (layout: Layout, chunkBytes: number, read: ReadChunk) => {
  const { pieceLength, hashes, files } = layout
  const last = files[files.length - 1]
  const total = last ? last.offset + last.size : 0
  const have = new Uint8Array(hashes.length / 20)

  // the first file ending after `offset`, so a piece walks only the files it touches
  const fileAfter = (offset: number) => {
    let lo = 0
    let hi = files.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const file = files[mid]
      if (file && file.offset + file.size > offset) hi = mid; else lo = mid + 1
    }
    return lo
  }

  // where each stretch of a piece lives, a pad's being zeros that live nowhere
  const stretches = (start: number, end: number) => {
    const out: (Chunk & { at: number, into: number, len: number })[] = []
    for (let fileIndex = fileAfter(start); fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex]
      if (!file || file.offset >= end) break
      if (file.pad) continue
      const to = Math.min(end, file.offset + file.size) - file.offset
      for (let at = Math.max(start, file.offset) - file.offset; at < to;) {
        const chunk = Math.floor(at / chunkBytes)
        const until = Math.min(to, (chunk + 1) * chunkBytes)
        out.push({ fileIndex, chunk, at: at - chunk * chunkBytes, into: file.offset + at - start, len: until - at })
        at = until
      }
    }
    return out
  }

  const verify = async (piece: number) => {
    const start = piece * pieceLength
    const length = Math.min(pieceLength, total - start)
    const out = stretches(start, start + length)
    const parts = await Promise.all(out.map((s) => read(s, s.at, s.len)))
    // one stretch read whole is hashed where it lies, which is every piece inside one chunk
    const [only] = parts
    const whole = !!only && out.length === 1 && only.length >= length
    const bytes = whole ? only.subarray(0, length) : new Uint8Array(length)
    if (!whole) out.forEach((s, i) => bytes.set(parts[i]?.subarray(0, s.len) ?? [], s.into))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))
    const want = hashes.subarray(piece * 20, piece * 20 + 20)
    have[piece] = digest.every((byte, i) => byte === want[i]) ? 1 : 0
  }

  return {
    have,
    /** Call once the chunk's bytes can be read back through `read`. */
    add: async (chunk: Chunk) => {
      const file = files[chunk.fileIndex]
      if (!file || !fits(layout, chunkBytes, chunk)) return
      const from = Math.floor((file.offset + chunk.chunk * chunkBytes) / pieceLength)
      const to = Math.floor((file.offset + Math.min(file.size, (chunk.chunk + 1) * chunkBytes) - 1) / pieceLength)
      await Promise.all(Array.from({ length: to - from + 1 }, (_, i) => verify(from + i)))
    },
  }
}

const encoder = new TextEncoder()

const joined = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

const entry = (key: string, value: Uint8Array) => joined([encoder.encode(`${key.length}:${key}`), value])

/**
 * The player's resume blob with `pieces` claiming exactly what passed, unpaused, and without the
 * partial pieces it was midway through, whose blocks nothing has checked. Every other key goes back
 * byte for byte, the info dictionary included, so the infohash cannot move.
 */
export const resumeWith = (resume: Uint8Array, have: Uint8Array): Uint8Array => {
  const entries = new Map<string, Uint8Array>()
  let was: Uint8Array | undefined
  for (let at = 1; at < resume.length && resume[at] !== 0x65;) {
    const [name, afterKey] = decode(resume, at)
    const [value, afterValue] = decode(resume, afterKey)
    const key = new TextDecoder().decode(name as Uint8Array)
    if (key === 'pieces' && value instanceof Uint8Array) was = value
    entries.set(key, resume.subarray(at, afterValue))
    at = afterValue
  }
  const pieces = have.map((ok, p) => (ok ? (was?.[p] ?? 0) | 1 : 0))
  entries.delete('unfinished')
  entries.set('paused', entry('paused', encoder.encode('i0e')))
  entries.set('pieces', entry('pieces', joined([encoder.encode(`${pieces.length}:`), pieces])))
  // the keys are ASCII, so this is the byte order bencode wants
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, value]) => value)
  return joined([encoder.encode('d'), ...sorted, encoder.encode('e')])
}
