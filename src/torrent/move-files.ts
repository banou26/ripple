import type { TorrentClient } from './client'
import type { SaveLocation } from './library'
import type { Torrent } from './types'

import { savePathIn } from './save-location'
import { syncTorrentToDirectory } from './sync'

/**
 * Carrying a torrent's files from one storage to the other.
 *
 * The copy happens HERE, in a page, and only the engine half happens in the worker. That split is
 * not arbitrary: the directory handle and the mirror that writes through it both live here, the
 * mirror already compares content rather than trusting a byte count, and doing the copy where the
 * engine is would mean a second implementation of it.
 *
 * The two directions are not symmetrical, because the storages are not.
 *
 *  - INTO a folder, the bytes have to come out of the engine, since browser storage is not readable
 *    any other way. That is exactly what the auto-save mirror does, so this reuses it whole.
 *  - OUT of a folder, both ends are plain file handles: the user's file streams straight into an
 *    OPFS file. No engine involvement, and no verification pass either, because the re-add that
 *    follows asks the storage to check, which hashes every piece against the torrent. That check is
 *    strictly stronger than anything this could do by comparing bytes to bytes.
 *
 * Neither direction deletes anything. `relocate` does that, in the worker, and only where the copy
 * being dropped is Ripple's own.
 */

export type MoveProgress = { file: number, files: number, name: string }

const dirAt = async (
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> => {
  let dir = root
  for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create })
  return dir
}

const fileAt = async (
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle> => {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error('move: empty file path')
  const dir = await dirAt(root, parts.join('/'), create)
  return dir.getFileHandle(name, { create })
}

/**
 * Stream every file out of the user's folder into browser storage.
 *
 * `File.stream().pipeTo()` rather than a read-then-write loop, so a 20 GB file is never held in
 * memory. A file already there at the right length is skipped, which makes a retry after a failure
 * resume rather than start over: the writable publishes at close, so a copy that died halfway left
 * its target at the old length and will not be mistaken for a finished one.
 */
export const copyFolderIntoBrowserStorage = async (
  { torrent, folder, opfsRoot, onProgress }: {
    torrent: Torrent
    folder: FileSystemDirectoryHandle
    opfsRoot: FileSystemDirectoryHandle
    onProgress?: (progress: MoveProgress) => void
  },
): Promise<number> => {
  if (!torrent.infoHash) throw new Error('move: a torrent with no infohash has nowhere to go')
  const files = torrent.files ?? []
  const savePath = savePathIn('browser', torrent.infoHash)
  let written = 0
  for (const [index, file] of files.entries()) {
    onProgress?.({ file: index, files: files.length, name: file.name })
    const source = await fileAt(folder, file.name, false)
    const target = await fileAt(await dirAt(opfsRoot, savePath, true), file.name, true)
    if ((await target.getFile()).size === file.size) continue
    const writable = await target.createWritable()
    try {
      await (await source.getFile()).stream().pipeTo(writable)
      written++
    } catch (error) {
      await writable.abort().catch(() => {})
      throw error
    }
  }
  return written
}

/**
 * Put the files where they belong, then tell the engine.
 *
 * Copy first and always. If the copy throws, nothing has been told to move and nothing has been
 * deleted, so the torrent is exactly where it was and the whole thing is a retry rather than a loss.
 * `relocate` is the only step that drops anything, and it runs last.
 */
export const moveTorrentFiles = async (
  { client, torrent, folder, to, opfsRoot, onProgress }: {
    client: TorrentClient
    torrent: Torrent
    folder: FileSystemDirectoryHandle
    to: SaveLocation
    opfsRoot?: FileSystemDirectoryHandle
    onProgress?: (progress: MoveProgress) => void
  },
): Promise<void> => {
  if (to === 'folder') {
    await syncTorrentToDirectory(client, torrent, folder)
  } else {
    const root = opfsRoot ?? await navigator.storage.getDirectory()
    await copyFolderIntoBrowserStorage({ torrent, folder, opfsRoot: root, onProgress })
  }
  client.relocate(Number(torrent.id), to)
}
