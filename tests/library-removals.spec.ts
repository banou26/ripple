/*
 * A torrent removed from the library stays removed when a stale copy of the list comes back.
 *
 * The cloud backup is merged and never overwritten, so the list a restore imports can still carry an
 * entry this browser removed. The owner's report, 2026-09-12, with ripple on two origins sharing one
 * library: Sintel, removed on either, was back as "Files aren't on this device" after every reload.
 *
 * The rules are unit tested in tests/torrent/library.test.ts. This drives the real engine worker, the
 * way the page's sync does, to prove the wiring: that a removal is written down where the sync reads
 * it, and that an import honours both this browser's removals and the ones the cloud hands over.
 *
 * No network and no transfer: every entry is a row with nothing running, so this is headless.
 */
import { expect, test } from '@playwright/test'

type Entry = { infoHash: string }

const probe = () => {
  const w = window as any
  w.__lists = [] as Entry[][]
  w.__engine = null
  const Original = window.Worker
  class Probe extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.addEventListener('message', (event: MessageEvent) => {
        const data = event.data
        if (!data || typeof data !== 'object') return
        // the engine worker is the only one that speaks this protocol; libav's never does
        if (data.type === 'ready' || data.type === 'state') w.__engine = this
        if (data.type === 'list') w.__lists.push(data.list)
      })
    }
  }
  window.Worker = Probe
  // the demo would add a torrent of its own eight seconds in
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
}

/** One key of the raw idb-keyval store, which is where the worker keeps the list and the removals. */
const stored = (key: string) => new Promise<unknown>((resolve) => {
  const request = indexedDB.open('keyval-store')
  request.onerror = () => resolve('open failed')
  request.onsuccess = () => {
    const read = request.result.transaction('keyval', 'readonly').objectStore('keyval').get(key)
    read.onsuccess = () => resolve(read.result)
    read.onerror = () => resolve('read failed')
  }
})

const put = ([key, value]: [string, unknown]) => new Promise<string>((resolve) => {
  const request = indexedDB.open('keyval-store')
  request.onerror = () => resolve('open failed')
  request.onsuccess = () => {
    const tx = request.result.transaction('keyval', 'readwrite')
    tx.objectStore('keyval').put(value, key)
    tx.oncomplete = () => resolve('put')
    tx.onerror = () => resolve('put failed')
  }
})

const REMOVED = 'c'.repeat(40)
const OTHER = 'd'.repeat(40)
const ghost = (infoHash: string, addedAt: number) =>
  ({ infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/dl/' + infoHash, addedAt })

test('a removed torrent stays removed through a stale list, and comes back when added again', async ({ page }) => {
  test.setTimeout(180_000)
  await page.addInitScript(probe)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__engine, undefined, { timeout: 90_000 })

  const send = (message: object) => page.evaluate((m) => (window as any).__engine.postMessage(m), message)
  // the worker runs commands one at a time, so a later list naming `hash` proves every earlier one ran
  const listed = (hash: string, present: boolean) => page.waitForFunction(
    ([h, want]) => {
      const lists = (window as any).__lists as Entry[][]
      const last = lists[lists.length - 1]
      return !!last && last.some((e) => e.infoHash === h) === want
    },
    [hash, present] as const,
    { timeout: 30_000 },
  )
  const hashes = () => page.evaluate(() => {
    const lists = (window as any).__lists as Entry[][]
    return (lists[lists.length - 1] ?? []).map((e) => e.infoHash)
  })

  // the control: an import lands, so everything below is measuring removals and not a dead handler
  await send({ type: 'import-list', list: [ghost(REMOVED, 1_000)], removed: [] })
  await listed(REMOVED, true)

  // the removal the person makes, and the record the sync publishes
  await send({ type: 'remove-missing', infoHash: REMOVED })
  await listed(REMOVED, false)
  const removals = await page.evaluate(stored, 'ripple:removed') as { infoHash: string, removedAt: number }[] | undefined
  expect(removals?.find((r) => r.infoHash === REMOVED)?.removedAt, 'the removal was not written down, so no write can carry it').toBeGreaterThan(1_000)

  // THE REGRESSION: the cloud still lists it. OTHER rides along so its arrival proves the import ran.
  await send({ type: 'import-list', list: [ghost(REMOVED, 1_000), ghost(OTHER, 1_000)], removed: [] })
  await listed(OTHER, true)
  expect(await hashes(), 'a stale list put the removed torrent back').not.toContain(REMOVED)

  // added again after the removal, which wins
  await send({ type: 'import-list', list: [ghost(REMOVED, Date.now() + 60_000)], removed: [] })
  await listed(REMOVED, true)

  // a removal made on another device, handed over with the list, takes the row this browser holds
  // and the picture a restore fetched for it, which no page action is left to drop
  expect(await page.evaluate(put, ['ripple:thumb:' + OTHER, 'a picture'] as [string, unknown])).toBe('put')
  await send({ type: 'import-list', list: [], removed: [{ infoHash: OTHER, removedAt: Date.now() + 120_000 }] })
  await listed(OTHER, false)
  expect(await hashes()).toContain(REMOVED)
  expect(await page.evaluate(stored, 'ripple:thumb:' + OTHER), 'the picture outlived its row').toBeUndefined()

  // an account switch starts clean, or the last account's removals would hide the next one's torrents
  await send({ type: 'clear-list' })
  await listed(REMOVED, false)
  expect(await page.evaluate(stored, 'ripple:removed')).toBeUndefined()
})
