import type { Built } from './create-source'
import type { SourceRef } from './walk-source'

import { storage } from '@banou/ponyfill'
import { evictionFloor } from './storage-budget'
import { fileFrom } from './walk-source'
import { readTorrentFile } from './torrent-file'
import { savePathFor } from './library'

/**
 * Keeping a created torrent's bytes, for a pick that cannot be re-opened.
 *
 * A torrent created from a `FileSystemFileHandle` re-reads its source on every request and survives
 * a reload, because a handle is a way to get a fresh `File` for as long as its grant lasts. A pick
 * made through `<input type="file">` is not that: it is one snapshot, readable for the life of the
 * page and impossible to re-acquire afterwards without another pick. So on Firefox, which has no
 * handle pickers, a created torrent used to seed until the tab was reloaded and then go `missing`.
 *
 * The answer chosen by the owner is to COPY those bytes into browser storage, where the torrent then
 * lives like any ordinary download and seeds across loads with nothing to re-grant.
 *
 * WHY THIS DOES NOT BREAK THE `source` TIER, which `save-location.ts` deliberately refuses to move.
 * That refusal is about the user's own originals: nothing may copy, move or delete THEM. This reads
 * them and writes somewhere else, which is the same direction of travel as hashing the pick in the
 * first place, and the originals are untouched by construction: every write here targets OPFS. The
 * torrent that results is not source-backed at all. It never enters the `source` tier, so there is
 * no rule here to argue with, only one to stay on the right side of.
 *
 * IT IS A PROPERTY OF THE PICK, NOT OF THE BROWSER. The question is whether this particular pick
 * handed over handles or snapshots, which is exactly `root === null` in `use-create-torrent.ts`.
 * Gating on the engine instead would be right today by coincidence and wrong the moment Firefox
 * ships the pickers, or a Chromium user picks through an input.
 */

/**
 * The longest path element libtorrent will use as written.
 *
 * MEASURED 2026-09-03 rather than read out of a header, by creating a torrent whose files were named
 * at 100, 200, 230, 236, 239, 240, 241 and 250 characters and listing what the engine put on disk.
 * Everything to 240 was untouched. The 241 and the 250 came back with a SECOND, shorter file beside
 * the one that was written, which is libtorrent renaming what it could not use.
 *
 * The exact rule for what it renames TO is not replicated here on purpose: the two observed
 * truncations landed at 240 and 244, which is not a single flat limit, and guessing at a rule that
 * is version dependent would trade a loud failure for a silent one. What matters is the boundary at
 * which it starts, and that is what this is.
 */
export const MAX_PATH_ELEMENT_BYTES = 240

/**
 * The first path element libtorrent would rename, or null when the whole layout is safe to write.
 *
 * A renamed element is not cosmetic here. The copy writes to the path in the torrent while the
 * engine looks at the path it chose, so the check finds nothing and the torrent sits at 0% trying to
 * download what its own author just made. Measured exactly that way: a 250 character filename left
 * THREE files on disk, the two written by the copy and one empty one the engine made for itself, and
 * the torrent never left state 3.
 *
 * Bytes rather than characters, because that is what the limit is in.
 */
export const unsafePathElement = (paths: string[]): string | null => {
  const encoder = new TextEncoder()
  for (const path of paths) {
    for (const element of path.split('/')) {
      if (encoder.encode(element).length > MAX_PATH_ELEMENT_BYTES) return element
    }
  }
  return null
}

/** Whether a pick can be kept, and by how much it misses when it cannot. */
export type CopyRoom =
  | { kind: 'fits' }
  | { kind: 'short', shortBy: number }
  /**
   * A name so long the engine would rename it, so nothing may be written against it.
   *
   * Declining is the whole point rather than a limitation: the alternative is replicating a rename
   * rule that is not stable between versions, and being wrong about it produces a torrent that
   * verifies at zero with nothing anywhere reporting a fault.
   */
  | { kind: 'unsafe', element: string }
  /**
   * The browser would not say what the quota is.
   *
   * Treated as "do not start", not as "probably fine". This is the largest copy the app can make and
   * a failure lands after minutes of writing, so an unknown budget is the one case where guessing
   * optimistically costs the most.
   */
  | { kind: 'unknown' }

/**
 * Whether the copy fits, keeping the same floor free that the eviction budget keeps.
 *
 * The floor rather than the whole quota, because filling the origin to the brim would leave the
 * budget pass immediately trying to reclaim the very torrent that was just created, and it cannot:
 * a created torrent is not a cache entry, so it is not an eviction candidate, and the origin would
 * simply be stuck full with nothing to give.
 */
export const roomForCopy = (
  { totalBytes, usedBytes, limitBytes }: { totalBytes: number, usedBytes: number, limitBytes: number },
): CopyRoom => {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return { kind: 'unknown' }
  if (!Number.isFinite(usedBytes) || usedBytes < 0) return { kind: 'unknown' }
  const spare = limitBytes - usedBytes - evictionFloor(limitBytes)
  return totalBytes <= spare ? { kind: 'fits' } : { kind: 'short', shortBy: totalBytes - spare }
}

/**
 * Asked once, before anything is hashed, so the dialog can say what will happen.
 *
 * MEASURED usage, not the browser's own figure, for the same reason the worker's `measureSpace`
 * corrects it: on Chrome 151 `usageDetails.fileSystem` came back as 752 bytes against a verified
 * 1.78 GB of torrent data, and `@banou/ponyfill` carries the measurement and the correction.
 * Believing an
 * under-report here means promising a copy there is no room for, then failing partway through the
 * largest write the app ever makes. The walk costs a directory traversal, once, at pick time.
 */
export const measureRoomForCopy = async (totalBytes: number, paths: string[] = []): Promise<CopyRoom> => {
  const unsafe = unsafePathElement(paths)
  if (unsafe) return { kind: 'unsafe', element: unsafe }
  try {
    /*
     * The origin is OPENED before it is measured, and that is not the same question.
     *
     * `estimate()` falls back to the browser's own figure when the file system cannot be walked,
     * which is right for a readout and wrong for this: the browser's figure is the one that came
     * back six orders of magnitude short, and deciding to write gigabytes against it is exactly the
     * promise this function exists to avoid making. An origin that will not even open is also an
     * origin the copy could not write to, so there is nothing to weigh.
     */
    await storage.getDirectory()
    const { usage, quota } = await storage.estimate()
    if (usage === undefined) return { kind: 'unknown' }
    return roomForCopy({ totalBytes, usedBytes: usage, limitBytes: quota ?? 0 })
  } catch { return { kind: 'unknown' } }
}

export type CopyProgress = { file: number, files: number, name: string, copiedBytes: number, totalBytes: number }

const dirAt = async (root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> => {
  let dir = root
  for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create: true })
  return dir
}

const fileAt = async (root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> => {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error('copy: empty file path')
  return (await dirAt(root, parts.join('/'))).getFileHandle(name, { create: true })
}

/**
 * Where each of a built torrent's files has to land, and which picked file goes there.
 *
 * Two things have to be exactly right and neither is guessable, so both are read back out of the
 * finished `.torrent` rather than reconstructed:
 *
 *  - THE PATH. libtorrent lays a multi-file torrent out as `savePath/<name>/<path>`, a single-file
 *    one as `savePath/<name>` with no directory at all, and a V2-ONLY torrent whose file tree holds
 *    exactly one leaf at `savePath/<path>` with the name DISCARDED. That third rule is not a detail:
 *    it is libtorrent's `single_file` line in `extract_files2`, and this code shipped without it for
 *    an afternoon. A run put the bytes at `movie.mkv/movie.mkv`, the engine's check found nothing,
 *    and the torrent sat at zero downloading what its own author had just made. `readTorrentFile`
 *    now produces all three, and `sync.ts` and `move-files.ts` already write into a folder using the
 *    same convention taken from the engine's own list, so this is one convention with one reader
 *    rather than a second implementation of the naming.
 *  - WHICH FILE. `index` on that list is the ENGINE index, pads included, which is precisely how
 *    `Built.handles` is laid out: dense by torrent index with a `null` at every pad. So the join is
 *    an array lookup and cannot drift. Matching by path would be the drifting version, and would
 *    also be impossible for the single-file case, where the torrent's name is the file's name and
 *    the picked file may have been renamed in the dialog.
 */
export const layoutFor = async (built: Built): Promise<{ path: string, size: number, ref: SourceRef }[]> => {
  const subject = await readTorrentFile(built.bytes)
  if (!subject) throw new Error('the torrent that was just built could not be read back')
  if (!subject.files) throw new Error('the torrent that was just built lists no files')
  // checked against the FINISHED torrent, not only against the pick: the name is editable in the
  // dialog and is a path element in its own right for every file in a multi-file torrent
  const unsafe = unsafePathElement(subject.files.map((file) => file.name))
  if (unsafe) throw new Error(`${unsafe.slice(0, 40)}... is too long a name for the engine to keep`)
  return subject.files.map((file) => {
    const ref = built.handles[file.index]
    if (!ref) throw new Error(`no picked file for ${file.name}, at engine index ${file.index}`)
    return { path: file.name, size: file.size, ref }
  })
}

/**
 * Stream the pick into browser storage, under the save path the torrent will be added at.
 *
 * `File.stream().pipeTo()` rather than a read-then-write loop, so a 20 GB pick is never held in
 * memory, and a file already there at the right length is skipped, which makes a retry resume rather
 * than start over. Both of those are `move-files.ts`'s copy, arrived at for the same reasons; what
 * differs is only where the layout comes from.
 *
 * NOTHING IS ADDED HERE. The caller adds the torrent afterwards, so a copy that throws leaves an
 * engine that was never told about it and a library with no row, and the bytes under `/dl/<hash>`
 * that a half-finished copy leaves are exactly the shape `runOrphanSweep` reclaims: a per-torrent
 * directory for a torrent the list has no record of. So an abandoned attempt tidies itself up.
 */
export const copyPickIntoBrowserStorage = async (
  { built, opfsRoot, signal, onProgress }: {
    built: Built
    opfsRoot?: FileSystemDirectoryHandle
    signal?: AbortSignal
    onProgress?: (progress: CopyProgress) => void
  },
): Promise<{ savePath: string, copiedBytes: number }> => {
  const layout = await layoutFor(built)
  const savePath = savePathFor(built.infoHash)
  const root = await dirAt(opfsRoot ?? await navigator.storage.getDirectory(), savePath)
  const totalBytes = layout.reduce((sum, file) => sum + file.size, 0)
  let copiedBytes = 0

  for (const [index, file] of layout.entries()) {
    if (signal?.aborted) throw new DOMException('the copy was cancelled', 'AbortError')
    onProgress?.({ file: index, files: layout.length, name: file.path, copiedBytes, totalBytes })
    const target = await fileAt(root, file.path)
    if ((await target.getFile()).size === file.size) { copiedBytes += file.size; continue }
    const source = await fileFrom(file.ref)
    /*
     * The snapshot is checked against the torrent that was built from it, one file at a time.
     *
     * `changedSince` already caught an edit between the walk and the end of hashing, and this is the
     * window after that: the bytes being copied are what peers will be served, and a file that moved
     * underneath since would give a torrent whose pieces describe a version that is no longer on
     * disk. It publishes cleanly and then fails every piece anybody asks for, which looks like a
     * network fault and is not one.
     */
    if (source.size !== file.size) {
      throw new Error(`${file.path} is now ${source.size} bytes where the torrent describes ${file.size}`)
    }
    const writable = await target.createWritable()
    try {
      await source.stream().pipeTo(writable)
    } catch (error) {
      await writable.abort().catch(() => {})
      throw error
    }
    copiedBytes += file.size
  }
  onProgress?.({ file: layout.length, files: layout.length, name: '', copiedBytes, totalBytes })
  return { savePath, copiedBytes }
}
