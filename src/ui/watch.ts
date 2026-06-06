// Build the /embed player URL for a torrent: pick its video file and base64 the
// magnet (embed.tsx decodes with atob). Returns null when there's nothing to
// play yet (no magnet or metadata not in).

import type { Torrent, TorrentFile } from './types'
import { getRoutePath, Route } from '../router/path'

const VIDEO_RE = /\.(mp4|mkv|webm|avi|mov|m4v|ts|flv|wmv|mpg|mpeg|ogv)$/i

// The file index the player should open: the largest video file, else the
// largest file. The array index IS the libtorrent file index (order preserved).
export const pickVideoFile = (files?: TorrentFile[]): number => {
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
  return getRoutePath(Route.EMBED, { magnet: btoa(t.magnet), fileIndex: String(pickVideoFile(t.files)) })
}
