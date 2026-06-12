// Copies a finished torrent out of OPFS into a user-picked local directory,
// recreating the torrent's relative paths. A file whose on-disk size already
// matches is skipped, so re-running the sync is idempotent.

import type { TorrentClient } from './client'
import type { Torrent } from './types'

const CHUNK = 8 * 1024 * 1024

const fileHandleAt = async (root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> => {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()!
  let dir = root
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
  return dir.getFileHandle(name, { create: true })
}

export const syncTorrentToDirectory = async (
  client: TorrentClient,
  torrent: Torrent,
  root: FileSystemDirectoryHandle,
): Promise<number> => {
  let written = 0
  for (const [index, file] of (torrent.files ?? []).entries()) {
    const handle = await fileHandleAt(root, file.name)
    if ((await handle.getFile()).size === file.size) continue
    const writable = await handle.createWritable()
    try {
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        const len = Math.min(CHUNK, file.size - offset)
        const chunk = await client.read(Number(torrent.id), index, offset, len)
        await writable.write(chunk as Uint8Array<ArrayBuffer>)
      }
      await writable.close()
      written++
    } catch (error) {
      await writable.abort().catch(() => {})
      throw error
    }
  }
  return written
}
