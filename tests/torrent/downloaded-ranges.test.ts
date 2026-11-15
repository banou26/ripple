import { describe, expect, it } from 'vitest'

import { heldShare } from '../../src/torrent/downloaded-ranges'

// pieces of 4 bytes, MSB first: `held(1)` holds the second piece alone
const bitfield = (length: number, ...indices: number[]) => {
  const numPieces = Math.ceil(length / 4)
  const pieces = new Uint8Array(Math.ceil(numPieces / 8))
  for (const p of indices) pieces[p >> 3] = (pieces[p >> 3] ?? 0) | (0x80 >> (p & 7))
  return { pieces, numPieces, pieceLength: 4, length }
}

describe('how much of a file is held', () => {
  // two files of 6 bytes: the second piece is bytes 4 to 8, two of each file's
  it('counts a piece split between two files to each of them, for its own bytes', () => {
    const [first, second] = [{ offset: 0, size: 6 }, { offset: 6, size: 6 }]
    expect([heldShare(bitfield(12, 1), first), heldShare(bitfield(12, 1), second)]).toEqual([2 / 6, 2 / 6])
    expect([heldShare(bitfield(12, 0), first), heldShare(bitfield(12, 0), second)]).toEqual([4 / 6, 0])
    expect([heldShare(bitfield(12, 0, 1, 2), first), heldShare(bitfield(12, 0, 1, 2), second)]).toEqual([1, 1])
  })

  // 10 bytes in pieces of 4, so the last piece is 2 bytes, all of them the second file's
  it('counts a short last piece for the bytes it has, not for a whole piece', () => {
    const second = { offset: 6, size: 4 }
    expect(heldShare(bitfield(10, 2), second)).toBe(0.5)
    expect(heldShare(bitfield(10, 1, 2), second)).toBe(1)
  })

  it('takes an empty file as whole', () => {
    expect(heldShare(bitfield(8), { offset: 4, size: 0 })).toBe(1)
  })
})
