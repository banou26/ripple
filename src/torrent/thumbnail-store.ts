// One picture per torrent, made from a file inside it, without costing the swarm anything.
//
// The whole design follows from one fact about the engine: `client.read(..., prioritize = false)`
// fails fast with 'not downloaded' when the bytes are not already on disk, and touches nothing when
// they are. Everything here is arranged so no read is ever issued that could re-plan piece
// priorities, because a thumbnail is worth less than a frame of somebody's playback.
//
// Reads therefore go out ONLY for byte ranges the bitfield already shows as present, and a torrent
// with nothing on disk simply has no picture yet. It gets one as its head lands.

import { del, get, set } from 'idb-keyval'
import { makeThumbnailer } from 'libav-wasm'

import type { TorrentClient } from './client'
import type { TorrentSnapshot } from './worker'
import type { Keyframe, ThumbnailSource } from './thumbnail'

import { downloadedByteRanges } from './downloaded-ranges'
import { magnetInfoHash } from './magnet'
import { downloadedFraction, pickThumbnailSource, rangeIsDownloaded, readableKeyframes } from './thumbnail'

/** Same `ripple:<thing>:<infoHash>` shape the worker's own keys use, in the same default store. */
const key = (infoHash: string) => 'ripple:thumb:' + infoHash

/** How much of the head has to exist before a video is worth opening at all. */
const MIN_HEAD_BYTES = 512 * 1024
/**
 * A failed attempt is not retried until the file has gained this much of itself.
 *
 * Without it, a torrent whose header is readable but whose keyframes are not would re-open libav on
 * every 500ms state tick for the life of the session.
 */
const RETRY_AFTER_FRACTION = 0.05

type Entry = {
  url: string | null
  /** The download fraction at the last attempt, so a retry waits for the file to actually grow. */
  triedAt: number
  loading: boolean
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const queue: (() => Promise<void>)[] = []
let running = false

const announce = () => listeners.forEach((listener) => listener())

/** Serialised on purpose: each job spins up a libav worker, and a library of rows would spawn one each. */
const pump = async () => {
  if (running) return
  running = true
  try {
    while (queue.length) await queue.shift()!()
  } finally {
    running = false
  }
}

export const subscribeThumbnails = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const thumbnailFor = (infoHash: string | undefined): string | null =>
  (infoHash ? entries.get(infoHash)?.url ?? null : null)

/** Dropped when its torrent is removed, since nothing else would ever collect it. */
export const forgetThumbnail = async (infoHash: string) => {
  const entry = entries.get(infoHash)
  if (entry?.url) URL.revokeObjectURL(entry.url)
  entries.delete(infoHash)
  announce()
  await del(key(infoHash)).catch(() => {})
}

const remember = (infoHash: string, blob: Blob | null, fraction: number) => {
  const previous = entries.get(infoHash)
  if (previous?.url) URL.revokeObjectURL(previous.url)
  entries.set(infoHash, {
    url: blob ? URL.createObjectURL(blob) : null,
    triedAt: fraction,
    loading: false,
  })
  announce()
}

/**
 * A reader over one file of a torrent that refuses anything not already on disk.
 *
 * `prioritize: false` is what makes this safe, and it is not the default: `client.read`'s fifth
 * argument defaults to TRUE, which re-anchors the caller's stream window and rewrites the torrent's
 * whole piece priority map around the offset asked for. Doing that for a thumbnail would drag the
 * swarm away from the bytes a viewer is actually blocked on, for every viewer of that handle.
 *
 * No viewer id is passed either. Registering one would add a claim to the shared plan and lift this
 * file out of the skip set, which is the same harm by another route.
 */
const readerFor = (client: TorrentClient, handle: number, source: ThumbnailSource, ranges: () => [number, number][]) =>
  async (offset: number, size: number): Promise<ArrayBuffer> => {
    const end = Math.min(offset + size, source.size)
    if (end <= offset) return new ArrayBuffer(0)
    // Checked here as well as in the worker, so a miss costs a comparison rather than a round trip.
    // libav probes freely and most of its probes land outside what a partial file has.
    if (!rangeIsDownloaded(ranges(), offset, end)) throw new Error('not downloaded')
    const bytes = await client.read(handle, source.index, offset, end - offset, false)
    // libav takes ownership of what it is handed, so this must be a buffer nothing else holds
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer as ArrayBuffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

export type LibavPaths = { publicPath: string, workerUrl: string }

const frameFromVideo = async (
  client: TorrentClient,
  handle: number,
  source: ThumbnailSource,
  ranges: () => [number, number][],
  paths: LibavPaths,
): Promise<Blob | null> => {
  const thumbnailer = await makeThumbnailer({
    publicPath: paths.publicPath,
    workerUrl: paths.workerUrl,
    read: readerFor(client, handle, source, ranges),
    length: source.size,
  })
  try {
    const info = await thumbnailer.init()
    const keyframes: Keyframe[] = info.indexes.map((index) => ({ timestamp: index.timestamp, pos: index.pos }))
    const candidates = readableKeyframes(keyframes, ranges(), source.size)
    // No index, or none of it readable: the opening is still worth a try, since a file being
    // downloaded has its head and a demuxer can usually seek to 0 without the index at all.
    for (const timestamp of candidates.length ? candidates : [0]) {
      try {
        const png = await thumbnailer.readKeyframe(timestamp)
        if (png.byteLength) return new Blob([png], { type: 'image/png' })
      } catch {
        // a listed keyframe can still fail to decode, so try the next rather than giving up
      }
    }
    return null
  } finally {
    // the worker outlives this function otherwise, one per torrent, forever
    await thumbnailer.destroy().catch(() => {})
  }
}

const imageBlob = async (
  client: TorrentClient,
  handle: number,
  source: ThumbnailSource,
  ranges: () => [number, number][],
): Promise<Blob | null> => {
  if (!rangeIsDownloaded(ranges(), 0, source.size)) return null
  const read = readerFor(client, handle, source, ranges)
  const bytes = await read(0, source.size)
  if (!bytes.byteLength) return null
  // Typed, because a blob URL serves whatever type its blob carries and an untyped one is
  // text/plain. Browsers sniff an <img> back into shape, so the bug is invisible where it is used
  // and only appears somewhere stricter. shrink() re-types it anyway; this is for when it cannot.
  return new Blob([bytes], { type: mimeFor(source.name) })
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
}

const mimeFor = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** Bounded width for a stored picture. It is drawn at 64px, and the cache is the origin's budget. */
const THUMB_WIDTH = 320

/**
 * Down to something worth keeping.
 *
 * What comes in is either a full cover scan or libav's frame at the video's own resolution, and both
 * are stored per torrent in the same origin budget the downloads compete for. Sintel's own poster
 * measured 46 kB at 1143x486 and 6 kB at 320px as webp, for a picture that is drawn at 64px wide.
 *
 * Failure here is not failure: the original is a perfectly good picture, just a larger one, so every
 * arm falls back to it rather than losing the thumbnail over an encoder.
 */
const shrink = async (blob: Blob): Promise<Blob> => {
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return blob
    const bitmap = await createImageBitmap(blob)
    try {
      const scale = Math.min(1, THUMB_WIDTH / bitmap.width)
      // already small enough, and re-encoding it could only make it worse
      if (scale === 1 && blob.size <= 64 * 1024) return blob
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
      const context = canvas.getContext('2d')
      if (!context) return blob
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
      // a browser without webp encoding hands back a png, which can be bigger than what came in
      return out.size < blob.size ? out : blob
    } finally {
      bitmap.close()
    }
  } catch {
    return blob
  }
}

type Job = {
  infoHash: string
  handle: number
  source: ThumbnailSource
  ranges: () => [number, number][]
  fraction: number
}

const run = async (client: TorrentClient, paths: LibavPaths, job: Job) => {
  try {
    const raw = job.source.kind === 'image'
      ? await imageBlob(client, job.handle, job.source, job.ranges)
      : await frameFromVideo(client, job.handle, job.source, job.ranges, paths)
    const blob = raw ? await shrink(raw) : null
    remember(job.infoHash, blob, job.fraction)
    // A miss is not cached: it usually means the bytes are not there YET, and the next attempt is
    // gated on the file having grown rather than on nothing having been written down.
    if (blob) await set(key(job.infoHash), blob).catch(() => {})
  } catch {
    remember(job.infoHash, null, job.fraction)
  }
}

/**
 * Look at the engine's current state and start whatever pictures are now possible.
 *
 * Called from the state tick, so it has to be cheap and idempotent: everything that would cost
 * anything is behind a check that the bytes already exist.
 */
export const considerThumbnails = (client: TorrentClient, snapshots: TorrentSnapshot[], paths: LibavPaths) => {
  for (const snapshot of snapshots) {
    const infoHash = magnetInfoHash(snapshot.magnet)
    if (!infoHash || !snapshot.files) continue

    const source = pickThumbnailSource(
      snapshot.files.files.map((file) => ({ name: file.path, size: file.size, progress: 0 })),
    )
    if (!source) continue

    const ranges = downloadedByteRanges(snapshot, source.index)
    const fraction = downloadedFraction(ranges, source.size)

    const entry = entries.get(infoHash)
    if (entry?.loading) continue
    if (entry?.url) continue
    // a previous miss waits for the file to have actually grown before costing anything again
    if (entry && fraction < entry.triedAt + RETRY_AFTER_FRACTION) continue

    const enough = source.kind === 'image'
      ? rangeIsDownloaded(ranges, 0, source.size)
      : rangeIsDownloaded(ranges, 0, Math.min(MIN_HEAD_BYTES, source.size))
    if (!enough) continue

    entries.set(infoHash, { url: entry?.url ?? null, triedAt: fraction, loading: true })
    const handle = snapshot.handle
    queue.push(() => run(client, paths, { infoHash, handle, source, ranges: () => ranges, fraction }))
  }
  void pump()
}

/**
 * Bring back whatever was made in an earlier session, so a reload does not re-open libav.
 *
 * Deliberately not awaited by the caller: a missing cache is a slower first paint, never an error.
 */
export const loadCachedThumbnails = async (infoHashes: string[]) => {
  for (const infoHash of infoHashes) {
    if (entries.has(infoHash)) continue
    const blob = await get<Blob>(key(infoHash)).catch(() => undefined)
    if (!blob) continue
    // another job may have finished while this awaited
    if (entries.get(infoHash)?.url) continue
    entries.set(infoHash, { url: URL.createObjectURL(blob), triedAt: 1, loading: false })
    announce()
  }
}
