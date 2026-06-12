import type { TorrentSnapshot } from './worker'

// Merged downloaded regions of one file, as [from, to] byte offsets within the
// file, derived from the piece bitfield (MSB-first in both engines).
export const downloadedByteRanges = (
  snapshot: TorrentSnapshot | null,
  fileIndex: number,
): [number, number][] => {
  const bf = snapshot?.bitfield
  const file = snapshot?.files?.files[fileIndex]
  if (!bf || !file || file.size <= 0) return []
  const { pieces, pieceLength, numPieces } = bf
  const p0 = Math.floor(file.offset / pieceLength)
  const p1 = Math.min(Math.floor((file.offset + file.size - 1) / pieceLength), numPieces - 1)
  const has = (p: number) => ((pieces[p >> 3] ?? 0) & (0x80 >> (p & 7))) !== 0
  const ranges: [number, number][] = []
  let start = -1
  for (let p = p0; p <= p1 + 1; p++) {
    if (p <= p1 && has(p)) {
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

// Same regions as fractions of the file size, for the seekbar overlay.
export const downloadedFractions = (
  snapshot: TorrentSnapshot | null,
  fileIndex: number,
): [number, number][] => {
  const file = snapshot?.files?.files[fileIndex]
  if (!file || file.size <= 0) return []
  return downloadedByteRanges(snapshot, fileIndex).map(([from, to]) => [from / file.size, to / file.size])
}
