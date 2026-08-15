import { STORAGE_NEED_FULL_CHECK, STORAGE_NO_ERROR } from 'libtorrent-wasm/opfs'

import type { MeasurableStorage } from './opfs-storage'

/**
 * Reading a torrent's files back out of the folder the user granted, so it can be shared from there.
 *
 * Ripple downloads into OPFS and the auto-save mirror writes the same bytes into the user's own
 * folder, which leaves one disk holding two copies. Dropping the OPFS one is easy; the reason it
 * used to cost sharing is that libtorrent serves an upload by READING the file back, and the only
 * storage backend was OPFS. So a released torrent had nothing left to read.
 *
 * Nothing about that was a law. `StorageBackend.read` may return a promise, `onNewStorage` is handed
 * the save path, and a `FileSystemDirectoryHandle` clones into a worker, so a backend can perfectly
 * well answer a read from the user's folder. This is that backend.
 *
 * MEASURED before writing it (Chrome, 16 KiB random reads, the block size libtorrent asks for):
 *
 *   sync access handle, as OPFS uses today   184 to 194 MB/s     ~85 us per read
 *   getFile().slice().arrayBuffer()           39 to  43 MB/s    ~390 us per read
 *   the same, re-opening the File every read  40 to  48 MB/s    ~390 us per read
 *
 * About four and a half times the latency per block, and it does not matter: 40 MB/s is far above
 * anything Ripple uploads, and the fastest download it has ever managed is around 10 MB/s. The third
 * row is why this holds no `File` object between reads. Caching one bought nothing measurable, and a
 * `File` is a snapshot that throws once the file changes underneath, so keeping one would be a
 * liability for no gain.
 *
 * READ ONLY, and that is structural rather than an omission. Writing to a granted folder can only go
 * through `createWritable()`, which writes to a `.crswap` sibling and publishes by renaming over the
 * target at `close()`. There is no in-place write: `createSyncAccessHandle` on a picker-granted file
 * throws `InvalidStateError: Access Handles may only be created on temporary file systems`, measured
 * against an OPFS control that succeeded in the same worker on the same run. So a torrent backed by
 * this must never be asked to write, which means adding it with `TORRENT_FLAG.uploadMode`.
 */

/** Save paths under here mean "the files are in the user's folder", not in OPFS. */
export const NATIVE_ROOT = '/native'

export const nativeSavePathFor = (infoHash: string) => `${NATIVE_ROOT}/${infoHash}`

export const isNativeSavePath = (savePath: string | undefined): boolean =>
  savePath === NATIVE_ROOT || !!savePath?.startsWith(NATIVE_ROOT + '/')

/** Where the user's folder is right now, or null. A function because the grant comes and goes. */
export type FolderSource = () => FileSystemDirectoryHandle | null

type NativeStorage = { savePath: string, files: Array<{ path: string, size: number }> }

const fileAt = async (root: FileSystemDirectoryHandle, path: string): Promise<File> => {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error(`hybrid storage: empty file path`)
  let dir = root
  // never `create: true` on any of this. A missing directory means the user moved or deleted their
  // own files, and the answer to that is an error the engine can report, not an empty file we made
  for (const part of parts) dir = await dir.getDirectoryHandle(part)
  return (await dir.getFileHandle(name)).getFile()
}

export const createHybridStorage = (opfs: MeasurableStorage, folder: FolderSource): MeasurableStorage => {
  const native = new Map<number, NativeStorage>()

  const rootOr = (what: string): FileSystemDirectoryHandle => {
    const root = folder()
    // A grant is per session and comes back unpermitted after a reload until the user acts, so this
    // is an ordinary state rather than a broken one. It still has to be an error: the engine
    // stopping the torrent is right, and answering the read with anything else would mean serving
    // bytes we do not have.
    if (!root) throw new Error(`hybrid storage: no folder granted, cannot ${what}`)
    return root
  }

  return {
    usageOf: async (savePath) => {
      // the origin is not charged for the user's own files, and reporting their size as OPFS usage
      // would have the budget pass trying to reclaim space that was never taken
      if (isNativeSavePath(savePath)) return 0
      return opfs.usageOf(savePath)
    },

    onNewStorage: (id, savePath, files) => {
      if (!isNativeSavePath(savePath)) return opfs.onNewStorage(id, savePath, files)
      native.set(id, { savePath, files })
    },

    onRemoveStorage: (id) => {
      if (!native.delete(id)) return opfs.onRemoveStorage(id)
    },

    read: (id, fileIndex, offset, len) => {
      const entry = native.get(id)
      if (!entry) return opfs.read(id, fileIndex, offset, len)
      const meta = entry.files[fileIndex]
      if (!meta) throw new Error(`hybrid storage: no file ${fileIndex} in ${entry.savePath}`)
      return (async () => {
        const file = await fileAt(rootOr('read'), meta.path)
        const chunk = await file.slice(offset, offset + len).arrayBuffer()
        // Deliberately NOT zero-filling a short read, which is what the OPFS backend does. There, a
        // hole is a piece not downloaded yet and zeros are the honest answer. Here it means the
        // user's file is shorter than the torrent says, and zeros would be handed to a peer as real
        // data, fail their hash check, and get us dropped for serving garbage. An error stops the
        // torrent instead, which is the outcome worth having.
        if (chunk.byteLength < len) {
          throw new Error(`hybrid storage: ${meta.path} ended early, wanted ${len} at ${offset}, got ${chunk.byteLength}`)
        }
        return new Uint8Array(chunk)
      })()
    },

    write: (id, fileIndex, offset, bytes) => {
      const entry = native.get(id)
      if (!entry) return opfs.write(id, fileIndex, offset, bytes)
      // Unreachable by construction, and loud rather than silent if the construction ever slips. A
      // torrent on this backend is added with `uploadMode`, so libtorrent never requests a piece and
      // never writes. There is also no way to honour it: `createWritable` would publish by renaming
      // over the user's file at close, which is the last thing anyone wants done to their own data.
      throw new Error(`hybrid storage: ${entry.savePath} is read only, refusing a write of ${bytes.length} at ${offset} in file ${fileIndex}`)
    },

    check: async (id) => {
      const entry = native.get(id)
      if (!entry) return opfs.check!(id)
      // Every file present at the length the torrent says. The mirror already compared CONTENT
      // before this storage was ever pointed at the folder, so matching lengths here is confirming
      // that nothing moved since, not deciding the files are right in the first place.
      try {
        const root = rootOr('check')
        for (const meta of entry.files) {
          const file = await fileAt(root, meta.path)
          if (file.size !== meta.size) return STORAGE_NEED_FULL_CHECK
        }
        return STORAGE_NO_ERROR
      } catch {
        return STORAGE_NEED_FULL_CHECK
      }
    },

    deleteFiles: async (id, flags) => {
      const entry = native.get(id)
      if (!entry) return opfs.deleteFiles!(id, flags)
      // THE USER'S FILES ARE NOT OURS TO DELETE. This backend exists because their copy is the one
      // that survived; the whole point of pointing a torrent at it was to stop keeping a second one.
      // `removeTorrent(handle, true)` is a routine call that means "delete the download", and on
      // every other storage it does exactly that. Here it must reach nothing. Returning quietly is
      // deliberate: throwing would surface as a disk error on a torrent that is being removed anyway.
    },

    release: async (id) => { if (!native.has(id)) await opfs.release!(id) },
    stop: async (id) => { if (!native.has(id)) await opfs.stop!(id) },
  }
}
