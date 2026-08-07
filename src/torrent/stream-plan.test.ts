import { describe, expect, it } from 'vitest'

import {
  MAX_WINDOW_PIECES,
  MIN_WINDOW_PIECES,
  WINDOW_BYTES,
  anchorJump,
  shouldReanchor,
  windowPieces,
} from './stream-plan'

// every piece size a real torrent plausibly uses, plus the absurd ends
const PIECE_SIZES = [16_384, 131_072, 262_144, 524_288, 1 << 20, 2 << 20, 4 << 20, 8 << 20, 16 << 20]

describe('windowPieces', () => {
  it('always covers more than one anchor step, so the playhead never outruns the deadlines', () => {
    for (const pieceLength of PIECE_SIZES) {
      expect(windowPieces(pieceLength) * pieceLength).toBeGreaterThan(anchorJump(pieceLength))
    }
  })

  it('stays inside its bounds for absurd piece sizes', () => {
    expect(windowPieces(1)).toBe(MAX_WINDOW_PIECES)
    expect(windowPieces(1 << 30)).toBe(MIN_WINDOW_PIECES)
    expect(windowPieces(0)).toBe(MIN_WINDOW_PIECES)
    expect(windowPieces(Number.NaN)).toBe(MIN_WINDOW_PIECES)
  })

  it('scales with piece size rather than with file size', () => {
    expect(windowPieces(WINDOW_BYTES / 20)).toBe(20)
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
