// What no unit test can check: that the engine really gives up a cache torrent's bytes when the
// origin runs short, that it never gives up one someone is watching, and that it never touches a
// torrent the user added themselves.
//
// The origin is squeezed with a SPARSE OPFS write, which costs nothing to make: the quota system
// charges a file's extent, so one byte written a gigabyte in is a gigabyte charged, instantly. That
// is the same accounting that makes a barely watched episode cost its full size on disk, which is
// what the eviction budget exists to handle.

import { expect, test } from '@playwright/test'

// the bundled demo: instant metadata and a webseed that carries the download with no swarm at all
const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const SINTEL_HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
// Sintel/Sintel.mp4, 129,241,752 bytes. Index 0 is a subtitle track, and pointing the player at
// that one leaves the stream window skipping every other file, so almost nothing is ever written.
const SINTEL_VIDEO = 5
const SINTEL_VIDEO_BYTES = 129_241_752
// the video plus ten subtitle tracks and a poster, rounded up
const SINTEL_TORRENT_BYTES = 129_300_000

const embedUrl = (magnet: string) => `/embed?magnet=${Buffer.from(magnet).toString('base64')}&fileIndex=${SINTEL_VIDEO}`

test.use({ headless: false })

type Page = Parameters<Parameters<typeof test>[1]>[0]['page']

const estimate = (page: Page) =>
  page.evaluate(async () => {
    const e = await navigator.storage.estimate()
    return { used: e.usage ?? 0, quota: e.quota ?? 0 }
  })

/** The engine's own library index, read straight out of idb-keyval's store. */
const library = (page: Page) =>
  page.evaluate(() => new Promise<any[]>((resolve) => {
    const open = indexedDB.open('keyval-store')
    open.onsuccess = () => {
      const db = open.result
      const request = db.transaction('keyval').objectStore('keyval').get('ripple:torrents')
      request.onsuccess = () => resolve((request.result as any[]) ?? [])
      request.onerror = () => resolve([])
    }
    open.onerror = () => resolve([])
  }))

/**
 * The payload files under one torrent's save path, walked recursively: a multi-file torrent puts
 * its files in a folder of its own inside the save path, so counting only that path's direct
 * children reports every torrent as holding nothing at all.
 *
 * `bytes` skips any file the engine still holds a sync access handle for, because getFile() takes a
 * lock that handle owns exclusively. `count` never does, which is why the eviction assertions are
 * written against it: a file that has been deleted has no entry to find at all.
 */
const filesUnder = (page: Page, savePath: string) =>
  page.evaluate(async (path: string) => {
    let dir = await navigator.storage.getDirectory()
    for (const segment of path.split('/').filter(Boolean)) {
      const next = await dir.getDirectoryHandle(segment).catch(() => null)
      if (!next) return { count: 0, bytes: 0 }
      dir = next
    }
    const walk = async (handle: any): Promise<{ count: number, bytes: number }> => {
      let count = 0
      let bytes = 0
      for await (const child of handle.values()) {
        if (child.kind !== 'file') {
          const inner = await walk(child)
          count += inner.count
          bytes += inner.bytes
          continue
        }
        count += 1
        bytes += await child.getFile().then((f: File) => f.size).catch(() => 0)
      }
      return { count, bytes }
    }
    return walk(dir)
  }, savePath)

/**
 * Charge the origin until only `freeBytes` are left, with sparse writes the engine cannot reclaim.
 *
 * Chunked, and checked after every chunk. One write covering the whole remaining budget comes back
 * SHORT rather than throwing, so a single-shot version reports success having written nothing at
 * all, and every assertion after it then measures an origin under no pressure whatsoever.
 */
const CHUNK = 256 * 1024 * 1024

const squeezeTo = async (page: Page, freeBytes: number) => {
  for (let chunk = 0; chunk < 64; chunk++) {
    const before = await estimate(page)
    const want = before.quota - before.used - freeBytes
    if (want <= 0) return before
    const size = Math.min(want, CHUNK)
    await page.evaluate(async ([name, bytes]: [string, number]) => {
      const code = `self.onmessage = async (e) => {
        const [name, size] = e.data
        try {
          const root = await navigator.storage.getDirectory()
          const file = await root.getFileHandle(name, { create: true })
          const handle = await file.createSyncAccessHandle()
          const wrote = handle.write(new Uint8Array(1), { at: size - 1 })
          handle.flush()
          const got = handle.getSize()
          handle.close()
          postMessage({ wrote, got })
        } catch (err) { postMessage({ error: String(err) }) }
      }`
      const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })))
      const result = await new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data)
        worker.postMessage([name, bytes])
      })
      worker.terminate()
      return result
    }, [`ripple-test-padding-${chunk}.bin`, size] as [string, number])
    const after = await estimate(page)
    if (after.used <= before.used) throw new Error(`padding did not land: ${JSON.stringify({ before, after, size })}`)
  }
  return estimate(page)
}

/** Wait for the demo torrent to have written a real amount of data. */
const downloadSome = async (page: Page, atLeast: number) => {
  const baseline = (await estimate(page)).used
  await expect.poll(
    async () => (await estimate(page)).used - baseline,
    { timeout: 120_000, intervals: [2_000] },
  ).toBeGreaterThan(atLeast)
}

/** Write a sparse file at `path`, creating every directory on the way. */
const plant = (page: Page, path: string, bytes: number) =>
  page.evaluate(async ([target, size]: [string, number]) => {
    const code = `self.onmessage = async (e) => {
      const [path, size] = e.data
      const parts = path.split('/').filter(Boolean)
      const name = parts.pop()
      let dir = await navigator.storage.getDirectory()
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
      const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle()
      handle.write(new Uint8Array(1), { at: size - 1 })
      handle.flush()
      handle.close()
      postMessage('done')
    }`
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })))
    await new Promise((resolve) => { worker.onmessage = resolve; worker.postMessage([target, size]) })
    worker.terminate()
  }, [path, bytes] as [string, number])

const exists = (page: Page, path: string) =>
  page.evaluate(async (target: string) => {
    let dir = await navigator.storage.getDirectory()
    for (const segment of target.split('/').filter(Boolean)) {
      const next = await dir.getDirectoryHandle(segment).catch(() => null)
      if (!next) return false
      dir = next
    }
    return true
  }, path)

test.describe('orphan sweep', () => {
  test('removes storage the library has no record of, and keeps what it does', async ({ page }) => {
    test.setTimeout(240_000)

    await page.goto('/')
    await expect(page.locator('.torrent').first()).toBeVisible()
    // let the demo publish its layout, which is what lets the shared root be accounted for at all
    await downloadSome(page, 5_000_000)
    const entries = await library(page)
    expect(entries).toHaveLength(1)
    const kept = entries[0].savePath === '/dl' ? '/dl/Sintel' : entries[0].savePath
    expect(await exists(page, kept)).toBe(true)

    // a per-torrent directory for a torrent that is not in the list, and a release folder in the
    // shared root that nothing claims: the two shapes an orphan comes in
    const PLANTED = 500_000_000
    await plant(page, '/dl/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Ghost/ghost.mkv', 300_000_000)
    await plant(page, '/dl/Some Orphaned Release/stray.mkv', 200_000_000)
    const before = await estimate(page)
    expect(await exists(page, '/dl/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true)
    expect(await exists(page, '/dl/Some Orphaned Release')).toBe(true)
    console.log('[test] planted, usage', before)

    await expect.poll(
      async () => [
        await exists(page, '/dl/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        await exists(page, '/dl/Some Orphaned Release'),
      ],
      { timeout: 150_000, intervals: [3_000], message: 'the orphans were never swept' },
    ).toEqual([false, false])

    // The bytes come back, and the torrent the library DOES know about is untouched. The demo keeps
    // downloading through the wait, so the drop is netted against the most it could possibly add,
    // which is the whole torrent.
    expect((await estimate(page)).used).toBeLessThan(before.used - (PLANTED - SINTEL_TORRENT_BYTES))
    expect(await exists(page, kept), 'a torrent the library records must survive the sweep').toBe(true)
    expect(await library(page)).toHaveLength(1)
  })
})

test.describe('storage eviction', () => {
  test('gives up an embed torrent nobody is watching, and reclaims its bytes', async ({ page }) => {
    test.setTimeout(240_000)

    // the player adds it, so it is a cache entry
    await page.goto(embedUrl(SINTEL))
    await downloadSome(page, 30_000_000)

    const entries = await library(page)
    expect(entries).toHaveLength(1)
    expect(entries[0].infoHash).toBe(SINTEL_HASH)
    expect(entries[0].ephemeral, 'a torrent the player asked for is a cache entry').toBe(true)
    expect(entries[0].savePath, 'a cache torrent owns its directory, so deleting it reaches nothing else')
      .toBe('/dl/' + SINTEL_HASH)

    // leave the player: nobody is watching it now
    await page.goto('/')
    await expect(page.locator('.torrent').first()).toBeVisible()
    const held = await filesUnder(page, '/dl/' + SINTEL_HASH)
    expect(held.count, 'the torrent should have written something').toBeGreaterThan(0)

    // Squeeze the origin so that giving this torrent up is exactly enough: the floor the engine
    // keeps free is 10% of the browser's budget, so leaving a little more free than the floor minus
    // the video's size puts the deficit inside one eviction.
    const squeezed = await squeezeTo(page, Math.round(SINTEL_VIDEO_BYTES * 1.6))
    console.log('[test] after squeeze:', squeezed, 'torrent holds', held)

    await expect.poll(
      async () => (await filesUnder(page, '/dl/' + SINTEL_HASH)).count,
      { timeout: 90_000, intervals: [2_000], message: 'the cache torrent never gave up its bytes' },
    ).toBe(0)
    expect(
      (await estimate(page)).used,
      'deleting the entries has to give the bytes back, not just the names',
    ).toBeLessThan(squeezed.used - 20_000_000)

    // the library row survives so it is not deleted off the user's other devices, and it goes back
    // to the same state a wiped site leaves: present, restartable, holding nothing
    const after = await library(page)
    expect(after).toHaveLength(1)
    expect(after[0].infoHash).toBe(SINTEL_HASH)
    expect(after[0].started).toBe(false)
  })

  test('never gives up a torrent the user added themselves', async ({ page }) => {
    test.setTimeout(240_000)

    const full: boolean[] = []
    await page.exposeFunction('__storageFull', (v: boolean) => { full.push(v) })
    await page.addInitScript(() => {
      const Original = window.Worker
      class Probe extends Original {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options)
          this.addEventListener('message', (event: MessageEvent) => {
            const data = event.data as { type?: string, full?: boolean } | null
            if (data?.type === 'storage-full') (window as any).__storageFull(!!data.full)
          })
        }
      }
      window.Worker = Probe as unknown as typeof Worker
    })

    // the library seeds the demo itself, through the deliberate .torrent path
    await page.goto('/')
    await expect(page.locator('.torrent').first()).toBeVisible()
    await downloadSome(page, 30_000_000)

    const entries = await library(page)
    expect(entries).toHaveLength(1)
    expect(entries[0].ephemeral, 'a torrent the user added is never a cache entry').toBe(false)
    const savePath = entries[0].savePath as string
    const held = await filesUnder(page, savePath)
    expect(held.count).toBeGreaterThan(0)

    const squeezed = await squeezeTo(page, 60_000_000)
    console.log('[test] after squeeze:', squeezed, 'library torrent holds', held)

    // give the budget pass several turns to do the wrong thing
    await page.waitForTimeout(45_000)
    // count only grows: an eviction takes every file at once and stamps the entry, so either alone
    // would be conclusive
    expect((await filesUnder(page, savePath)).count, 'a library torrent must never be auto-deleted')
      .toBeGreaterThanOrEqual(held.count)
    const after = await library(page)
    expect(after).toHaveLength(1)
    expect(after[0].started, 'nothing should have marked it as having lost its files').not.toBe(false)

    // and it says so, rather than stalling with no explanation anywhere
    expect(full, 'a full origin with nothing reclaimable has to be reported').toContain(true)
  })

  test('never gives up the torrent being watched', async ({ page }) => {
    test.setTimeout(240_000)

    await page.goto(embedUrl(SINTEL))
    await downloadSome(page, 30_000_000)

    const entries = await library(page)
    const savePath = entries[0].savePath as string
    expect(entries[0].ephemeral).toBe(true)
    const held = await filesUnder(page, savePath)
    expect(held.count).toBeGreaterThan(0)

    const squeezed = await squeezeTo(page, 60_000_000)
    console.log('[test] after squeeze:', squeezed)

    // still on /embed, so this torrent has a viewer for the whole wait
    await page.waitForTimeout(45_000)
    expect((await filesUnder(page, savePath)).count, 'the torrent being watched must never be evicted')
      .toBeGreaterThan(0)

    // and the player says why it is stuck instead of showing nothing. It goes in the same slot as
    // "Loading metadata…", which rides with the player's own controls, so it is there either way and
    // on screen as soon as anything wakes them.
    const notice = page.getByText(/Out of storage space/)
    await expect(notice).toHaveCount(1, { timeout: 30_000 })
    await page.mouse.move(400, 300)
    await expect(notice).toBeVisible()
  })
})
