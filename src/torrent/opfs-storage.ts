// libtorrent stops a torrent on one failed disk operation, and a worker on its way out can
// still hold the SyncAccessHandle lock, making createSyncAccessHandle throw NoModificationAllowedError.

import type { StorageBackend } from 'libtorrent-wasm/types'

import { OPFSStorage, STORAGE_NEED_FULL_CHECK } from 'libtorrent-wasm/opfs'
import { createSyncAccessHandle as held, write } from '@banou/ponyfill/file-system'

const RETRY_DELAYS = [50, 150, 400, 900, 1_500]

export const isFatal = (error: unknown) => (error as { name?: string })?.name === 'QuotaExceededError'

/**
 * Asked before a write grows what libtorrent's storage `id` is charged, by `growth` bytes. False refuses the write as
 * the browser refuses one for want of room, so the engine stops the torrent the same way.
 */
export type Admit = (id: number, growth: number) => boolean

/** Throws the browser's own refusal when `admit` declines what a write grows its file by. */
export const admitWrite = (admit: Admit | undefined, id: number, growth: number) => {
  if (growth > 0 && admit && !admit(id, growth)) throw new DOMException('kept for temporary films', 'QuotaExceededError')
}

// a worker-only call the DOM typings do not carry
type SyncAccessible = { createSyncAccessHandle: () => Promise<FileSystemSyncAccessHandle> }

/** `@banou/ponyfill`'s call, which holds `file` until Chrome answers, typed for a handle the DOM typings know. */
export const createSyncAccessHandle = (file: FileSystemFileHandle) => held(file as unknown as SyncAccessible)

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
  /** Bytes the origin is charged for the torrent last mounted at `savePath`, or null when none is. */
  usageOf: (savePath: string) => Promise<number | null>
  /**
   * Bytes the origin is charged for libtorrent's storage `id` (`TorrentFiles.storageIndex`), or for its file
   * `fileIndex` alone, or null when its bytes are not in browser storage. By id because every torrent added from a
   * .torrent shares one save path.
   */
  usageOfStorage: (id: number, fileIndex?: number) => Promise<number | null>
  /**
   * The file of storage `id` whose write the browser last refused for want of room, held until the torrent is
   * mounted again, or undefined when none was.
   */
  refusedFile: (id: number) => number | undefined
}

export const createResilientStorage = (admit?: Admit): MeasurableStorage => {
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
  const usageOfStorage = async (id: number, only?: number): Promise<number | null> => {
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

  const usageOf = async (savePath: string): Promise<number | null> => {
    const id = idBySavePath.get(savePath)
    return id === undefined ? null : usageOfStorage(id)
  }

  const retry = retrying(dying)
  const guard = <T>(id: number, fileIndex: number, op: () => T | Promise<T>): T | Promise<T> =>
    retry(id, () => evictHandle(id, fileIndex), op)

  const writeAt = (id: number, fileIndex: number, offset: number, bytes: Uint8Array) => {
    const put = (handle: FileSystemSyncAccessHandle) => {
      try {
        admitWrite(admit, id, offset + bytes.length - handle.getSize())
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
    usageOfStorage,
    refusedFile: (id) => refused.get(id),
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
