// libtorrent stops a torrent on one failed disk operation, and a worker on its way out can
// still hold the SyncAccessHandle lock, making createSyncAccessHandle throw NoModificationAllowedError.

import type { StorageBackend } from 'libtorrent-wasm/types'

import { OPFSStorage, STORAGE_NEED_FULL_CHECK } from 'libtorrent-wasm/opfs'

const RETRY_DELAYS = [50, 150, 400, 900, 1_500]

const isFatal = (error: unknown) => (error as { name?: string })?.name === 'QuotaExceededError'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const createResilientStorage = (): StorageBackend => {
  const storage = new OPFSStorage()
  // a retry re-opens with create:true, so it must not run inside a delete or it orphans the file
  const dying = new Set<number>()

  const evictHandle = (id: number, fileIndex: number) => {
    const entry = (storage as unknown as { storages?: Map<number, { files?: Map<number, { close: () => void }> }> }).storages?.get(id)
    const handle = entry?.files?.get(fileIndex)
    if (!handle) return
    entry!.files!.delete(fileIndex)
    try { handle.close() } catch { }
  }

  const retryAfter = async <T>(id: number, fileIndex: number, op: () => T | Promise<T>, first: unknown): Promise<T> => {
    let last = first
    for (const delay of RETRY_DELAYS) {
      if (isFatal(last)) break
      evictHandle(id, fileIndex)
      await sleep(delay)
      if (dying.has(id)) throw last
      try { return await op() } catch (error) { last = error }
    }
    throw last
  }

  // MUST stay sync-or-promise: a sync success returns directly, which is the streaming hot path
  const guard = <T>(id: number, fileIndex: number, op: () => T | Promise<T>): T | Promise<T> => {
    try {
      const result = op()
      if (result instanceof Promise) return result.catch((error) => retryAfter(id, fileIndex, op, error))
      return result
    } catch (error) {
      return retryAfter(id, fileIndex, op, error)
    }
  }

  return {
    onNewStorage: (id, savePath, files) => {
      dying.delete(id)
      return guard(id, -1, () => storage.onNewStorage(id, savePath, files)) as void | Promise<void>
    },
    onRemoveStorage: (id) => { dying.add(id); return storage.onRemoveStorage(id) },
    read: (id, fileIndex, offset, len) => guard(id, fileIndex, () => storage.read(id, fileIndex, offset, len)),
    write: (id, fileIndex, offset, bytes) => guard(id, fileIndex, () => storage.write(id, fileIndex, offset, bytes)),
    // release and stop are routine, so they must not mark the storage dying
    release: (id) => storage.release(id),
    // a rejection reaches the engine as a disk error and stops the torrent
    check: (id) => storage.check(id).catch(() => STORAGE_NEED_FULL_CHECK),
    deleteFiles: (id, flags) => { dying.add(id); return storage.deleteFiles(id, flags) },
    stop: (id) => storage.stop(id),
  }
}
