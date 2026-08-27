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
    const url = `http://127.0.0.1:4560${downloadUrl(`files=${SUBTITLE}`)}`

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
