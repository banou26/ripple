// Pure planning rules for streaming playback. The engine owns the piece priorities and deadlines
// themselves (libtorrent-wasm's setStreamWindow); what lives here is the two numbers Ripple has to
// choose and the rule for when a read counts as a new playhead.

// How much of the file ahead of the playhead is deadlined. The bounds are there to keep the
// time-critical set a sane size on very small or very large pieces, not to express a policy.
export const WINDOW_BYTES = 33_554_432
export const MIN_WINDOW_PIECES = 12
export const MAX_WINDOW_PIECES = 128

/** How many pieces at the playhead get top priority and a deadline, for a given piece size. */
export const windowPieces = (pieceLength: number): number => {
  if (!Number.isFinite(pieceLength) || pieceLength <= 0) return MIN_WINDOW_PIECES
  return Math.min(MAX_WINDOW_PIECES, Math.max(MIN_WINDOW_PIECES, Math.ceil(WINDOW_BYTES / pieceLength)))
}

/**
 * How far a read has to land from the current plan before it counts as a seek.
 *
 * Derived from the window rather than fixed, because the two have to stay related: priorities are
 * only re-planned once a read lands this far away, so a step wider than the window would leave the
 * playhead past every deadline until the next jump. Half a window always overlaps.
 */
export const anchorJump = (pieceLength: number): number =>
  Math.max(1, Math.floor((windowPieces(pieceLength) * pieceLength) / 2))

/** The watched file's placement inside the torrent, in pieces. */
export type FileSpan = { fileOffset: number, pieceLength: number, p1: number }

/**
 * Whether a read at `offset` should move a viewer's anchor away from `fromOffset`.
 *
 * A read of the last piece of the file is the demuxer loading its index (matroska cues, a trailing
 * moov), not the playhead moving there. read() deadlines it either way, while re-planning on it
 * would drag the whole window to the end of the file and demote the header playback is about to
 * need. That is what left the first stretch of a file downloading with holes at the header.
 */
export const shouldReanchor = (span: FileSpan, fromOffset: number, offset: number): boolean => {
  if (Math.floor((span.fileOffset + offset) / span.pieceLength) >= span.p1) return false
  return Math.abs(offset - fromOffset) >= anchorJump(span.pieceLength)
}
