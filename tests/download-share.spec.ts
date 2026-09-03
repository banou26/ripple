/*
 * Taking the torrent itself away, rather than its files.
 *
 * The .torrent is the interesting one: there is nothing to fetch, because a magnet carries an
 * infohash and the engine gets the rest from the swarm, after which the info dictionary lives only
 * inside libtorrent, which exposes no way to read it back. The page rebuilds it from the resume blob,
 * which libtorrent is asked to write with `save_info_dict`. This drives that whole chain and then
 * checks the one property that matters: the file describes the SAME torrent.
 */
import { readFile } from 'fs/promises'

import { expect, test } from '@playwright/test'

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const SINTEL_HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
const downloadUrl = `/embed?magnet=${Buffer.from(SINTEL).toString('base64')}&mode=download`

test.describe('the download page share actions', () => {
  test('copies the magnet to the clipboard', async ({ page, context }) => {
    test.setTimeout(120_000)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(downloadUrl)

    const copy = page.getByRole('button', { name: 'Copy magnet' })
    await expect(copy, 'the action is offered before metadata, because copying a link never needed the swarm')
      .toBeVisible({ timeout: 60_000 })
    await copy.click()

    await expect(page.getByTestId('share-note')).toHaveText('Magnet copied')
    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboard).toBe(SINTEL)
  })

  /*
   * The card heads itself with the release's picture in place of the file glyph.
   *
   * Driven from a picture ALREADY ON THE DEVICE rather than from a live download, and that is a
   * statement about the feature rather than a convenience. Making one during a download needs a
   * source the page is actually fetching: a cover image has to arrive whole, and this page fetches
   * files in the order the link asked for, so a cover late in the torrent lands last; a video needs
   * 512 KiB of contiguous head AND a header libav can parse, which Sintel's does not have. Measured
   * repeatedly: 1 of 6 runs produced a picture, and the one that did got the cover by luck.
   *
   * So what is pinned here is what the page promises: if there is a picture for this torrent, the
   * card shows it instead of the glyph. Whether one can be MADE mid-download is the thumbnail store's
   * business and is covered by its own tests.
   */
  test('heads the card with the release picture when the device already has one', async ({ page }) => {
    test.setTimeout(120_000)

    // a real 2x2 PNG, so a broken <img> cannot pass this: naturalWidth is asserted below
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYEJRIAAIhkCAyxA1AoAAAAASUVORK5CYII='
    await page.addInitScript(([hash, png]) => {
      // idb-keyval's default store, which is where the thumbnail cache lives
      const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'image/png' })
      const open = indexedDB.open('keyval-store', 1)
      open.onupgradeneeded = () => { open.result.createObjectStore('keyval') }
      open.onsuccess = () => {
        const store = open.result.transaction('keyval', 'readwrite').objectStore('keyval')
        store.put(blob, 'ripple:thumb:' + hash)
      }
    }, [SINTEL_HASH, PNG] as const)

    await page.goto(downloadUrl)

    const poster = page.locator('.glyph.poster img')
    await expect(poster, 'the card kept the file glyph though a picture was on the device')
      .toBeVisible({ timeout: 60_000 })
    // a real picture rather than a broken image element
    expect(await poster.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    // and the glyph it replaced is gone rather than drawn behind it
    await expect(page.locator('.glyph svg')).toHaveCount(0)
  })

  test('rebuilds a .torrent that names the same torrent', async ({ page }) => {
    test.setTimeout(180_000)
    await page.goto(downloadUrl)

    /*
     * Metadata arriving is the precondition, and the meta line is what states it. NOT the Download
     * button's label, which changes with the selection (a bare link says "Download 11 files as .zip"),
     * so matching it exactly finds nothing and reports a page that never loaded.
     */
    await expect(page.locator('.subject .meta'), 'the swarm never delivered metadata')
      .not.toHaveText(/Reading the torrent from the network/, { timeout: 90_000 })

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 90_000 }),
      page.getByRole('button', { name: /Save \.torrent/ }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/\.torrent$/)

    const path = await download.path()
    expect(path, 'the download produced no file').toBeTruthy()
    const bytes = await readFile(path)

    /*
     * The infohash is computed HERE, off the bytes that actually landed, rather than trusted from the
     * page. It is the SHA-1 of the info dictionary exactly as it appears, so this is the assertion
     * that a decode-and-re-encode rebuild would fail: such a file parses, lists the right files at
     * the right sizes, and belongs to a swarm that does not exist.
     */
    const identity = await page.evaluate(async (data) => {
      const b = new Uint8Array(data)
      // find the byte range of the `info` value, the same way the app does
      const dec = new TextDecoder()
      let at = 1
      const readOne = (i: number): number => {
        const c = b[i]!
        if (c === 0x69) { let j = i + 1; while (b[j] !== 0x65) j++; return j + 1 }
        if (c === 0x6c || c === 0x64) { let j = i + 1; while (b[j] !== 0x65) j = readOne(j); return j + 1 }
        let j = i
        while (b[j] !== 0x3a) j++
        return j + 1 + Number(dec.decode(b.subarray(i, j)))
      }
      while (at < b.length && b[at] !== 0x65) {
        const afterKey = readOne(at)
        const key = dec.decode(b.subarray(at, afterKey)).replace(/^\d+:/, '')
        const afterValue = readOne(afterKey)
        if (key === 'info') {
          const slice = new Uint8Array(b.slice(afterKey, afterValue))
          const digest = await crypto.subtle.digest('SHA-1', slice.buffer)
          return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('')
        }
        at = afterValue
      }
      return null
    }, [...bytes])

    expect(identity, 'no info dictionary in the file that was saved').toBeTruthy()
    expect(identity, 'the rebuilt file is a valid torrent for a DIFFERENT swarm').toBe(SINTEL_HASH)

    // and the trackers the magnet carried came across, so the file can actually find peers
    const text = bytes.toString('latin1')
    expect(text).toContain('udp://tracker.opentrackr.org:1337')
    expect(text).toContain('https://webtorrent.io/torrents/')
  })
})
