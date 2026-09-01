// The download page against a real torrent, from magnet to bytes on disk.
//
// Everything cheaper than this is mocked somewhere: the browser tests stub the engine and the sink,
// and the unit tests stub the torrent. What only a real run can show is that the whole chain holds
// at once, that the file the URL names is the file that lands, and that a zip built out of a live
// swarm opens in a real zip reader.
//
// Sintel is used because it carries a webseed, so the run does not depend on a swarm being alive.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'

/**
 * Index 5 is the 129 MB video; 0 through 4 are subtitle tracks of a few dozen KB.
 *
 * The small ones are what this drives. The claim under test is the plumbing, and a subtitle proves
 * it in seconds where the video would spend minutes proving the same thing.
 */
const SUBTITLE = 0
const SUBTITLE_RANGE = '0-2'

const downloadUrl = (params: string) =>
  `/embed?magnet=${Buffer.from(SINTEL).toString('base64')}&mode=download&${params}`

// a magnet gets a directory of its own, named by its infohash, under the shared save root
const SINTEL_SAVE_PATH = '/dl/08ada5a7a6183aae1e09d831df6748d566095a10'

/**
 * How many payload files the engine has written for this torrent, counted recursively.
 *
 * The COUNT rather than the size, because a file the engine is still holding a sync access handle
 * for refuses `getFile()`, and the byte reading then comes back 0 for a file that is being actively
 * written. A file that was never written has no entry to find at all, so counting cannot report a
 * running torrent as an idle one.
 */
const payloadFiles = (page: import('@playwright/test').Page) =>
  page.evaluate(async (path: string) => {
    let dir: any = await navigator.storage.getDirectory()
    for (const segment of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment).catch(() => null)
      if (!dir) return 0
    }
    const walk = async (handle: any): Promise<number> => {
      let count = 0
      for await (const child of handle.values()) count += child.kind === 'file' ? 1 : await walk(child)
      return count
    }
    return walk(dir)
  }, SINTEL_SAVE_PATH)

/**
 * What the engine has actually written for this torrent, per file and in total.
 *
 * SIZES rather than presence, which is the opposite of how this was first written. libtorrent
 * creates a file the moment a piece lands in it and a piece can straddle two files, so downloading
 * one 1.5 kB subtitle of Sintel creates the 129 MB video as well: measured at 123,188 bytes of it,
 * off the single 128 KiB piece the five subtitles share with its head. A file EXISTING therefore
 * says nothing here, and the first version of the test below failed on a torrent behaving perfectly.
 *
 * `locked` is the honest gap rather than a curiosity. A file the engine is writing through a sync
 * access handle refuses `getFile()`, so `bytes` is a floor, short by whatever is open at the time.
 * Nothing was ever locked across the runs this was built against, including while the video was
 * actively downloading, so the floor has so far been the true total.
 */
const payloadReport = (page: import('@playwright/test').Page) =>
  page.evaluate(async (path: string) => {
    const sizes: Record<string, number> = {}
    const locked: string[] = []
    let bytes = 0
    let dir: any = await navigator.storage.getDirectory()
    for (const segment of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment).catch(() => null)
      if (!dir) return { sizes, bytes, locked }
    }
    const walk = async (handle: any): Promise<void> => {
      for await (const child of handle.values()) {
        if (child.kind !== 'file') { await walk(child); continue }
        try {
          const size = (await child.getFile()).size
          sizes[child.name] = size
          bytes += size
        } catch {
          locked.push(child.name)
        }
      }
    }
    await walk(dir)
    return { sizes, bytes, locked }
  }, SINTEL_SAVE_PATH)

/**
 * Chromium exposes showSaveFilePicker, which would open a native dialog no test can answer.
 *
 * Removing it forces the service worker arm, which is also the arm every embedded page takes,
 * because Chrome refuses a file picker in a cross origin frame. So this is the shipping path rather
 * than a convenient stand-in for it.
 */
const forceStreamSink = `delete window.showSaveFilePicker`

// headful by project rule: a run that has to watch a torrent actually move bytes stalls at a flat
// 0 B/s headless, in every topology, which makes the thing under test unmeasurable. It has to sit at
// the top level, because inside a describe playwright refuses it ("forces a new worker").
test.use({ headless: false })

test.describe('the embed download page', () => {

  test('downloads the single file its URL names', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.addInitScript(forceStreamSink)

    await page.goto(downloadUrl(`files=${SUBTITLE}`))
    // the service worker is what carries the bytes, and it is registered on load
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 })

    const button = page.getByRole('button', { name: 'Download', exact: true })
    await expect(button).toBeEnabled({ timeout: 60_000 })

    // the page names one file, not the torrent, and sizes the selection rather than the whole thing
    await expect(page.locator('.subject .name')).toHaveText(/\.srt$/)
    const stated = await page.locator('.subject .meta').textContent()

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      button.click(),
    ])

    const dir = mkdtempSync(join(tmpdir(), 'ripple-dl-'))
    try {
      const saved = join(dir, download.suggestedFilename())
      await download.saveAs(saved)
      const bytes = statSync(saved).size

      expect(download.suggestedFilename()).toMatch(/\.srt$/)
      expect(bytes, 'a real payload, not an empty stream').toBeGreaterThan(0)
      // what the page promised is what arrived, at the one decimal the kB readout carries
      expect(stated).toContain(`${(bytes / 1000).toFixed(1)} kB`)
      await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 30_000 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    expect(pageErrors).toEqual([])
  })

  test('bundles a range of files into a zip a real reader accepts', async ({ page }) => {
    let python: string
    try {
      python = execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim()
      if (!python) test.skip(true, 'python3 is needed to validate the archive')
    } catch {
      test.skip(true, 'python3 is needed to validate the archive')
      return
    }

    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.addInitScript(forceStreamSink)

    await page.goto(downloadUrl(`files=${SUBTITLE_RANGE}`))
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 })

    const button = page.getByRole('button', { name: /Download 3 files as \.zip/ })
    await expect(button).toBeEnabled({ timeout: 60_000 })

    const names = await page.locator('.files .file .name').allTextContents()

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 180_000 }),
      button.click(),
    ])

    const dir = mkdtempSync(join(tmpdir(), 'ripple-zip-'))
    try {
      const archive = join(dir, download.suggestedFilename())
      await download.saveAs(archive)
      expect(download.suggestedFilename()).toBe('Sintel.zip')

      const report = execFileSync(python!, ['-c', `
import json, zipfile
z = zipfile.ZipFile(${JSON.stringify(archive)})
print(json.dumps({
  'bad': z.testzip(),
  'names': z.namelist(),
  'sizes': [i.file_size for i in z.infolist()],
  'nonempty': all(len(z.read(n)) == i.file_size for n, i in zip(z.namelist(), z.infolist())),
}))
`], { encoding: 'utf8' })
      const result = JSON.parse(report)

      // testzip() recomputes every CRC, so this is the whole chain checked at once: the swarm gave
      // the right bytes, the reader framed them correctly, and the archive is not merely well formed
      expect(result.bad, 'every entry passes its own CRC').toBeNull()
      expect(result.names).toHaveLength(3)
      expect(result.nonempty).toBe(true)
      // and they are the three the page listed, in the order the selection named
      expect(result.names.map((n: string) => n.split('/').pop())).toEqual(names)
      expect(result.sizes.every((n: number) => n > 0)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    expect(pageErrors).toEqual([])
  })

  /**
   * The topology the page is actually for: /embed inside somebody else's origin.
   *
   * `localhost` and `127.0.0.1` are different origins to a browser while being the same server, so
   * this is a genuine cross-origin frame with no second deployment. What it pins is that the page
   * still comes up framed and offers the way out, because a refused download is silent: the frame
   * navigation is dropped with no event and nothing thrown.
   */
  test('renders inside a cross-origin frame and offers a way out of it', async ({ page }) => {
    await page.goto('/')
    /*
     * The origin is taken from the page rather than written down.
     *
     * `localhost` and `127.0.0.1` are different origins to a browser while being the same server,
     * which is what makes this a genuine cross-origin frame with no second deployment. The PORT has
     * to follow whatever the run is using though: it was hardcoded, and the moment a run could pick
     * its own port this framed an address nothing was serving and waited sixty seconds for a button
     * on a blank page.
     */
    const here = new URL(page.url())
    test.skip(!/^(127\.0\.0\.1|localhost)$/.test(here.hostname), 'needs the loopback pair, so it is local only')
    const url = `http://127.0.0.1:${here.port}${downloadUrl(`files=${SUBTITLE}`)}`

    await page.evaluate((src) => {
      const frame = document.createElement('iframe')
      frame.src = src
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:9999'
      document.body.append(frame)
    }, url.replace('127.0.0.1', 'localhost'))

    const framed = page.frameLocator('iframe[src*="localhost"]')
    await expect(framed.getByRole('button', { name: 'Download', exact: true })).toBeEnabled({ timeout: 60_000 })
    // shown only when window.top is another origin, so its presence IS the cross-origin detection
    await expect(framed.getByText('Open this page in Ripple')).toBeVisible()
  })

  /**
   * Opening the page must cost nothing until the button is pressed.
   *
   * It used to claim a viewer the moment the file list landed, so a link somebody followed out of
   * curiosity started filling their storage at full speed with no download in progress anywhere on
   * screen. The engine now settles a page-added torrent to all-skip as soon as its layout arrives,
   * and the press is what lifts it.
   *
   * The held arm is a NEGATIVE result, so it carries its own positive control in the same run: the
   * click that follows has to move the very bytes the wait proved were not moving. Without it, a
   * torrent that simply failed to reach the swarm would pass this test.
   */
  test('writes nothing until Download is pressed, then writes', async ({ page }) => {
    await page.addInitScript(forceStreamSink)
    await page.goto(downloadUrl(`files=${SUBTITLE}`))
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 })

    const button = page.getByRole('button', { name: 'Download', exact: true })
    // enabled means the file list arrived, so everything after this is the HELD state and not a page still loading
    await expect(button).toBeEnabled({ timeout: 60_000 })
    // a swarm readout under an unpressed button would be describing a transfer that must not exist
    await expect(page.getByTestId('swarm')).toHaveCount(0)

    // Long enough to be a real observation rather than a race won: this torrent is webseeded, so a
    // running one has files on disk well inside it.
    const held = await payloadFiles(page)
    await page.waitForTimeout(15_000)
    expect(await payloadFiles(page), 'the engine wrote while the page was only holding metadata')
      .toBe(held)

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      button.click(),
    ])
    await download.cancel().catch(() => {})

    // the positive control: the same measurement, after the only thing that changed was the click
    await expect
      .poll(() => payloadFiles(page), { timeout: 120_000 })
      .toBeGreaterThan(held)
  })

  /**
   * Picking files on the page, which is the half of a download link the sender does not decide.
   *
   * Three claims in one run, because they are only worth anything together: what is ticked is what
   * arrives, what is NOT ticked is not pulled from the swarm, and the ones left behind can still be
   * taken afterwards. The last is the one that used to be impossible: the first Download replaced
   * this page's held claim with a real one and nothing put it back, so the engine spent the rest of
   * the page's life anchored on that one file with every other piece at skip.
   *
   * Sintel is a bare link here, so all eleven files are offered and every box starts ticked, which
   * is the shape somebody actually arrives in.
   */
  test('fetches only the ticked files, and lets the rest be taken afterwards', async ({ page }) => {
    test.setTimeout(300_000)
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.addInitScript(forceStreamSink)

    await page.goto(downloadUrl(''))
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 })

    const all = page.getByRole('button', { name: /Download \d+ files as \.zip/ })
    await expect(all).toBeEnabled({ timeout: 60_000 })

    // read off the page rather than written down: the file list belongs to the torrent
    const names = await page.locator('.files .file .name').allTextContents()
    const subtitles = names.filter((name) => name.endsWith('.srt'))
    const video = names.find((name) => name.endsWith('.mp4'))
    expect(subtitles.length, 'this torrent no longer has the subtitles this test drives').toBeGreaterThan(1)
    expect(video, 'this torrent no longer has the video this test avoids').toBeTruthy()

    await page.getByRole('button', { name: 'Select none' }).click()
    await expect(page.getByRole('button', { name: 'Select at least one file' })).toBeDisabled()

    await page.getByRole('checkbox', { name: subtitles[0]! }).check()
    const one = page.getByRole('button', { name: 'Download', exact: true })
    await expect(one).toBeEnabled()

    const [first] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      one.click(),
    ])
    // the file that was ticked is the file that arrived, by name
    expect(first.suggestedFilename()).toBe(subtitles[0])
    await first.cancel().catch(() => {})
    await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 60_000 })

    // what the torrent fetched while it was awake and downloading, read before anything else runs
    const held = await payloadReport(page)

    /*
     * The negative, and it is THIS report that carries it rather than any later one.
     *
     * `held` was taken the moment the subtitle finished, so it describes what the torrent fetched
     * while it was awake and downloading: one 128 KiB piece, out of a 129 MB torrent. Nothing else
     * was asked for. It carries its own control, because the same number has to be non-zero: a probe
     * that could not see the bytes would report an empty disk and pass this for free.
     *
     * Two things that were tried here and are NOT in this test, both removed rather than left as
     * checks that cannot fail:
     *
     *  - Watching for fifteen seconds AFTER a download finished. The page hands its claim back when
     *    a job ends, which idle-parks a page-added torrent, so nothing is being fetched in that
     *    window whatever the selection says. It passed with the whole feature deleted.
     *  - Asserting that no OTHER file gains bytes while a ticked one downloads. A claimed file's own
     *    boundary pieces write into whatever shares them, at BOTH ends: measured, downloading the
     *    video put bytes into `Sintel.nl.srt`, which follows it. That is the same "no way to ask for
     *    half a piece" physics as the head, so the assertion fails against an engine behaving
     *    correctly, and it did.
     */
    expect(held.bytes, 'the probe saw no bytes at all, so it could not have seen too many')
      .toBeGreaterThan(0)
    expect(held.bytes, 'the swarm was asked for more than the one file that was ticked')
      .toBeLessThan(4_000_000)

    /*
     * The rest of the torrent is still there to take, which is the whole point of taking one file.
     *
     * A different subtitle, after a download has already finished, through the row's own button so
     * that the claim has to MOVE rather than be made for the first time. This is the half that was
     * impossible before: the first Download replaced the page's held claim with a live one and
     * nothing put it back, so the engine stayed anchored on that one file.
     */
    const second = page.getByRole('button', { name: `Download ${subtitles[1]}`, exact: true })
    await expect(second).toBeEnabled({ timeout: 30_000 })
    const [next] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      second.click(),
    ])
    expect(next.suggestedFilename()).toBe(subtitles[1])
    await next.cancel().catch(() => {})

    // and still nothing but subtitles: two files taken, and the 129 MB video still not asked for
    await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 60_000 })
    const after = await payloadReport(page)
    expect(after.bytes, 'the second download pulled more than the file it was for')
      .toBeLessThan(4_000_000)
    expect(after.sizes[video!] ?? 0, 'the video was fetched for a subtitle download')
      .toBeLessThan(4_000_000)

    expect(pageErrors).toEqual([])
  })

  /**
   * The service worker is the FIRST arm, not the fallback, and this is the only check that can say so.
   *
   * Every other test here deletes `showSaveFilePicker` to reach the streaming path, which means all
   * of them would keep passing if the picker were put back in front of it. This one leaves the
   * picker in place, as a real desktop Chromium has it, and requires the download to arrive without
   * it ever being called.
   */
  test('takes the service worker even where a save picker exists', async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as any).__pickerCalls = 0
      // Never resolves, so if this arm is ever taken the download event simply never fires and the
      // test fails on the timeout rather than on a native dialog nothing can answer.
      ;(window as any).showSaveFilePicker = () => {
        ;(window as any).__pickerCalls++
        return new Promise(() => {})
      }
    })

    await page.goto(downloadUrl(`files=${SUBTITLE}`))
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 })

    const button = page.getByRole('button', { name: 'Download', exact: true })
    await expect(button).toBeEnabled({ timeout: 60_000 })

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      button.click(),
    ])

    expect(download.suggestedFilename()).toMatch(/\.srt$/)
    expect(await page.evaluate(() => (window as any).__pickerCalls)).toBe(0)
    await download.cancel().catch(() => {})
  })
})
