import { describe, expect, it } from 'vitest'

import {
  MAX_WINDOW_BYTES,
  READ_SIZE,
  anchorStep,
  deadlineStepMsFor,
  shouldReanchor,
  windowBytes,
  windowPiecesFor,
} from '../../src/torrent/stream-plan'

// every piece size a real torrent plausibly uses, plus the absurd ends
const PIECE_SIZES = [16_384, 131_072, 262_144, 524_288, 1 << 20, 2 << 20, 4 << 20, 8 << 20, 16 << 20]

describe('windowPiecesFor', () => {
  it('covers a whole demuxer read at every piece size', () => {
    // the read the player is blocked on has to be inside the deadlined band, or nothing is urgent
    for (const pieceLength of PIECE_SIZES) {
      if (windowBytes(pieceLength) >= MAX_WINDOW_BYTES) continue
      expect(windowBytes(pieceLength)).toBeGreaterThanOrEqual(READ_SIZE)
    }
  })

  it('never lets the shuffled band grow past the cap', () => {
    // the band is picked in random order and the in-order walk skips it, so its SIZE is the cost
    for (const pieceLength of PIECE_SIZES) {
      expect(windowBytes(pieceLength)).toBeLessThanOrEqual(Math.max(MAX_WINDOW_BYTES, pieceLength * 2))
    }
  })

  it('shrinks the piece count as pieces grow, instead of holding it fixed', () => {
    // a fixed count of 12 is 3 MiB at 256 KiB and 48 MiB at 4 MiB: the same defect at the top end
    expect(windowPiecesFor(262_144)).toBeGreaterThan(windowPiecesFor(1 << 20))
    expect(windowPiecesFor(1 << 20)).toBeGreaterThan(windowPiecesFor(4 << 20))
    expect(windowPiecesFor(4 << 20)).toBeGreaterThanOrEqual(2)
  })

  it('survives a missing or nonsense piece length', () => {
    expect(windowPiecesFor(0)).toBeGreaterThan(0)
    expect(windowPiecesFor(Number.NaN)).toBeGreaterThan(0)
    expect(windowPiecesFor(-1)).toBeGreaterThan(0)
  })
})

describe('anchorStep', () => {
  it('is strictly smaller than the window at every piece size', () => {
    // consecutive deadlined regions must OVERLAP. A step at or above the window size means the
    // playhead reaches the end of the deadlined region exactly as the next re-plan comes due, so
    // forward deadlined runway hits zero at the worst possible moment.
    for (const pieceLength of PIECE_SIZES) {
      expect(anchorStep(pieceLength)).toBeLessThan(windowBytes(pieceLength))
    }
  })
})

describe('deadlineStepMsFor', () => {
  it('describes real time, so the engine can see the window running late', () => {
    // one 2 MiB piece at 4 MB/s is half a second
    expect(deadlineStepMsFor(2 << 20, 4_000_000)).toBe(524)
  })

  it('clamps rather than trusting a wild rate', () => {
    expect(deadlineStepMsFor(1 << 20, 0)).toBeLessThanOrEqual(2000)
    expect(deadlineStepMsFor(1 << 20, 1e12)).toBeGreaterThanOrEqual(50)
  })
})

describe('shouldReanchor', () => {
  // one 2 MiB-piece file, second in the torrent, spanning pieces 100..1099
  const pieceLength = 2 << 20
  const span = { fileOffset: 100 * pieceLength, pieceLength, p1: 1099 }
  const fileSize = 1000 * pieceLength

  it('ignores the demuxer reading the index off the end of the file', () => {
    // the shape that used to drag the window to the tail and strand the header
    expect(shouldReanchor(span, 0, fileSize - READ_SIZE, READ_SIZE)).toBe(false)
    expect(shouldReanchor(span, 0, fileSize - 1, 1)).toBe(false)
  })

  it('catches a tail read whose START is not yet in the last piece', () => {
    // a 2.5 MB read starting just before the final piece still ENDS inside it, and testing only
    // the start offset let exactly that through for every piece size below the read size
    const startsBeforeLastPiece = (span.p1 - 100) * pieceLength - 1024
    expect(shouldReanchor(span, 0, startsBeforeLastPiece, READ_SIZE)).toBe(false)
  })

  it('re-anchors on a real seek', () => {
    expect(shouldReanchor(span, 0, 400 * pieceLength, READ_SIZE)).toBe(true)
    expect(shouldReanchor(span, 400 * pieceLength, 0, READ_SIZE)).toBe(true)
  })

  it('holds still for playback drifting forward inside the window', () => {
    const step = anchorStep(pieceLength)
    expect(shouldReanchor(span, 0, step - 1, READ_SIZE)).toBe(false)
    expect(shouldReanchor(span, 0, step, READ_SIZE)).toBe(true)
  })
})
