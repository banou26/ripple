/*
 * The one property `regular-profile.ts` exists for, asserted on its own: a FileSystemHandle stored in
 * IndexedDB reads back out in the profile the create specs run in.
 *
 * In Playwright's stock context this crashes Chrome 153 outright (see regular-profile.ts), so when
 * the create specs fail at "Create and start sharing", this names the reason instead of eight
 * timeouts that look like the app.
 */
import { expect, test } from './regular-profile'

test('a FileSystemHandle stored in IndexedDB reads back out in the profile these specs use', async ({ page }) => {
  // a blank page on the served origin, so no engine or worker runs and nothing else touches storage
  await page.route('**/regular-profile-probe', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>probe</title>' }))
  await page.goto('/regular-profile-probe')

  const readBack = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('regular-profile-probe')
      open.onupgradeneeded = () => open.result.createObjectStore('handles')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const inStore = <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction('handles', mode)
        const request = run(tx.objectStore('handles'))
        tx.oncomplete = () => resolve(request.result)
        tx.onerror = () => reject(tx.error)
      })
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('regular-profile-probe', { create: true })
    await inStore('readwrite', (store) => store.put(dir, 'dir'))
    const back = await inStore<FileSystemDirectoryHandle>('readonly', (store) => store.get('dir'))
    return { kind: back.kind, name: back.name, same: await back.isSameEntry(dir) }
  })

  expect(readBack).toEqual({ kind: 'directory', name: 'regular-profile-probe', same: true })
})
