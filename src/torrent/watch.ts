import type { Torrent, TorrentFile } from './types'

import { encodeMagnetParam } from '../router/magnet-codec'
import { getRoutePath, Route } from '../router/path'

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
// only `name` and `size` are read, so anything carrying those qualifies: the share dialog builds
// its file list from a .torrent in the page and never has a TorrentFile
export const pickVideoFile = (files?: readonly { name: string, size: number }[]): number => {
  if (!files?.length) return 0
  let best = -1, bestSize = -1
  files.forEach((f, i) => { if (VIDEO_RE.test(f.name) && f.size > bestSize) { best = i; bestSize = f.size } })
  if (best >= 0) return best
  files.forEach((f, i) => { if (f.size > bestSize) { best = i; bestSize = f.size } })
  return best < 0 ? 0 : best
}

export const hasPlayableFile = (t: Torrent): boolean =>
  !!t.magnet && !!t.files?.some((f) => VIDEO_RE.test(f.name))

export const watchHref = (t: Torrent): string | null => {
  if (!t.magnet || !t.files?.length) return null
  // runs once per row inside a render, which is why the codec is synchronous, and returns null
  // rather than throwing on a magnet no encoding can hold
  const encoded = encodeMagnetParam(t.magnet)
  if (encoded === null) return null
  const source = encoded.key === 'm' ? { m: encoded.value } : { magnet: encoded.value }
  return getRoutePath(Route.EMBED, { ...source, fileIndex: String(pickVideoFile(t.files)) })
}
