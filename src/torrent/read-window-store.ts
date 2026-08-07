/**
 * The last few reads libav asked for, kept so the next ask is usually already here.
 *
 * libav reads `bufferSize` (2.5 MB) at a time, and on a file whose audio lives in a different region from
 * its video it walks two or three cursors that each advance a few kB per visit. Every visit discarded a
 * full buffer and went back to the engine for another one, so a 139 MB file cost 952 MB of reads for 32 MB
 * of distinct bytes. Holding the last few collapses that: measured over local HTTP, 952.5 MB to 57.6 MB
 * and 5746 ms to 2302 ms, with byte-identical output.
 *
 * One window is exactly ONE read, never more. A wider window looks free over HTTP and is not over a
 * torrent, where a read waits for its pieces: [stream-plan] sizes the deadlined band from one READ_SIZE,
 * so asking the engine for more than that blocks the player on pieces nothing marked urgent, which is the
 * stall the band exists to prevent. Measured at 5 MB it was also simply worse on HTTP anyway (65.1 MB and
 * 2425 ms against 57.6 MB and 2302 ms), because the unused tail of each window is wasted.
 *
 * A hit may return LESS than was asked for. ffmpeg tolerates arbitrary short reads, which libav-wasm's
 * suite proves by producing identical output with every read capped at 4096 bytes, and serving the prefix
 * out of a window is what makes a partial overlap a hit rather than another fetch.
 *
 * Deliberately a plain store rather than a read-through cache: the fetch it would have to close over
 * depends on state that changes on every engine snapshot, and capturing that in a memo is how a cache ends
 * up holding a stale reader.
 */

/** three of them, so a two-region walk keeps both cursors and still has one spare; 7.5 MB total */
export const WINDOW_COUNT = 3

type Held = { start: number, bytes: ArrayBuffer }

export type ReadWindowStore = {
  /** the requested range if any window covers its start, clipped to that window's end, else null */
  get: (offset: number, size: number) => ArrayBuffer | null
  put: (offset: number, bytes: ArrayBuffer) => void
  clear: () => void
  readonly stats: { hits: number, partial: number, misses: number }
}

export const makeReadWindowStore = (
  { windowCount = WINDOW_COUNT }: { windowCount?: number } = {},
): ReadWindowStore => {
  // most-recently-used last, so the shift below evicts the coldest window
  let held: Held[] = []
  const stats = { hits: 0, partial: 0, misses: 0 }

  return {
    stats,
    get: (offset, size) => {
      if (size <= 0) return null
      const found = held.find(w => offset >= w.start && offset < w.start + w.bytes.byteLength)
      if (!found) {
        stats.misses++
        return null
      }
      held.splice(held.indexOf(found), 1)
      held.push(found)
      const from = offset - found.start
      const take = Math.min(size, found.bytes.byteLength - from)
      if (take < size) stats.partial++
      else stats.hits++
      return found.bytes.slice(from, from + take)
    },
    put: (offset, bytes) => {
      if (bytes.byteLength === 0) return
      held.push({ start: offset, bytes })
      while (held.length > windowCount) held.shift()
    },
    clear: () => {
      held = []
      stats.hits = 0
      stats.partial = 0
      stats.misses = 0
    },
  }
}
