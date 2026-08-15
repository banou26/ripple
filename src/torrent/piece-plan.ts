import { PRIORITY } from 'libtorrent-wasm'

/**
 * The piece priorities a torrent should be sitting at when nobody is watching it.
 *
 * Two settings land here and they have to be expressed together, because libtorrent's priority map
 * is written whole. `Session.prioritizePieces` replaces every entry, so a pass that knows about the
 * file selection but not about first-and-last-first silently undoes the other one.
 *
 * That is also the bug this file exists to fix. `applyViewing` calls `clearStreamWindow` for any
 * torrent with no viewers, and that fills the map with `PRIORITY.normal`, so a restore turned "just
 * this one subtitle" back into the whole torrent on the next reload, with nothing on screen to say
 * so. The selection has to be re-applied from something that survives a reload, which means storing
 * it and rebuilding the map here rather than trusting whatever was written last session.
 *
 * No engine and no DOM, so the arithmetic can be tested against awkward layouts directly.
 */

export type PlanFile = { offset: number, size: number }

export type PiecePlan = {
  files: PlanFile[]
  pieceLength: number
  numPieces: number
  /** File indices to download. `undefined` means all of them, which is not the same as all listed. */
  wanted?: number[]
  /** Fetch the head and tail of each wanted file ahead of the middle. */
  firstLast?: boolean
  /** How much of each end counts as the head and the tail. */
  windowBytes?: number
}

/**
 * Enough to carry a container header at one end and an index at the other.
 *
 * Matroska puts its Cues at the tail and MP4 can put its whole moov there, so a window that only
 * covers a header buys nothing for the format most likely to need it.
 */
export const DEFAULT_WINDOW_BYTES = 4 * 1024 * 1024

const pieceRange = (file: PlanFile, pieceLength: number, numPieces: number): [number, number] => [
  Math.max(0, Math.floor(file.offset / pieceLength)),
  Math.min(numPieces - 1, Math.floor((file.offset + Math.max(0, file.size - 1)) / pieceLength)),
]

export const piecePlan = (
  { files, pieceLength, numPieces, wanted, firstLast, windowBytes = DEFAULT_WINDOW_BYTES }: PiecePlan,
): Uint8Array => {
  const all = wanted === undefined
  const want = new Set(wanted ?? [])
  const isWanted = (index: number) => all || want.has(index)

  // Start from skip only when there is a selection to honour. With no selection the answer is the
  // ordinary map, and starting from skip would mean every piece covered by no file at all (a torrent
  // whose layout has not been read yet) came back as "want none of this", which stops the torrent.
  const prios = new Uint8Array(numPieces).fill(all ? PRIORITY.normal : PRIORITY.skip)

  if (!all) {
    // Written AFTER the skip fill, so a piece straddling a wanted file and a skipped one keeps the
    // wanted value. Skipping it would refuse bytes the wanted file needs, and there is no way to ask
    // for half a piece.
    for (const [index, file] of files.entries()) {
      if (!isWanted(index) || file.size <= 0) continue
      const [p0, p1] = pieceRange(file, pieceLength, numPieces)
      for (let p = p0; p <= p1; p++) prios[p] = PRIORITY.normal
    }
  }

  if (firstLast) {
    const span = Math.max(1, Math.ceil(windowBytes / pieceLength))
    for (const [index, file] of files.entries()) {
      if (!isWanted(index) || file.size <= 0) continue
      const [p0, p1] = pieceRange(file, pieceLength, numPieces)
      for (let k = 0; k < span; k++) {
        const head = p0 + k
        const tail = p1 - k
        if (head <= p1) prios[head] = PRIORITY.top
        if (tail >= p0) prios[tail] = PRIORITY.top
      }
    }
  }

  return prios
}

/** Is this plan the same as doing nothing, so the engine need not be told? */
export const planIsDefault = ({ wanted, firstLast }: Pick<PiecePlan, 'wanted' | 'firstLast'>): boolean =>
  wanted === undefined && !firstLast
