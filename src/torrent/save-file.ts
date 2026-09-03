// Reads through the worker's Session.read(): the worker owns the OPFS SyncAccessHandle,
// so an export never races the seeding write lock.

import { showSaveFilePicker } from '@banou/ponyfill'

import type { TorrentClient } from './client'
import type { TorrentFile } from './types'

import { contentFiles } from './types'
import type { Sink } from './stream-download'
import { openStreamSink } from './stream-download'
import { writeZip } from './zip'

const CHUNK = 8 * 1024 * 1024

/**
 * How many times a chunk is asked for before the export gives up.
 *
 * A read waits on pieces landing, and `client.read` rejects it after 120s. On a torrent still
 * pulling from the swarm that is an ordinary event, not a failure: peers come and go. Without this
 * one slow chunk aborts an entire multi-hour export, which is the difference between a download page
 * that finishes a 20 GB pack and one that never does.
 */
const READ_ATTEMPTS = 4
const RETRY_BACKOFF_MS = 1_000

/**
 * The ceiling on the last-resort arm, which holds the whole file in memory before it writes anything.
 *
 * Reached only when neither the picker nor the service worker is available, which is exactly the
 * embedded case, and where the files are torrent-sized. Buffering a 20 GB release into an array of
 * chunks does not fail gracefully, so it is refused with something the page can explain instead.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024 * 1024

/** The save was stopped by the person doing it, so no failure is reported anywhere. */
export const isSaveCancelled = (error: unknown): boolean =>
  (error as { name?: string })?.name === 'AbortError'

/** No arm of the sink chain can deliver bytes here. Carries a reason fit to show someone. */
export class DownloadUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadUnavailableError'
  }
}

const triggerAnchorDownload = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

type SinkRequest = {
  /** Advertised to the browser as Content-Length. 0 where it is not known exactly, as for a zip. */
  contentLength?: number
  /** What would have to be held in memory on the last-resort arm. */
  totalBytes?: number
}

/**
 * Where the bytes go, in the order the arms are worth trying.
 *
 * The service worker comes FIRST, and that ordering is the product decision rather than a fallback
 * chain: the download then belongs to the browser's own download manager, with its progress, its
 * pause and resume, its history and its default folder, and nobody is asked to choose a location
 * before anything has been fetched. The save picker sat here until 2026-08-28 and made that arm
 * unreachable on every desktop Chromium at top level, so the shipping path was only ever exercised
 * inside a cross-origin frame.
 *
 * The picker stays as the arm BELOW it, because the worker's answer is not always yes: a first load
 * before `clients.claim()` has run has no controller, and a dev server has no worker at all. The
 * controller is checked synchronously so that a page in that state falls through with the click's
 * transient activation still intact, which the picker needs and cannot get back.
 *
 * MUST be called synchronously from the click handler for the same reason: both arms spend that
 * activation, and an await before this loses it.
 */
const openSink = async (baseName: string, { contentLength = 0, totalBytes = 0 }: SinkRequest = {}): Promise<Sink> => {
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
    const streamed = await openStreamSink(baseName, contentLength)
    if (streamed) return streamed
  }

  /**
   * The picker, through `@banou/ponyfill` rather than off the window, and the difference is the
   * ORDER in which it refuses.
   *
   * Chrome exposes `showSaveFilePicker` whether or not it can be used and refuses at CALL time in a
   * cross origin frame, which is what /embed is. That rejection also burns part of the click's
   * transient activation, and the arm below still needs it. The ponyfill raises both of its
   * refusals BEFORE calling the platform, so the gesture survives to reach the fallback. Ripple
   * carried a byte-identical copy of that check until it moved there.
   */
  try {
    const handle = await showSaveFilePicker({ suggestedName: baseName })
    const writable = await handle.createWritable()
    return {
      /*
       * The one cast, at the one DOM boundary that needs it.
       *
       * A bare `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which includes a view over a
       * SharedArrayBuffer, and `FileSystemWriteChunkType` excludes exactly that. No chunk here can
       * be one: they come from `client.read`, which returns structured clones, and from the zip
       * writer, which allocates its own. `openStreamSink` already relies on the same fact, since it
       * TRANSFERS `chunk.buffer`, which a shared buffer refuses.
       */
      write: (c) => writable.write(c as Uint8Array<ArrayBuffer>),
      close: () => writable.close(),
      abort: () => writable.abort?.().catch(() => {}),
    }
  } catch (error) {
    /**
     * Only a genuine "the user closed the dialog" ends the save.
     *
     * Everything else is this environment declining to offer a picker, and the arm below can still
     * deliver the bytes. The ponyfill names its refusals `NotAllowedError` for exactly this reason:
     * `AbortError` is the platform's word for the person cancelling, and a refusal wearing it would
     * end a save that could still have worked and report it as "Saving X failed".
     */
    if (isSaveCancelled(error)) throw error
  }

  if (totalBytes > MAX_BUFFERED_BYTES) {
    throw new DownloadUnavailableError(
      'This browser could not start a streaming download here, and the file is too large to build in memory.',
    )
  }

  const parts: Uint8Array[] = []
  return {
    // copied rather than kept: a caller may hand over a view it still owns
    write: async (c) => { parts.push(c.slice()) },
    close: async () => triggerAnchorDownload(new Blob(parts as BlobPart[]), baseName),
    abort: async () => {},
  }
}

export type SaveOptions = {
  /**
   * The viewer id this export reads as. Without one the engine plans NOTHING: `anchorSequential`
   * returns immediately, so the torrent keeps whatever priority map it already had and the export
   * crawls one chunk at a time with no prefetch ahead of the reader. With one, every chunk moves the
   * stream window and the swarm is pulled in the order the bytes are being written.
   */
  viewer?: string
  signal?: AbortSignal
}

const abortError = (signal?: AbortSignal) =>
  signal?.reason ?? new DOMException('Aborted', 'AbortError')

/**
 * Rejects the moment the save is cancelled, and never resolves.
 *
 * `until` unregisters the listener once the race is decided. `{ once: true }` alone does not: it
 * only fires-and-removes on the event, so on the normal path (the read wins) the listener stays
 * attached forever. One is built per attempt per 8 MB chunk, so a 20 GB export would leave thousands
 * of them on a single signal, each retaining its own closure.
 */
const untilAborted = (signal: AbortSignal, until: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) { reject(abortError(signal)); return }
    signal.addEventListener('abort', () => reject(abortError(signal)), { once: true, signal: until })
  })

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)) }
    if (signal?.aborted) { clearTimeout(timer); reject(abortError(signal)); return }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

const readChunk = async (
  client: TorrentClient,
  handle: number,
  fileIndex: number,
  offset: number,
  len: number,
  { viewer, signal }: SaveOptions,
): Promise<Uint8Array> => {
  let last: unknown
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortError(signal)
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt, signal)
    try {
      // the signal goes INTO the read: abandoning it here leaves the worker retrying it, and a
      // stalled retry re-anchors this page's claim, which un-cancels the download it belongs to
      const read = client.read(handle, fileIndex, offset, len, true, viewer, signal)
      /**
       * Raced rather than simply awaited, because `client.read` takes no signal of its own and sits
       * on its pieces for up to 120s. Awaiting it would make Cancel mean "stop after this chunk",
       * which on a stalled torrent is two minutes of a button that looks broken.
       *
       * The losing read is left to settle on its own with its rejection already handled, so
       * abandoning it cannot surface as an unhandled rejection.
       */
      read.catch(() => {})
      const settled = new AbortController()
      const chunk = signal
        ? await Promise.race([read, untilAborted(signal, settled.signal)]).finally(() => settled.abort())
        : await read
      // The single-file path advertises a Content-Length, and a browser handed fewer bytes than it
      // was promised waits for the rest forever. writeZip makes the same check for the same reason.
      if (chunk.length !== len) throw new Error(`short read: ${chunk.length}/${len} at ${offset}`)
      return chunk
    } catch (error) {
      // a save the person stopped is not a read to try again
      if (isSaveCancelled(error)) throw error
      last = error
    }
  }
  throw last instanceof Error
    ? new Error(`could not read ${len} bytes at ${offset} of file ${fileIndex}: ${last.message}`)
    : last
}

/** One file of a torrent, named by the index the ENGINE knows it by rather than by list position. */
export type SaveEntry = {
  /** The engine's file index. Never a position in a filtered array; those stop matching on a subset. */
  index: number
  path: string
  size: number
}

export const saveTorrentFileToDisk = async (
  client: TorrentClient,
  handle: number,
  fileIndex: number,
  filePath: string,
  fileBytes: number,
  onProgress?: (fraction: number) => void,
  options: SaveOptions = {},
): Promise<void> => {
  const baseName = filePath.split('/').pop() || 'download'
  const sink = await openSink(baseName, { contentLength: fileBytes, totalBytes: fileBytes })
  try {
    for (let offset = 0; offset < fileBytes; offset += CHUNK) {
      const len = Math.min(CHUNK, fileBytes - offset)
      const chunk = await readChunk(client, handle, fileIndex, offset, len, options)
      await sink.write(chunk)
      onProgress?.((offset + len) / fileBytes)
    }
    await sink.close()
  } catch (e) {
    await sink.abort()
    throw e
  }
}

/**
 * Any set of a torrent's files, as one zip.
 *
 * Entries carry their engine index, which is what makes a SUBSET safe: reading by list position
 * silently exports the wrong files the moment the caller passes anything but the whole torrent in
 * its original order.
 */
export const saveTorrentEntriesAsZipToDisk = async (
  client: TorrentClient,
  handle: number,
  zipName: string,
  entries: SaveEntry[],
  onProgress?: (fraction: number) => void,
  options: SaveOptions = {},
): Promise<void> => {
  const baseName = (zipName.replace(/[/\\]/g, '_') || 'torrent') + '.zip'
  const totalBytes = entries.reduce((n, e) => n + e.size, 0)
  // contentLength stays 0: a zip's length is not known until its central directory has been written
  const sink = await openSink(baseName, { totalBytes })
  try {
    await writeZip(
      entries.map((entry) => ({
        path: entry.path,
        size: entry.size,
        read: (offset: number, len: number) => readChunk(client, handle, entry.index, offset, len, options),
      })),
      sink.write,
      onProgress,
    )
    await sink.close()
  } catch (e) {
    await sink.abort()
    throw e
  }
}

export const saveTorrentAsZipToDisk = async (
  client: TorrentClient,
  handle: number,
  torrentName: string,
  files: TorrentFile[],
  onProgress?: (fraction: number) => void,
  options: SaveOptions = {},
): Promise<void> =>
  saveTorrentEntriesAsZipToDisk(
    client,
    handle,
    torrentName,
    // pads are zeroes libtorrent synthesizes, and an archive holding a `.pad` folder of them is a
    // file the person did not ask for; `index` is the engine's, so filtering here is safe
    contentFiles(files).map((f) => ({ index: f.index, path: f.name, size: f.size })),
    onProgress,
    options,
  )
