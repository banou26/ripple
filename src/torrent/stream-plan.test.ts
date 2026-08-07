import { describe, expect, it } from 'vitest'

import {
  MIN_ANCHOR_JUMP,
  WINDOW_PIECES,
  anchorJump,
  shouldReanchor,
} from './stream-plan'

// every piece size a real torrent plausibly uses, plus the absurd ends
const PIECE_SIZES = [16_384, 131_072, 262_144, 524_288, 1 << 20, 2 << 20, 4 << 20, 8 << 20, 16 << 20]

describe('WINDOW_PIECES', () => {
  it('stays small enough to leave libtorrent its in-order walk', () => {
    // a peer's request quota is filled from the top-priority loop first, and the in-order loop runs
    // only on what is left. A window in the hundreds starves it and the file arrives shuffled.
    expect(WINDOW_PIECES).toBeLessThanOrEqual(24)
    expect(WINDOW_PIECES).toBeGreaterThan(0)
  })

  it('is a piece count, not a byte budget, so it does not grow on small pieces', () => {
    // the loop-starving property depends on the COUNT of top-priority pieces, not their size
    expect(Number.isInteger(WINDOW_PIECES)).toBe(true)
  })
})

describe('anchorJump', () => {
  it('never re-plans more often than the floor, whatever the piece size', () => {
    for (const pieceLength of PIECE_SIZES) {
      expect(anchorJump(pieceLength)).toBeGreaterThanOrEqual(MIN_ANCHOR_JUMP)
    }
  })

  it('keeps the deadlined head near the playhead on large pieces', () => {
    // once a window is wider than the floor, the step follows the window rather than the floor
    expect(anchorJump(8 << 20)).toBe(WINDOW_PIECES * (8 << 20))
  })

  it('survives a missing or nonsense piece length', () => {
    expect(anchorJump(0)).toBe(MIN_ANCHOR_JUMP)
    expect(anchorJump(Number.NaN)).toBe(MIN_ANCHOR_JUMP)
    expect(anchorJump(-1)).toBe(MIN_ANCHOR_JUMP)
  })
})

describe('shouldReanchor', () => {
  // one 2 MiB-piece file, second in the torrent, spanning pieces 100..1099
  const pieceLength = 2 << 20
  const span = { fileOffset: 100 * pieceLength, pieceLength, p1: 1099 }
  const fileSize = 1000 * pieceLength

  it('ignores the demuxer reading the index off the end of the file', () => {
    // the exact shape that used to drag the window to the tail and demote the header
    expect(shouldReanchor(span, 0, fileSize - 64 * 1024)).toBe(false)
    expect(shouldReanchor(span, 0, fileSize - 1)).toBe(false)
  })

  it('re-anchors on a real seek', () => {
    expect(shouldReanchor(span, 0, 400 * pieceLength)).toBe(true)
    expect(shouldReanchor(span, 400 * pieceLength, 0)).toBe(true)
  })

  it('holds still for playback drifting forward inside the window', () => {
    const step = anchorJump(pieceLength)
    expect(shouldReanchor(span, 0, step - 1)).toBe(false)
    expect(shouldReanchor(span, 0, step)).toBe(true)
  })

  it('treats the last piece as tail even when the seek is otherwise large', () => {
    const atTail = (span.p1 - 100) * pieceLength
    expect(shouldReanchor(span, 0, atTail)).toBe(false)
  })
})
