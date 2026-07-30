// OPFS reads and writes that survive a transient failure.
//
// libtorrent treats one failed disk operation as a fatal storage error and stops the
// torrent, so the cost of a single unlucky call is the whole download. OPFS invites
// exactly that: a file's SyncAccessHandle is an exclusive lock, and a worker that is
// going away (a route change tears one down and starts another) can still hold it for a
// moment, which makes createSyncAccessHandle throw NoModificationAllowedError. Retrying
// over ~3s turns that hand-off into a short pause instead of a stopped torrent.

import type { StorageBackend } from 'libtorrent-wasm/types'

import { OPFSStorage } from 'libtorrent-wasm/opfs'

const RETRY_DELAYS = [50, 150, 400, 900, 1_500]

// A full disk cannot clear itself inside the retry window; everything else (a lock still
// held by a worker that is on its way out, a handle closed underneath us) usually does.
const isFatal = (error: unknown) => (error as { name?: string })?.name === 'QuotaExceededError'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type ResilientStorage = StorageBackend & {
  // Fires once per operation that failed every retry, i.e. once per error libtorrent
  // is about to stop a torrent over.
  onError: (cb: (message: string) => void) => void
}

export const createResilientStorage = (): ResilientStorage => {
  const storage = new OPFSStorage()
  let report: (message: string) => void = () => {}
  // Storages that are being torn down. A retry sleeps for up to three seconds and then
  // re-opens the file with create:true, which lands squarely inside a delete and either
  // makes removeEntry fail on the lock or recreates the file just after it went. Removing
  // a torrent is the only way to reclaim its bytes, so that orphan would be permanent.
  const dying = new Set<number>()

  // Drop the cached handle for a file whose operation just failed, so the retry re-opens
  // it rather than hitting the same dead handle again.
  const evictHandle = (id: number, fileIndex: number) => {
    const entry = (storage as unknown as { storages?: Map<number, { files?: Map<number, { close: () => void }> }> }).storages?.get(id)
    const handle = entry?.files?.get(fileIndex)
    if (!handle) return
    entry!.files!.delete(fileIndex)
    try { handle.close() } catch { /* already gone */ }
  }

  const retryAfter = async <T>(id: number, fileIndex: number, op: () => T | Promise<T>, first: unknown): Promise<T> => {
    let last = first
    for (const delay of RETRY_DELAYS) {
      if (isFatal(last)) break
      evictHandle(id, fileIndex)
      await sleep(delay)
      // The torrent went away while this was sleeping. Still throw, so the engine's own
      // job does not leak, but say nothing: the user asked for this.
      if (dying.has(id)) throw last
      try { return await op() } catch (error) { last = error }
    }
    if (dying.has(id)) throw last
    report(String((last as { message?: string })?.message ?? last))
    throw last
  }

  // Keeps the library's synchronous fast path intact: an operation that succeeds without
  // touching a promise still returns its value directly, which is the streaming hot path.
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
    // release and stop are routine (a pause, a finish, a teardown) and only close cached
    // handles, so they must not mark the storage dying: aborting a retry there would
    // report a disk error to the engine and stop the torrent, the exact failure this
    // module exists to prevent.
    release: (id) => storage.release(id),
    check: (id) => storage.check(id),
    deleteFiles: (id, flags) => { dying.add(id); return storage.deleteFiles(id, flags) },
    stop: (id) => storage.stop(id),
    onError: (cb) => { report = cb },
  }
}
