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
 *
 * Re-measured on Chrome 151, 2026-08-30, same result and same control. `createWritable`'s newer
 * `mode: 'exclusive'` does not change it: that option governs locking, not swap files. Full detail
 * in save-location.ts.
 *
 * IT ALSO SERVES TORRENTS THE USER CREATED, out of the file or folder they picked to make one from.
 * Same reads, same read-only rule, and one difference that decides how they are resolved: those
 * handles are kept per torrent and looked up by `fileIndex` rather than by walking a reported path.
 * `SourceLookup` below says why at length; the short version is that the granted handle IS that
 * torrent's root directory, so a path-based resolver looks for `Pack/Pack/a.mkv` and finds nothing
 * while reporting no error.
 *
 * PER-FILE routing was considered and rejected, since read and write both take a `fileIndex` and the
 * table could perfectly well be keyed on one, which would let a finished file leave OPFS while the
 * rest of a pack downloads. What stops it is that PIECES SPAN FILE BOUNDARIES: a piece straddling a
 * moved file and a downloading one has to write to both, the moved half is read only by the finding
 * above, and libtorrent stops a torrent on a single failed disk operation (see opfs-storage.ts). The
 * payoff would be bounding a pack to one file, with nothing at all for a single large file.
 */

/** Save paths under here mean "the files are in the user's folder", not in OPFS. */
export const NATIVE_ROOT = '/native'

export const nativeSavePathFor = (infoHash: string) => `${NATIVE_ROOT}/${infoHash}`

export const isNativeSavePath = (savePath: string | undefined): boolean =>
  savePath === NATIVE_ROOT || !!savePath?.startsWith(NATIVE_ROOT + '/')

/**
 * Save paths under here mean "these are the files somebody picked to MAKE this torrent from".
 *
 * Separate from `/native` even though both read out of a granted handle, because the two differ in
 * what may be done to the files rather than in how they are read. A `/native` torrent's files are a
 * download Ripple wrote into the user's folder, so moving it back into browser storage is a
 * reasonable thing to offer. A `/source` torrent's files are the person's own originals that Ripple
 * has never written a byte of, and every copy, move, mirror, eviction and delete has to leave them
 * exactly where they are. Sharing one root would make that distinction a comment instead of a fact.
 */
export const SOURCE_ROOT = '/source'

export const sourceSavePathFor = (infoHash: string) => `${SOURCE_ROOT}/${infoHash}`

export const isSourceSavePath = (savePath: string | undefined): boolean =>
  savePath === SOURCE_ROOT || !!savePath?.startsWith(SOURCE_ROOT + '/')

/** Neither backend is OPFS, so neither is charged to the origin or reclaimed by the budget pass. */
export const isGrantedSavePath = (savePath: string | undefined): boolean =>
  isNativeSavePath(savePath) || isSourceSavePath(savePath)

/** Where the user's folder is right now, or null. A function because the grant comes and goes. */
export type FolderSource = () => FileSystemDirectoryHandle | null

/**
 * The files a created torrent was made from, one handle per file, INDEXED BY fileIndex.
 *
 * By index and not by path, which is the single most important decision in this file. Two reasons,
 * and either alone would settle it:
 *
 *  - libtorrent SANITISES path elements before reporting them, so the path in `session.files(h)` is
 *    not reliably the path that went into the info dict. Resolving a read by re-walking a reported
 *    path therefore works for ordinary names and fails for exactly the ones that need it most.
 *  - a created torrent's granted handle IS its own root directory, while every `/native` torrent has
 *    its root as a CHILD of the granted folder. So the same path string means different things in
 *    the two cases, and a resolver shared between them looks for `Pack/Pack/a.mkv`.
 *
 * That second mistake fails by reporting success, which is what makes it worth this much comment:
 * the file is simply not found, `check()` sees no file holding bytes, answers "nothing to verify",
 * and the torrent is added with an EMPTY have-set. It has no error, its row looks healthy, and it
 * serves nothing to anybody, forever.
 *
 * A `fileIndex` cannot drift like that. It is the position in the info dict's `files` list, which is
 * the order the metainfo was written in and the order the walk produced.
 */
export type SourceLookup = (savePath: string) => (FileSystemFileHandle | null)[] | null

type NativeStorage = { savePath: string, files: Array<{ path: string, size: number }> }
/**
 * `null` for the WHOLE array means no handles are registered for this torrent. `null` for one ENTRY
 * means that index is a PAD FILE: zeroes a hybrid or v2 torrent inserts to push the next file onto a
 * piece boundary, which has no file behind it and never had.
 */
type SourceStorage = NativeStorage & { handles: (FileSystemFileHandle | null)[] | null }

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

export const createHybridStorage = (
  opfs: MeasurableStorage,
  folder: FolderSource,
  sources: SourceLookup = () => null,
): MeasurableStorage => {
  const native = new Map<number, NativeStorage>()
  const source = new Map<number, SourceStorage>()

  const rootOr = (what: string): FileSystemDirectoryHandle => {
    const root = folder()
    // A grant is per session and comes back unpermitted after a reload until the user acts, so this
    // is an ordinary state rather than a broken one. It still has to be an error: the engine
    // stopping the torrent is right, and answering the read with anything else would mean serving
    // bytes we do not have.
    if (!root) throw new Error(`hybrid storage: no folder granted, cannot ${what}`)
    return root
  }

  /**
   * The one place a source read resolves a file, so the index rule above has a single home.
   *
   * Returns `null` for a PAD, which is not an error and not a missing file: a pad is zeroes by
   * definition, it is never written anywhere, and the caller answers the read with zeroes. That the
   * index space includes them is the whole reason the handle array carries a slot for each.
   */
  const sourceFileAt = async (entry: SourceStorage, fileIndex: number): Promise<File | null> => {
    // A source torrent is only ever added once its handles are registered, so this is a construction
    // error rather than a missing grant. Loud, because the alternative shape of this bug is a torrent
    // that reports nothing wrong and serves nothing.
    if (!entry.handles) throw new Error(`hybrid storage: ${entry.savePath} has no source handles registered`)
    if (entry.handles.length !== entry.files.length) {
      throw new Error(`hybrid storage: ${entry.savePath} has ${entry.handles.length} handles for ${entry.files.length} files`)
    }
    if (fileIndex < 0 || fileIndex >= entry.handles.length) {
      throw new Error(`hybrid storage: no source handle ${fileIndex} in ${entry.savePath}`)
    }
    return entry.handles[fileIndex]?.getFile() ?? null
  }

  return {
    usageOf: async (savePath) => {
      // the origin is not charged for the user's own files, and reporting their size as OPFS usage
      // would have the budget pass trying to reclaim space that was never taken
      if (isGrantedSavePath(savePath)) return 0
      return opfs.usageOf(savePath)
    },

    onNewStorage: (id, savePath, files) => {
      if (isSourceSavePath(savePath)) {
        source.set(id, { savePath, files, handles: sources(savePath) })
        return
      }
      if (!isNativeSavePath(savePath)) return opfs.onNewStorage(id, savePath, files)
      native.set(id, { savePath, files })
    },

    onRemoveStorage: (id) => {
      if (source.delete(id)) return
      if (!native.delete(id)) return opfs.onRemoveStorage(id)
    },

    read: (id, fileIndex, offset, len) => {
      const picked = source.get(id)
      if (picked) {
        return (async () => {
          const file = await sourceFileAt(picked, fileIndex)
          /*
           * A pad reads as zeroes, and is answered here rather than left to the engine.
           *
           * libtorrent's own storage returns zeroes for a pad without touching a disk, and Ripple's
           * engine replaces that storage wholesale, so the answer has to come from somewhere on this
           * side. Answering it here means a hybrid torrent is correct against whatever engine build
           * happens to be loaded rather than only against a fixed one.
           */
          if (!file) return new Uint8Array(len)
          const chunk = await file.slice(offset, offset + len).arrayBuffer()
          // same rule as the folder case below: a short read means the person's file is not what the
          // torrent says it is, and zeros would be served to a peer as real data
          if (chunk.byteLength < len) {
            throw new Error(`hybrid storage: source file ${fileIndex} of ${picked.savePath} ended early, wanted ${len} at ${offset}, got ${chunk.byteLength}`)
          }
          return new Uint8Array(chunk)
        })()
      }
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
      const picked = source.get(id)
      // Even louder than the folder case below. These are files somebody else made and pointed at,
      // and the only way to write to one is to rename a swap file over it.
      if (picked) {
        throw new Error(`hybrid storage: ${picked.savePath} is somebody's own files, refusing a write of ${bytes.length} at ${offset} in file ${fileIndex}`)
      }
      const entry = native.get(id)
      if (!entry) return opfs.write(id, fileIndex, offset, bytes)
      // Unreachable by construction, and loud rather than silent if the construction ever slips. A
      // torrent on this backend is added with `uploadMode`, so libtorrent never requests a piece and
      // never writes. There is also no way to honour it: `createWritable` would publish by renaming
      // over the user's file at close, which is the last thing anyone wants done to their own data.
      throw new Error(`hybrid storage: ${entry.savePath} is read only, refusing a write of ${bytes.length} at ${offset} in file ${fileIndex}`)
    },

    /**
     * `need_full_check` when there is data here, `no_error` when there is none, which reads backwards
     * until you know what libtorrent does with the answer.
     *
     * `no_error` means "there is nothing to verify", NOT "everything is fine". It is the answer for
     * an empty storage, and a torrent that gets it starts with an EMPTY have-set. That is exactly
     * wrong here: a torrent is pointed at this backend precisely because the files are already
     * present, it arrives with no resume data (the relocate deletes it, since the old have-set
     * described files somewhere else), and the only way it learns it holds anything is by hashing
     * them. So the answer that makes it seed is `need_full_check`, and the check that follows is
     * reads alone, no network.
     *
     * Same rule the OPFS backend uses, deliberately: any file holding bytes means check it.
     */
    check: async (id) => {
      const picked = source.get(id)
      if (picked) {
        /*
         * NEED_FULL_CHECK whatever happens, including when the handles are missing.
         *
         * The other answer, NO_ERROR, means "there is nothing to verify" and yields an EMPTY
         * have-set, so a torrent that got it would be added, look perfectly healthy, and serve
         * nothing. Asking for the check instead means the first read runs, and a read that cannot
         * be answered throws with a named reason and stops the torrent visibly. A loud stop beats a
         * quiet nothing, and the files were hashed a moment ago so the check is reads alone.
         */
        return STORAGE_NEED_FULL_CHECK
      }
      const entry = native.get(id)
      if (!entry) return opfs.check!(id)
      try {
        const root = rootOr('check')
        for (const meta of entry.files) {
          const file = await fileAt(root, meta.path).catch(() => null)
          if (file && file.size > 0) return STORAGE_NEED_FULL_CHECK
        }
        return STORAGE_NO_ERROR
      } catch {
        return STORAGE_NEED_FULL_CHECK
      }
    },

    deleteFiles: async (id, flags) => {
      // Nothing to say about it and nothing to do: the whole point of a source torrent is that these
      // bytes were never Ripple's. `removeTorrent(handle, true)` reaches here on an ordinary remove.
      if (source.has(id)) return
      const entry = native.get(id)
      if (!entry) return opfs.deleteFiles!(id, flags)
      // THE USER'S FILES ARE NOT OURS TO DELETE. This backend exists because their copy is the one
      // that survived; the whole point of pointing a torrent at it was to stop keeping a second one.
      // `removeTorrent(handle, true)` is a routine call that means "delete the download", and on
      // every other storage it does exactly that. Here it must reach nothing. Returning quietly is
      // deliberate: throwing would surface as a disk error on a torrent that is being removed anyway.
    },

    release: async (id) => { if (!native.has(id) && !source.has(id)) await opfs.release!(id) },
    stop: async (id) => { if (!native.has(id) && !source.has(id)) await opfs.stop!(id) },
  }
}
