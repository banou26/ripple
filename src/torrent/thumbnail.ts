// Choosing what to make a torrent's picture out of, and which frame of it can actually be read.
//
// Kept pure and apart from the generator so the decisions can be tested without libav, a worker or a
// swarm. Everything here answers a question about bytes that exist; nothing here fetches any.

import type { TorrentFile } from './types'

/** Formats a browser will decode from a Blob with no help from libav. */
const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|ico)$/i

/**
 * Formats worth handing to libav for a frame.
 *
 * Wider than watch.ts's list on purpose: libav's thumbnailer decodes in wasm and hands back pixels,
 * so it opens files the remuxer refuses outright (mpeg2, mpeg4 part 2, theora, vc1). A file that
 * cannot be PLAYED here can still have its picture taken.
 */
const VIDEO_RE = /\.(mp4|mkv|webm|avi|mov|m4v|ts|m2ts|mts|flv|wmv|mpg|mpeg|m2v|ogv|3gp|rmvb|vob|divx|asf)$/i

export type ThumbnailSource = {
  /** The ENGINE's file index, never a position in a filtered list. */
  index: number
  kind: 'image' | 'video'
  size: number
  name: string
}

/**
 * An image is not resized before it is cached, so a 60 MB scan is not worth reading off the swarm to
 * show at 64px. Cover art in a release folder is comfortably under this.
 */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024

/**
 * What to take the picture from, or null when nothing in the torrent is media.
 *
 * An image wins over a video even when it is far smaller, because a release that ships cover art
 * shipped it to BE the picture, and reading it costs one range instead of a demux. Between videos
 * the largest wins, which is the same rule the Watch button uses to find the feature rather than a
 * sample or a trailer.
 */
export const pickThumbnailSource = (files?: TorrentFile[]): ThumbnailSource | null => {
  if (!files?.length) return null

  let image: ThumbnailSource | null = null
  let video: ThumbnailSource | null = null
  files.forEach((file, index) => {
    if (IMAGE_RE.test(file.name)) {
      if (file.size > MAX_IMAGE_BYTES) return
      // the largest image, on the assumption that cover art outweighs an icon or a screenshot strip
      if (!image || file.size > image.size) image = { index, kind: 'image', size: file.size, name: file.name }
      return
    }
    if (VIDEO_RE.test(file.name)) {
      if (!video || file.size > video.size) video = { index, kind: 'video', size: file.size, name: file.name }
    }
  })

  return image ?? video
}

/** Whether every byte of [from, to) is on disk, given the file's downloaded ranges. */
export const rangeIsDownloaded = (ranges: [number, number][], from: number, to: number): boolean => {
  if (to <= from) return true
  return ranges.some(([start, end]) => start <= from && end >= to)
}

/** How much of the file is on disk, as a fraction, used only to decide whether a retry is worth it. */
export const downloadedFraction = (ranges: [number, number][], size: number): number => {
  if (size <= 0) return 0
  return Math.min(1, ranges.reduce((n, [from, to]) => n + Math.max(0, to - from), 0) / size)
}

export type Keyframe = { timestamp: number, pos: number }

/** How far past the first readable keyframe still counts as "the opening", in seconds. */
const OPENING_SECONDS = 300
/** How many timestamps to hand back, since a listed keyframe can still fail to decode. */
const ATTEMPTS = 4

/**
 * Which keyframes can be decoded right now, best first.
 *
 * A torrent that is still downloading has its head, so the readable keyframes are the early ones,
 * and the very first frame of a film is usually black or a distributor card. So this prefers the
 * LATEST readable keyframe that is still inside the opening stretch of the file, which in practice
 * is real footage, and falls back to whatever is readable at all.
 *
 * `pos` is a byte offset into the file, and a keyframe needs more than the single byte it starts at,
 * so each candidate is checked against a window rather than a point. A keyframe whose window runs
 * past the end of the downloaded run decodes into a truncated packet and fails inside libav.
 */
export const readableKeyframes = (
  keyframes: Keyframe[],
  ranges: [number, number][],
  fileSize: number,
  windowBytes = 4 * 1024 * 1024,
): number[] => {
  const readable = keyframes
    .filter((frame) => frame.pos >= 0 && frame.pos < fileSize)
    .filter((frame) => rangeIsDownloaded(ranges, frame.pos, Math.min(frame.pos + windowBytes, fileSize)))
    .sort((a, b) => a.timestamp - b.timestamp)
  if (!readable.length) return []

  // Past the opening card, but not so far in that it needs bytes a fresh torrent will not have. On a
  // complete file this lands a few minutes in; on one that only has its head it is simply the
  // deepest frame available, which is still the least likely of them to be black.
  const window = readable.filter((frame) => frame.timestamp <= readable[0]!.timestamp + OPENING_SECONDS)
  const pool = window.length ? window : readable
  const best = pool[pool.length - 1]!

  // the best guess first, then a few others, because a keyframe can be listed and still not decode
  return [best.timestamp, ...readable.filter((frame) => frame !== best).map((frame) => frame.timestamp)]
    .slice(0, ATTEMPTS)
}
