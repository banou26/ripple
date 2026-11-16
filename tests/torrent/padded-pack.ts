import type { TorrentSnapshot } from '../../src/torrent/client'

/**
 * A hybrid torrent of 16 KiB pieces as ripple makes one, the one measured on the built page with E02 left out: each
 * file but the last is followed by the zeroes that push the next onto a piece boundary, so the pads after E01, E03 and
 * the subtitle, 43 064 bytes, sit inside the chosen pieces. The engine then reported 344 064 wanted and 301 000 done.
 */
const PIECE = 16_384
const LAYOUT: [string, number, boolean?][] = [
  ['Pack/E01.mkv', 200_000], ['.pad/12992', 12_992, true],
  ['Pack/E02.mkv', 150_000], ['.pad/13840', 13_840, true],
  ['Pack/E03.mkv', 100_000], ['.pad/14688', 14_688, true],
  ['Pack/Subs/E01.srt', 1_000], ['.pad/15384', 15_384, true],
  ['Pack/empty', 0],
]
const offsets = LAYOUT.map((_, i) => LAYOUT.slice(0, i).reduce((sum, [, size]) => sum + size, 0))
const TOTAL = offsets.at(-1)! + LAYOUT.at(-1)![1]
const PIECES = Math.ceil(TOTAL / PIECE)

/** E01, E03, the subtitle and the empty file: everything but E02, by the engine's index. */
export const CHOSEN = [0, 4, 6, 8]
/** The pieces E02 alone covers. */
export const E02_PIECES = Array.from({ length: 10 }, (_, i) => 13 + i)
/** E03's last piece, which holds its last 1 696 bytes and then its pad. */
export const E03_LAST_PIECE = 29

export const paddedPack = (status: object, missing: number[]): TorrentSnapshot => {
  const pieces = new Uint8Array(Math.ceil(PIECES / 8))
  for (let p = 0; p < PIECES; p++) if (!missing.includes(p)) pieces[p >> 3] = (pieces[p >> 3] ?? 0) | (0x80 >> (p & 7))
  return {
    handle: 1,
    magnet: 'magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd&dn=Pack',
    files: {
      storageIndex: 0, pieceLength: PIECE, numPieces: PIECES, totalSize: TOTAL, contentSize: 451_000,
      files: LAYOUT.map(([path, size, pad], i) => ({ path, size, offset: offsets[i]!, pad: pad === true })),
    },
    status: { paused: false, downloadRate: 0, ...status },
    bitfield: { pieces, numPieces: PIECES, pieceLength: PIECE, length: TOTAL },
    recovery: null,
    userPaused: false,
    displayDownloadRate: 0,
  } as unknown as TorrentSnapshot
}
