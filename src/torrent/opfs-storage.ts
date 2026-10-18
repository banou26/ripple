// libtorrent stops a torrent on one failed disk operation, and a worker on its way out can
// still hold the SyncAccessHandle lock, making createSyncAccessHandle throw NoModificationAllowedError.

import type { StorageBackend } from 'libtorrent-wasm/types'

import { OPFSStorage, STORAGE_NEED_FULL_CHECK } from 'libtorrent-wasm/opfs'
import { write } from '@banou/ponyfill/file-system'

const RETRY_DELAYS = [50, 150, 400, 900, 1_500]

export const isFatal = (error: unknown) => (error as { name?: string })?.name === 'QuotaExceededError'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run a disk operation, and on a failure that is not a refusal for room, drop the handles it used
 * and try again a few times, unless the storage is being deleted (`dying`). Sync in, sync out: a
 * sync success returns directly, which is the streaming hot path.
 */
export const retrying = (dying: Set<number>) => {
  const retryAfter = async <T>(id: number, evict: () => void, op: () => T | Promise<T>, first: unknown): Promise<T> => {
    let last = first
    for (const delay of RETRY_DELAYS) {
      if (isFatal(last)) break
      evict()
      await sleep(delay)
      if (dying.has(id)) throw last
      try { return await op() } catch (error) { last = error }
    }
    throw last
  }
  return <T>(id: number, evict: () => void, op: () => T | Promise<T>): T | Promise<T> => {
    try {
      const result = op()
      if (result instanceof Promise) return result.catch((error) => retryAfter(id, evict, op, error))
      return result
    } catch (error) {
      return retryAfter(id, evict, op, error)
    }
  }
}

/**
 * OPFSStorage's own bookkeeping, reached into rather than re-derived.
 *
 * Three things here need it and none has a public equivalent: dropping one cached handle so a
 * retry can re-open it, measuring what a torrent actually occupies, and writing through
 * `@banou/ponyfill`, whose `write` turns Firefox's short count into the `QuotaExceededError`
 * Chromium throws. The clean home for all three is the library, and moving them there is a
 * dependency release away.
 */
type StorageInternals = {
  storages?: Map<number, {
    rootDir?: FileSystemDirectoryHandle
    files?: Map<number, { close: () => void, getSize: () => number }>
    fileMeta?: Array<{ path: string, size: number }>
  }>
  openFile: (id: number, fileIndex: number) => FileSystemSyncAccessHandle | Promise<FileSystemSyncAccessHandle>
}

/** Adds the queries the engine needs that a plain StorageBackend does not carry. */
export type MeasurableStorage = StorageBackend & {
  /**
   * Bytes the origin is charged for everything under `savePath`, or for its file `fileIndex` alone,
   * or null when it is not mounted.
   */
  usageOf: (savePath: string, fileIndex?: number) => Promise<number | null>
  /**
   * The file under `savePath` whose write the browser last refused for want of room, held until the
   * torrent is mounted again, or undefined when none was.
   */
  refusedFile: (savePath: string) => number | undefined
}

export const createResilientStorage = (): MeasurableStorage => {
  const storage = new OPFSStorage()
  // a retry re-opens with create:true, so it must not run inside a delete or it orphans the file
  const dying = new Set<number>()
  // libtorrent hands JS a storage id, Ripple knows torrents by their save path, and one add is the
  // only place the two are ever seen together
  const idBySavePath = new Map<string, number>()
  const refused = new Map<number, number>()

  const internals = storage as unknown as StorageInternals

  const evictHandle = (id: number, fileIndex: number) => {
    const entry = internals.storages?.get(id)
    const handle = entry?.files?.get(fileIndex)
    if (!handle) return
    entry!.files!.delete(fileIndex)
    try { handle.close() } catch { }
  }

  /**
   * What the quota system is charged for one torrent.
   *
   * Measured, never inferred from how much has been downloaded: OPFS charges a file's EXTENT, and a
   * positional write past the end zero-fills everything before it. A streamed video has its tail
   * written seconds after it opens, because that is where the container index lives, so a barely
   * watched episode is charged its full size.
   *
   * `getSize()` on the handle the engine already holds, never `getFile()`: that takes a shared lock
   * a live SyncAccessHandle holds exclusively, which is why the library's own `check()` releases
   * first. Only files with no open handle fall back to it.
   */
  const usageOf = async (savePath: string, only?: number): Promise<number | null> => {
    const id = idBySavePath.get(savePath)
    if (id === undefined) return null
    const entry = internals.storages?.get(id)
    if (!entry?.fileMeta || !entry.rootDir) return null
    let total = 0
    for (let fileIndex = 0; fileIndex < entry.fileMeta.length; fileIndex++) {
      if (only !== undefined && fileIndex !== only) continue
      const open = entry.files?.get(fileIndex)
      if (open) {
        try { total += open.getSize(); continue } catch { /* closing under us: fall through */ }
      }
      const segments = entry.fileMeta[fileIndex]!.path.split('/').filter(Boolean)
      const name = segments.pop()
      if (!name) continue
      let dir: FileSystemDirectoryHandle | null = entry.rootDir
      for (const segment of segments) dir = dir ? await dir.getDirectoryHandle(segment).catch(() => null) : null
      if (!dir) continue
      // absent is the ordinary answer for a file nothing has written yet
      total += await dir.getFileHandle(name).then((fh) => fh.getFile()).then((f) => f.size).catch(() => 0)
    }
    return total
  }

  const retry = retrying(dying)
  const guard = <T>(id: number, fileIndex: number, op: () => T | Promise<T>): T | Promise<T> =>
    retry(id, () => evictHandle(id, fileIndex), op)

  const writeAt = (id: number, fileIndex: number, offset: number, bytes: Uint8Array) => {
    const put = (handle: FileSystemSyncAccessHandle) => {
      try {
        write(handle, bytes, { at: offset })
      } catch (error) {
        if (isFatal(error)) refused.set(id, fileIndex)
        throw error
      }
    }
    const handle = internals.openFile(id, fileIndex)
    return handle instanceof Promise ? handle.then(put) : put(handle)
  }

  return {
    usageOf,
    refusedFile: (savePath) => {
      const id = idBySavePath.get(savePath)
      return id === undefined ? undefined : refused.get(id)
    },
    onNewStorage: (id, savePath, files) => {
      dying.delete(id)
      refused.delete(id)
      idBySavePath.set(savePath, id)
      return guard(id, -1, () => storage.onNewStorage(id, savePath, files))
    },
    onRemoveStorage: (id) => {
      dying.add(id)
      for (const [savePath, mounted] of idBySavePath) if (mounted === id) idBySavePath.delete(savePath)
      return storage.onRemoveStorage(id)
    },
    read: (id, fileIndex, offset, len) => guard(id, fileIndex, () => storage.read(id, fileIndex, offset, len)),
    write: (id, fileIndex, offset, bytes) => guard(id, fileIndex, () => writeAt(id, fileIndex, offset, bytes)),
    // release and stop are routine, so they must not mark the storage dying
    release: (id) => storage.release(id),
    // a rejection reaches the engine as a disk error and stops the torrent
    check: (id) => storage.check(id).catch(() => STORAGE_NEED_FULL_CHECK),
    deleteFiles: (id, flags) => { dying.add(id); return storage.deleteFiles(id, flags) },
    stop: (id) => storage.stop(id),
  }
}
