import type { Torrent, TorrentFile } from './types'

import { encodeMagnetParam } from '../router/magnet-codec'
import { getRoutePath, Route } from '../router/path'
import { contentFiles } from './types'

const VIDEO_RE = /\.(mp4|mkv|webm|avi|mov|m4v|ts|flv|wmv|mpg|mpeg|ogv)$/i

/**
 * Should a Watch link be offered for this file list?
 *
 * True when something matches, and ALSO true when the list is not known yet, which is a magnet
 * whose metadata has not arrived: "not known" is not "no video", and the swarm settles it later.
 *
 * Deliberately a different question from `hasPlayableFile` below, which answers for a torrent
 * already in the library and is FALSE while metadata is missing. A row must not offer Watch on
 * files it does not have; a link builder must not withhold the option on a magnet it cannot see
 * inside yet. Same regex, opposite treatment of "unknown", so they are two names on purpose.
 */
export const canOfferWatch = (files?: readonly { name: string }[]): boolean =>
  !files || files.some((file) => VIDEO_RE.test(file.name))

// The array index IS the engine's file index (order preserved)
// only `name`, `size` and `pad` are read, so anything carrying those qualifies: the share dialog
// builds its file list from a .torrent in the page and never has a TorrentFile
/**
 * A PAD can never be the answer, and the fallback is where it could win.
 *
 * The first loop is safe on its own: a pad is named `.pad/65536` and matches no video extension. The
 * second is the one that bit, because it takes the LARGEST file and a pad is a file. So a torrent of
 * many small files whose names say nothing about video handed back a pad, and the three callers that
 * pass the UNFILTERED list (`watchHref`, and the row's own Save at home.tsx:1758 and :2400) then
 * offered to play or save it: zeroes, under whatever name the row was showing.
 *
 * Skipped rather than filtered out, because the returned number is an index into the caller's own
 * list and renumbering it here is exactly the class of bug this is.
 */
export const pickVideoFile = (files?: readonly { name: string, size: number, pad?: boolean }[]): number => {
  if (!files?.length) return 0
  let best = -1, bestSize = -1
  files.forEach((f, i) => { if (!f.pad && VIDEO_RE.test(f.name) && f.size > bestSize) { best = i; bestSize = f.size } })
  if (best >= 0) return best
  files.forEach((f, i) => { if (!f.pad && f.size > bestSize) { best = i; bestSize = f.size } })
  return best < 0 ? 0 : best
}

export const hasPlayableFile = (t: Torrent): boolean =>
  !!t.magnet && !!contentFiles(t.files).some((f) => VIDEO_RE.test(f.name))

export const watchHref = (t: Torrent): string | null => {
  if (!t.magnet || !contentFiles(t.files).length) return null
  // runs once per row inside a render, which is why the codec is synchronous, and returns null
  // rather than throwing on a magnet no encoding can hold
  const encoded = encodeMagnetParam(t.magnet)
  if (encoded === null) return null
  const source = encoded.key === 'm' ? { m: encoded.value } : { magnet: encoded.value }
  // `mode` is named here for the same reason embedPath names it, and leads for the same reason it
  // leads there: this URL is what sits in the address bar while somebody watches, so the readable
  // half goes in front of the packed torrent rather than behind it
  return getRoutePath(Route.EMBED, { mode: 'watch', fileIndex: String(pickVideoFile(t.files)), ...source })
}
