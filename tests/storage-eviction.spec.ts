// What no unit test can check: that the engine really gives up a cache torrent's bytes when the
// origin runs short, that it never gives up one someone is watching, and that it never touches a
// torrent the user added themselves.
//
// The origin is squeezed with a SPARSE OPFS write, which costs nothing to make: the quota system
// charges a file's extent, so one byte written a gigabyte in is a gigabyte charged, instantly. That
// is the same accounting that makes a barely watched episode cost its full size on disk, which is
// what the eviction budget exists to handle.
//
// READ THIS BEFORE DEBUGGING A SKIP HERE. On some origins that squeeze CANNOT LAND, and the engine
// is not at fault when it does not. Chromium reports a quota that FLOATS with usage: measured
// 2026-09-03, three 512 MiB writes raised it from 10.737 GB to 12.353 GB, by exactly what was
// written, leaving `quota - usage` at 10,737,418,240 bytes every single time. So `limit - used`
// is a constant there, the pressure the eviction budget watches for can never appear, and the
// padding loop chases a target that recedes as fast as it is approached. Firefox on the same machine
// held its quota still and gave up headroom byte for byte.
//
// Every test below that needs pressure MEASURES that through `squeezeTo` and skips with the reason,
// rather than failing. Four of them were `test.fixme` for months over exactly this. See
// storage-budget.ts, and scripts/probe-headroom.mjs for the measurement.

import type { Page } from '@playwright/test'

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

// a second webseeded demo, so eviction ORDER can be tested against two real torrents rather than
// against the planner's arithmetic alone. Index 1 is Big Buck Bunny.mp4, 276,134,947 bytes.
const BUNNY = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const BUNNY_HASH = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'
const BUNNY_VIDEO = 1

const embedUrl = (magnet: string, fileIndex = SINTEL_VIDEO) =>
  `/embed?magnet=${Buffer.from(magnet).toString('base64')}&fileIndex=${fileIndex}`

test.use({ headless: false })

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

const CHUNK = 256 * 1024 * 1024

/** Written before a headroom that has not moved is a fact about the engine rather than noise. */
const ELASTIC_AFTER = 4 * CHUNK

/**
 * Why a test below is skipped rather than failed when the origin will not squeeze.
 *
 * Not a guess and not a platform assumption: {@link squeezeTo} MEASURES it on the origin the test is
 * running against, every run, and this sentence is only the explanation attached to the result.
 */
const ELASTIC_REASON = 'this origin reports a floating ceiling, so its headroom cannot be squeezed:'
  + ' the quota rises by whatever is written and `limit - used` never falls. See storage-budget.ts.'

type Squeeze = {
  used: number
  quota: number
  free: number
  /** The origin really is down to the target, so an assertion after this means something. */
  reached: boolean
  /**
   * The quota rose by what was written, so no amount of padding can create pressure here.
   *
   * MEASURED 2026-09-03, one machine with 2.7 TiB free, one origin, three 512 MiB writes per engine:
   * Chromium's quota rose 10.737 GB to 12.353 GB, exactly what was written, with `quota - usage`
   * coming back as 10,737,418,240 after every one of them, while Firefox held its quota still and let
   * the headroom fall by the 1,613,063,025 bytes written, byte for byte. This is the whole reason
   * four tests here sat failing on `main`: on a floating ceiling the engine is behaving perfectly and
   * the rig cannot ask it the question.
   */
  elastic: boolean
  written: number
  headroomMoved: number
  chunks: number
}

/** One sparse chunk of padding, which costs nothing to write: the quota charges a file's extent. */
const padChunk = (page: Page, name: string, size: number) =>
  page.evaluate(async ([n, bytes]: [string, number]) => {
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
      worker.postMessage([n, bytes])
    })
    worker.terminate()
    return result
  }, [name, size] as [string, number])

/**
 * Charge the origin until only `freeBytes` are left, and SAY what happened.
 *
 * Chunked, and checked after every chunk. One write covering the whole remaining budget comes back
 * SHORT rather than throwing, so a single-shot version reports success having written nothing at
 * all, and every assertion after it then measures an origin under no pressure whatsoever.
 *
 * The version this replaced returned an estimate and nothing else, so the two ways it can fail to
 * squeeze were indistinguishable from success: padding that stops landing, and an origin whose
 * headroom does not move at all. Both leave every assertion downstream measuring an origin under no
 * pressure, which is how four tests here came to be failing for a reason that is not about the
 * engine. Whatever this returns now says which of the three happened.
 */
const squeezeTo = async (page: Page, freeBytes: number): Promise<Squeeze> => {
  const first = await estimate(page)
  const settle = (now: { used: number, quota: number }, chunks: number): Squeeze => {
    const written = now.used - first.used
    const headroomMoved = (first.quota - first.used) - (now.quota - now.used)
    return {
      used: now.used,
      quota: now.quota,
      free: now.quota - now.used,
      reached: now.quota - now.used <= freeBytes,
      // a ceiling that rose by what was written, judged only once enough has been written to tell
      elastic: written >= ELASTIC_AFTER && headroomMoved < written * 0.25,
      written,
      headroomMoved,
      chunks,
    }
  }

  let stalled = 0
  for (let chunk = 0; chunk < 64; chunk++) {
    const before = await estimate(page)
    const want = before.quota - before.used - freeBytes
    if (want <= 0) return settle(before, chunk)
    const result = await padChunk(page, `ripple-test-padding-${chunk}.bin`, Math.min(want, CHUNK))
    const after = await estimate(page)
    if (after.used <= before.used) {
      // A refused write is how an origin that IS full behaves, so it is not an error on its own.
      // Three in a row with the usage not moving means the padding is going nowhere.
      console.log('[test] padding did not land', JSON.stringify({ result, before, after }))
      if (++stalled >= 3) return settle(after, chunk)
      continue
    }
    stalled = 0
    // Stop as soon as the ceiling is provably floating. Carrying on writes gigabytes to no purpose:
    // `want` is recomputed from a quota that grows by exactly what the last chunk added, so the
    // target recedes as fast as it is approached and the loop only ever ends on its own bound.
    const measured = settle(after, chunk + 1)
    if (measured.elastic) return measured
  }
  return settle(await estimate(page), 64)
}

/**
 * Start the bundled demo, which now arrives PAUSED.
 *
 * A first run used to add it started, so every test here got a real torrent moving bytes for free.
 * It is added paused and temporary since `5a416fa`, because a first run should not spend somebody's
 * metered allowance on 129 MB nobody asked for. Anything that needs the demo to actually download
 * has to say so now, and this is that.
 */
const startDemo = async (page: Page) => {
  const resume = page.locator('.torrent').first().getByRole('button', { name: 'Resume' })
  if (await resume.isVisible().catch(() => false)) await resume.click()
}

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
    await startDemo(page)
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

/*
 * FOUR of the tests below were `test.fixme` from the day they were written until 2026-09-03, and the
 * reason turned out to be none of the ones that had been guessed at.
 *
 * The two candidate explanations were that the worker's budget pass THROWS somewhere, or that it
 * COMPLETES and concludes there is room. Those have opposite fixes, so it was left annotated rather
 * than guessed at. It is neither. The pass completes and correctly reports room, because there IS
 * room: on Chromium the quota is a ceiling that FLOATS with usage, so `quota - usage` came back as
 * 10,737,418,240 bytes after each of three 512 MiB writes, unmoved to the byte, while the quota rose
 * by exactly what was written. `limit - used < floor` is then `10 GiB < 1 GB` however much anybody
 * pads, and the squeeze every test here depends on cannot land. Firefox on the same machine and
 * origin held its quota still and gave up headroom byte for byte.
 *
 * So the engine was right the whole time and the rig could not ask it the question. Each test now
 * MEASURES that, through `squeezeTo`, and skips with the measured reason rather than failing. Where
 * the origin does squeeze - Firefox, or a runner short of disk - they run and assert for real.
 *
 * The negative ones skip too, and that is the point rather than a concession. "The watched torrent
 * was not evicted" is true for free on an origin that was never under pressure, so the one test here
 * that was PASSING was passing for no reason: it is the same shape, and it now skips with the others
 * instead of reporting a result it never earned.
 */
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
    test.skip(squeezed.elastic, ELASTIC_REASON)
    expect(squeezed.reached, 'the origin never came under pressure, so nothing below is evidence').toBe(true)

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

  test('gives up the least recently watched of two, and only that one', async ({ page }) => {
    test.setTimeout(300_000)

    // watched first, so it is the one that should go
    await page.goto(embedUrl(SINTEL, SINTEL_VIDEO))
    await downloadSome(page, 25_000_000)
    // watched second: a full navigation kills the worker, and the restore brings the first one back
    // unwatched, so nothing after this touches its place in the order
    await page.goto(embedUrl(BUNNY, BUNNY_VIDEO))
    await downloadSome(page, 25_000_000)

    // leave both players: neither is watched now
    await page.goto('/')
    await expect(page.locator('.torrent').first()).toBeVisible()
    const entries = await library(page)
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.ephemeral)).toBe(true)

    const olderPath = '/dl/' + SINTEL_HASH
    const newerPath = '/dl/' + BUNNY_HASH
    // past the window that keeps a just-opened torrent off the table
    await page.waitForTimeout(20_000)
    const older = await filesUnder(page, olderPath)
    const newer = await filesUnder(page, newerPath)
    expect(older.count).toBeGreaterThan(0)
    expect(newer.count).toBeGreaterThan(0)

    // Leave the origin just under the floor the engine keeps free, so the shortfall is a few MB and
    // ONE torrent covers it. Anything more would not tell an ordering apart from a purge.
    const { quota } = await estimate(page)
    const floor = Math.min(1_000_000_000, Math.floor(quota * 0.1))
    const squeezed = await squeezeTo(page, floor - 10_000_000)
    console.log('[test] floor', floor, 'after squeeze', squeezed, { older, newer })
    test.skip(squeezed.elastic, ELASTIC_REASON)
    expect(squeezed.reached, 'the origin never came under pressure, so nothing below is evidence').toBe(true)

    await expect.poll(
      async () => (await filesUnder(page, olderPath)).count,
      { timeout: 90_000, intervals: [2_000], message: 'the older torrent was never given up' },
    ).toBe(0)

    // the whole point: the shortfall was covered, so the newer one is untouched
    expect((await filesUnder(page, newerPath)).count, 'only the least recently watched should go')
      .toBe(newer.count)

    const after = await library(page)
    expect(after).toHaveLength(2)
    expect(after.find((e) => e.infoHash === SINTEL_HASH)!.started).toBe(false)
    expect(after.find((e) => e.infoHash === BUNNY_HASH)!.started).not.toBe(false)
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

    /*
     * A torrent the USER added, pasted into the toolbar, which is the whole subject of this test.
     *
     * It used to lean on the bundled demo, and the demo stopped being an example of what this
     * protects: since `5a416fa` a first run adds it TEMPORARY and PAUSED, so it is a cache entry and
     * a legitimate eviction candidate, and it downloads nothing until something presses Resume. This
     * test asserted `ephemeral === false` about it and waited for 30 MB that were never coming, so it
     * had a second reason to fail underneath the one that took the other three, and being `fixme`
     * is what let that sit unnoticed. Bunny rather than Sintel because the demo already holds
     * Sintel's infohash and a second add of it answers "Already in your list".
     */
    await page.goto('/')
    await expect(page.locator('.torrent').first()).toBeVisible()
    await page.getByPlaceholder('Add a magnet link').fill(BUNNY)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await downloadSome(page, 30_000_000)

    const entries = await library(page)
    const mine = entries.find((entry) => entry.infoHash === BUNNY_HASH)
    expect(mine, 'the magnet that was pasted has to be in the list').toBeTruthy()
    expect(mine!.ephemeral, 'a torrent the user added is never a cache entry').not.toBe(true)
    const savePath = mine!.savePath as string
    const held = await filesUnder(page, savePath)
    expect(held.count).toBeGreaterThan(0)

    const squeezed = await squeezeTo(page, 60_000_000)
    console.log('[test] after squeeze:', squeezed, 'library torrent holds', held)
    test.skip(squeezed.elastic, ELASTIC_REASON)
    expect(squeezed.reached, 'the origin never came under pressure, so nothing below is evidence').toBe(true)

    // give the budget pass several turns to do the wrong thing
    await page.waitForTimeout(45_000)
    // count only grows: an eviction takes every file at once and stamps the entry, so either alone
    // would be conclusive
    expect((await filesUnder(page, savePath)).count, 'a library torrent must never be auto-deleted')
      .toBeGreaterThanOrEqual(held.count)
    const after = await library(page)
    const survivor = after.find((entry) => entry.infoHash === BUNNY_HASH)
    expect(survivor, 'the row for a torrent the user added must survive').toBeTruthy()
    expect(survivor!.started, 'nothing should have marked it as having lost its files').not.toBe(false)

    // and it says so, rather than stalling with no explanation anywhere
    expect(full, 'a full origin with nothing reclaimable has to be reported').toContain(true)
  })

  /**
   * A download page transfers nothing until its button is pressed, and that must not cost it the
   * torrent it is showing.
   *
   * The page used to claim a viewer as soon as the file list landed, which excluded it from
   * `collectCandidates` outright. Holding instead removed that protection: fifteen seconds after the
   * add it became an ordinary candidate, and an eviction untracks the handle, which the page cannot
   * come back from because its add runs once per magnet. It would sit at a disabled "Loading
   * torrent…" for good, with the bytes it was about to hand over already deleted.
   *
   * The arm above ("gives up an embed torrent nobody is watching") is the control: the same squeeze,
   * the same torrent, no page open, and the bytes go. Without that pair this would pass against an
   * origin that simply never came under pressure.
   */
  test('never gives up the torrent a download page is holding', async ({ page }) => {
    test.setTimeout(240_000)

    // bytes on disk first: a torrent holding nothing is not an eviction candidate at all, so the
    // hold would be protecting it from something that could not have happened
    await page.goto(embedUrl(SINTEL))
    await downloadSome(page, 30_000_000)
    const savePath = '/dl/' + SINTEL_HASH
    const before = await filesUnder(page, savePath)
    expect(before.count).toBeGreaterThan(0)

    // now the DOWNLOAD page for the same torrent, which holds rather than transfers
    await page.goto(`/embed?magnet=${Buffer.from(SINTEL).toString('base64')}&mode=download&files=${SINTEL_VIDEO}`)
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeEnabled({ timeout: 60_000 })

    const squeezed = await squeezeTo(page, 60_000_000)
    console.log('[test] after squeeze:', squeezed, 'holding', before)
    // the same skip the arms around this one take, and for a stronger reason: this test asserts that
    // nothing was evicted, which an origin under no pressure satisfies without the code doing a thing
    test.skip(squeezed.elastic, ELASTIC_REASON)
    expect(squeezed.reached, 'the origin never came under pressure, so nothing below is evidence').toBe(true)

    // well past RECENT_USE_MS, which is the only thing that would have covered this by accident
    await page.waitForTimeout(45_000)
    expect((await filesUnder(page, savePath)).count, 'a held torrent with its page open was evicted')
      .toBeGreaterThan(0)
    // and the page is still able to hand it over, which is the part the user would have lost
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeEnabled()
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
    test.skip(squeezed.elastic, ELASTIC_REASON)
    expect(squeezed.reached, 'the origin never came under pressure, so nothing below is evidence').toBe(true)

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
