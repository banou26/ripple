// Pure planning rules for streaming playback. The engine owns the piece priorities and deadlines
// themselves (libtorrent-wasm's setStreamWindow); what lives here is the two numbers Ripple has to
// choose and the rule for when a read counts as a new playhead.

/**
 * How many pieces at the playhead are marked top priority and given a deadline.
 *
 * This has to stay SMALL, and the reason is the opposite of the intuitive one. libtorrent's
 * sequential picker has two loops. The first drains top-priority pieces in shuffled,
 * availability-bucketed order. The second walks pieces in index order from the cursor and
 * explicitly SKIPS top-priority ones. The second loop is the only in-order path there is, and it
 * runs only if the first left the peer's request quota unfilled (piece_picker.cpp:2153).
 *
 * So a wide top-priority band starves the in-order walk and gets picked at random. It is not the
 * window that feeds playback, it is the in-order walk; the window is only a boost for what is
 * needed right now. Measured on a 1054-piece file: a 128-piece window held 29 pieces with a
 * contiguous run of 1, and finished 45 seconds with 1019 of 1054 pieces but a run of only 70.
 */
export const WINDOW_PIECES = 12

/**
 * A read this far from the current plan counts as a seek rather than as drift.
 *
 * Roughly one window ahead, so the deadlined head stays near the playhead, with a floor so small
 * pieces do not force a re-plan every fraction of a second. Each re-plan empties the time-critical
 * set, and refilling it re-posts a cancel of every outstanding non-critical block request.
 */
export const MIN_ANCHOR_JUMP = 4_194_304

export const anchorJump = (pieceLength: number): number => {
  const window = Number.isFinite(pieceLength) && pieceLength > 0 ? WINDOW_PIECES * pieceLength : 0
  return Math.max(MIN_ANCHOR_JUMP, window)
}

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
