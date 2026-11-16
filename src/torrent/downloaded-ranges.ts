import type { TorrentSnapshot } from './worker'

type Bitfield = NonNullable<TorrentSnapshot['bitfield']>
type Span = { offset: number, size: number }

// MSB-first in both engines
export const hasPiece = (bf: Bitfield, p: number): boolean => ((bf.pieces[p >> 3] ?? 0) & (0x80 >> (p & 7))) !== 0

const heldRanges = (bf: Bitfield, file: Span): [number, number][] => {
  const { pieceLength, numPieces } = bf
  const p0 = Math.floor(file.offset / pieceLength)
  const p1 = Math.min(Math.floor((file.offset + file.size - 1) / pieceLength), numPieces - 1)
  const ranges: [number, number][] = []
  let start = -1
  for (let p = p0; p <= p1 + 1; p++) {
    if (p <= p1 && hasPiece(bf, p)) {
      if (start === -1) start = p
      continue
    }
    if (start === -1) continue
    const from = Math.max(start * pieceLength - file.offset, 0)
    const to = Math.min(p * pieceLength - file.offset, file.size)
    ranges.push([from, to])
    start = -1
  }
  return ranges
}

export const downloadedByteRanges = (
  snapshot: TorrentSnapshot | null,
  fileIndex: number,
): [number, number][] => {
  const bf = snapshot?.bitfield
  const file = snapshot?.files?.files[fileIndex]
  if (!bf || !file || file.size <= 0) return []
  return heldRanges(bf, file)
}

/** Bytes of a file on disk, counted in whole pieces. */
export const heldBytes = (bf: Bitfield, file: Span): number =>
  heldRanges(bf, file).reduce((sum, [from, to]) => sum + to - from, 0)

/** How much of a file is on disk, from 0 to 1, counted in whole pieces. An empty file has nothing to wait for. */
export const heldShare = (bf: Bitfield, file: Span): number =>
  file.size > 0 ? heldBytes(bf, file) / file.size : 1

export const downloadedFractions = (
  snapshot: TorrentSnapshot | null,
  fileIndex: number,
): [number, number][] => {
  const file = snapshot?.files?.files[fileIndex]
  if (!file || file.size <= 0) return []
  return downloadedByteRanges(snapshot, fileIndex).map(([from, to]) => [from / file.size, to / file.size])
}
