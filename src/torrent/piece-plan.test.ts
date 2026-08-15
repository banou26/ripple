import { describe, expect, it } from 'vitest'

import { PRIORITY } from 'libtorrent-wasm'

import { DEFAULT_WINDOW_BYTES, piecePlan, planIsDefault } from './piece-plan'

/**
 * The priority map for a torrent nobody is watching.
 *
 * libtorrent's map is written whole, so the two settings that shape it have to be expressed in one
 * pass: a pass that knows about the file selection and not about first-and-last-first silently
 * undoes the other. That is also why this exists at all. `clearStreamWindow` fills every piece with
 * normal, and it runs for any torrent with no viewers, including on restore, so a selection that
 * lives only in libtorrent's head is gone after a reload.
 *
 * The case worth staring at is the boundary piece. A piece straddling a wanted file and a skipped
 * one has to be fetched, because there is no way to ask for half a piece, and refusing it would
 * stall the file somebody actually asked for.
 */

const PIECE = 1000
// three files, one per 10 pieces, laid out end to end
const files = [
  { offset: 0, size: 10_000 },
  { offset: 10_000, size: 10_000 },
  { offset: 20_000, size: 10_000 },
]
const base = { files, pieceLength: PIECE, numPieces: 30 }

const counts = (map: Uint8Array) => {
  const out: Record<number, number> = {}
  for (const value of map) out[value] = (out[value] ?? 0) + 1
  return out
}

describe('with nothing chosen at all', () => {
  it('is the ordinary map, every piece normal', () => {
    const map = piecePlan(base)
    expect(map).toHaveLength(30)
    expect(counts(map)).toEqual({ [PRIORITY.normal]: 30 })
  })

  it('says so, so the engine need not be told', () => {
    expect(planIsDefault({})).toBe(true)
    expect(planIsDefault({ wanted: [0] })).toBe(false)
    expect(planIsDefault({ firstLast: true })).toBe(false)
  })

  /**
   * An empty selection is NOT the same as no selection, and conflating them is the dangerous
   * direction: `undefined` means "everything", `[]` means "nothing", and answering "everything" for
   * `[]` downloads a torrent the person deselected entirely.
   */
  it('treats no selection and an empty selection as different things', () => {
    expect(counts(piecePlan({ ...base, wanted: undefined }))).toEqual({ [PRIORITY.normal]: 30 })
    expect(counts(piecePlan({ ...base, wanted: [] }))).toEqual({ [PRIORITY.skip]: 30 })
  })
})

describe('honouring a file selection', () => {
  it('skips the pieces of files nobody asked for', () => {
    const map = piecePlan({ ...base, wanted: [1] })
    expect(map.slice(0, 10).every((p) => p === PRIORITY.skip)).toBe(true)
    expect(map.slice(10, 20).every((p) => p === PRIORITY.normal)).toBe(true)
    expect(map.slice(20).every((p) => p === PRIORITY.skip)).toBe(true)
  })

  /** the one that stalls a download if it is got wrong */
  it('keeps a piece that straddles a wanted file and a skipped one', () => {
    // a wanted file starting halfway through piece 5, so piece 5 belongs to both
    const straddling = [{ offset: 0, size: 5_500 }, { offset: 5_500, size: 4_500 }]
    const map = piecePlan({ files: straddling, pieceLength: PIECE, numPieces: 10, wanted: [1] })
    expect(map[5]).toBe(PRIORITY.normal)
    expect(map[4]).toBe(PRIORITY.skip)
    expect(map[6]).toBe(PRIORITY.normal)
  })

  it('ignores a zero length file, which covers no piece of its own', () => {
    const withEmpty = [{ offset: 0, size: 0 }, { offset: 0, size: 10_000 }]
    const map = piecePlan({ files: withEmpty, pieceLength: PIECE, numPieces: 10, wanted: [0] })
    expect(counts(map)).toEqual({ [PRIORITY.skip]: 10 })
  })

  it('ignores an index naming a file that is not there', () => {
    expect(counts(piecePlan({ ...base, wanted: [0, 99] }))).toEqual({ [PRIORITY.normal]: 10, [PRIORITY.skip]: 20 })
  })
})

describe('first and last pieces first', () => {
  it('tops the head and the tail of each file and leaves the middle alone', () => {
    // a 2000 byte window over 1000 byte pieces is two pieces at each end
    const map = piecePlan({ ...base, firstLast: true, windowBytes: 2000 })
    for (const start of [0, 10, 20]) {
      expect(map[start], `head of the file at ${start}`).toBe(PRIORITY.top)
      expect(map[start + 1]).toBe(PRIORITY.top)
      expect(map[start + 5], 'the middle').toBe(PRIORITY.normal)
      expect(map[start + 8]).toBe(PRIORITY.top)
      expect(map[start + 9], `tail of the file at ${start}`).toBe(PRIORITY.top)
    }
  })

  it('never lifts a file nobody asked for', () => {
    const map = piecePlan({ ...base, wanted: [1], firstLast: true, windowBytes: 2000 })
    expect(map.slice(0, 10).every((p) => p === PRIORITY.skip)).toBe(true)
    expect(map[10]).toBe(PRIORITY.top)
    expect(map[19]).toBe(PRIORITY.top)
    expect(map[15]).toBe(PRIORITY.normal)
    expect(map.slice(20).every((p) => p === PRIORITY.skip)).toBe(true)
  })

  it('copes with a file smaller than the window, without running off either end', () => {
    const tiny = [{ offset: 0, size: 900 }]
    const map = piecePlan({ files: tiny, pieceLength: PIECE, numPieces: 1, firstLast: true })
    expect([...map]).toEqual([PRIORITY.top])
  })

  it('never writes outside the map, whatever the window', () => {
    for (const windowBytes of [1, 1000, DEFAULT_WINDOW_BYTES, 1e9]) {
      const map = piecePlan({ ...base, firstLast: true, windowBytes })
      expect(map).toHaveLength(30)
      expect([...map].every((p) => p >= 0 && p <= PRIORITY.top)).toBe(true)
    }
  })

  it('tops every piece of a file the window swallows whole', () => {
    const map = piecePlan({ ...base, firstLast: true, windowBytes: 1e9 })
    expect(counts(map)).toEqual({ [PRIORITY.top]: 30 })
  })

  it('uses at least one piece per end even for a window smaller than a piece', () => {
    const map = piecePlan({ ...base, firstLast: true, windowBytes: 1 })
    expect(map[0]).toBe(PRIORITY.top)
    expect(map[9]).toBe(PRIORITY.top)
    expect(map[5]).toBe(PRIORITY.normal)
  })
})
