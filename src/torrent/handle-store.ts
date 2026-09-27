import { del, get, set } from 'idb-keyval'

/**
 * FileSystemHandles kept in IndexedDB, and read back from this page's memory whenever it has them.
 *
 * Chrome 153.0.8010.47 (measured 2026-09-27) kills the whole browser with SIGTRAP, a CHECK in its
 * in-memory IndexedDB store, when a stored FileSystemHandle is READ back in an off-the-record profile:
 * an incognito window, or Playwright's `browser.newContext()`. The `put` works; the `get`, `getAll`
 * or cursor that returns it does not. Reportedly Chromium issue 562119515. Incognito cannot be
 * detected reliably, so the page cannot skip the read everywhere. What it can skip is the read it
 * never needed: of a handle it stored itself and still holds.
 *
 * So what is stored here is also remembered, and a load answers from memory first. IndexedDB is read
 * only when this page holds nothing for the key, which is after a reload or for a handle another tab
 * stored. Those reads still crash an incognito window on 153, and nothing on this side prevents it.
 *
 * Memory is what this page last wrote, not a live view of the store: another tab, or the engine's
 * worker on a removal, replacing or deleting a key is not seen here. That is what a page that never
 * unmounted already saw, since nothing re-reads these keys while it is mounted; memory only carries
 * it across a remount.
 */

const held = new Map<string, FileSystemHandle>()

/**
 * Stores `handle` under `key`, then remembers it for this page.
 *
 * Remembered only once IndexedDB has accepted it, so memory never holds a handle the store refused:
 * a `DataCloneError` (a wrapped pick with no disk entry behind it) rejects exactly as `set` does and
 * leaves nothing behind, which is what a caller deciding whether the pick can be re-opened relies on.
 */
export const storeHandle = async (key: string, handle: FileSystemHandle): Promise<void> => {
  await set(key, handle)
  held.set(key, handle)
}

/**
 * The handle for `key`: the one this page stored, or else the one in IndexedDB.
 *
 * The IndexedDB read is the one that crashes Chrome 153 off the record; see the module note.
 */
export const loadHandle = async <T extends FileSystemHandle>(key: string): Promise<T | undefined> =>
  (held.get(key) as T | undefined) ?? await get<T>(key)

/** Forgets `key` in memory and in IndexedDB. */
export const forgetHandle = async (key: string): Promise<void> => {
  held.delete(key)
  await del(key)
}
