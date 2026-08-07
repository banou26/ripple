// Pure planning rules for streaming playback. The engine owns the piece priorities and deadlines
// themselves (libtorrent-wasm's setStreamWindow); what lives here is the geometry Ripple has to
// choose and the rule for when a read counts as a new playhead.

/** One in-flight demuxer read. Must match bufferSize in player/playback.ts. */
export const READ_SIZE = 2_500_000

/** Past this the in-order walk is starved regardless of how few pieces that is. */
export const MAX_WINDOW_BYTES = 8 * 1024 * 1024

export const FALLBACK_WINDOW_PIECES = 12

/**
 * How many pieces at the playhead get top priority and a deadline.
 *
 * The band is picked in SHUFFLED availability order, and the only index-ordered walk in libtorrent
 * explicitly skips top-priority pieces, so everything inside the band arrives at random and
 * everything ahead of it arrives in order. The band therefore wants to be barely wider than one
 * read: big enough that the read the player is blocked on is covered, small enough that the
 * in-order walk still runs.
 *
 * This has to be derived from the piece size, not fixed. A count of 12 is 3 MiB at 256 KiB pieces
 * and 48 MiB at 4 MiB pieces, a 16x spread across sizes that occur in the wild, and at the large end
 * it is the shuffled-band defect all over again.
 */
export const windowPiecesFor = (pieceLength: number): number => {
  if (!Number.isFinite(pieceLength) || pieceLength <= 0) return FALLBACK_WINDOW_PIECES
  // capped in BYTES, never in piece count: what loop 1 drains before the in-order walk resumes is a
  // peer's block quota, so 154 pieces of 16 KiB costs the same as 11 pieces of 256 KiB. A piece
  // count cap here left the band smaller than a single read on small-piece torrents.
  const need = Math.ceil(READ_SIZE / pieceLength) + 1
  const cap = Math.max(2, Math.floor(MAX_WINDOW_BYTES / pieceLength))
  return Math.min(Math.max(need, 2), cap)
}

export const windowBytes = (pieceLength: number): number =>
  windowPiecesFor(pieceLength) * Math.max(0, pieceLength)

/**
 * How far a read has to land from the current plan to count as a seek.
 *
 * Strictly SMALLER than the window, so consecutive deadlined regions overlap and the forward
 * deadlined runway is never zero. A step at or above the window size means the playhead reaches the
 * end of the deadlined region exactly when the next re-plan is due, which leaves a gap with no
 * deadline covering the playhead at the moment it matters most.
 */
export const anchorStep = (pieceLength: number): number =>
  Math.max(1, Math.floor(windowBytes(pieceLength) / 2))

/**
 * Spacing of the deadline ladder. It has to describe real time or libtorrent never sees the window
 * as late and the time-critical rescue never fires.
 */
export const deadlineStepMsFor = (pieceLength: number, bytesPerSecond: number): number =>
  Math.min(2000, Math.max(50, Math.round((pieceLength / Math.max(bytesPerSecond, 250_000)) * 1000)))

/** The watched file's placement inside the torrent, in pieces. */
export type FileSpan = { fileOffset: number, pieceLength: number, p1: number }

/**
 * Whether a read at `offset` should move a viewer's anchor away from `fromOffset`.
 *
 * A read that ENDS in the file's last piece is the demuxer loading its index (matroska cues, a
 * trailing moov), not the playhead moving there. Testing only the start offset lets a 2.5 MB index
 * read at EOF through for every piece size below READ_SIZE, which drags the whole band to the end
 * of the file and strands the header the player is about to need.
 */
export const shouldReanchor = (
  span: FileSpan,
  fromOffset: number,
  offset: number,
  len: number = READ_SIZE,
): boolean => {
  const lastByte = span.fileOffset + offset + Math.max(0, len - 1)
  if (Math.floor(lastByte / span.pieceLength) >= span.p1) return false
  return Math.abs(offset - fromOffset) >= anchorStep(span.pieceLength)
}
