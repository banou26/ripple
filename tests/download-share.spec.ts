/*
 * The download page's share actions that need nothing from the swarm. Rebuilding the .torrent needs Sintel's
 * metadata from it, so that test is in embed-download.spec.ts.
 */
import { expect, grantClipboard, test } from './offline'

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const SINTEL_HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
const downloadUrl = `/download?magnet=${Buffer.from(SINTEL).toString('base64')}`

test.describe('the download page share actions', () => {
  test('copies the magnet to the clipboard', async ({ page, context, browserName }) => {
    test.setTimeout(120_000)
    await grantClipboard(context, browserName)
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
})
