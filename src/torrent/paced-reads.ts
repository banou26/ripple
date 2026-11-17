import type { StorageBackend } from 'libtorrent-wasm/types'

/**
 * How long the engine may read in one go before a read is answered on the next turn.
 *
 * The engine's tick runs ready work until none is left, and a read answered at once makes a check's next piece ready
 * straight away, so a check of files already in browser storage ran as one tick of 2.1 to 2.9 s per GiB, during which
 * nothing else in the worker ran: no state report for any torrent, and no socket served. Measured 2026-11-18 on a 16
 * thread desktop, in 20 ms slices the reports kept their 500 ms beat (0.58 s apart at most) and the check ran as fast
 * as in one tick, 1.7 to 2.7 s per GiB for 1 MiB down to 64 KiB pieces; 100 ms slices checked 64 KiB pieces at 3.6 to
 * 4.1 s per GiB.
 */
export const READ_SLICE_MS = 20

/**
 * `storage` with its reads answered through a promise once one stretch of them has run for `READ_SLICE_MS`: the
 * engine takes a promised read after its tick returns, which ends the tick. Every other call is `storage`'s own.
 */
export const pacedReads = <T extends StorageBackend>(storage: T, now = () => performance.now()): T => {
  let since: number | undefined
  return {
    ...storage,
    read: (id, fileIndex, offset, len) => {
      const at = now()
      if (since === undefined) {
        since = at
        // a microtask runs once the engine's tick has returned, never inside it
        queueMicrotask(() => { since = undefined })
      }
      const bytes = storage.read(id, fileIndex, offset, len)
      return at - since < READ_SLICE_MS ? bytes : Promise.resolve(bytes)
    },
  }
}
