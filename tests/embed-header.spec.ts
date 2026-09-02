/*
 * The player usually runs inside somebody else's page, where the person watching has no address bar
 * for it: no route to the rest of the torrent's files, to the download page, or to Ripple. The header
 * carries the way out, and it has to keep working from inside a frame.
 */
import { expect, test } from '@playwright/test'

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const SINTEL_HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
const SINTEL_VIDEO = 5

const watchUrl = `/embed?magnet=${Buffer.from(SINTEL).toString('base64')}&fileIndex=${SINTEL_VIDEO}`

test.describe('the embedded player header', () => {
  test('says what the engine is doing and offers both ways out', async ({ page }) => {
    test.setTimeout(180_000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(watchUrl)

    const state = page.getByTestId('torrent-state')
    await expect(state, 'the header never said what the torrent was doing').toBeVisible({ timeout: 90_000 })
    // one of the library's own words, through the same STATE_LABEL a row uses
    await expect(state).toHaveText(/Downloading|Seeding|Checking|Queued|Done|Paused|Starting|Retrying/)

    /*
     * Both links open a NEW TAB. Navigating the frame would replace the embedder's player with a page
     * they did not ask for, and `noopener` keeps the opened tab from holding a handle on this one.
     */
    const toRipple = page.getByTestId('open-in-ripple')
    await expect(toRipple).toHaveAttribute('target', '_blank')
    await expect(toRipple).toHaveAttribute('rel', /noopener/)
    // the INFO HASH, never a row id: a row id is a handle, and names a different torrent in the next engine
    await expect(toRipple).toHaveAttribute('href', new RegExp(`[?&]torrent=${SINTEL_HASH}$`))

    const toDownload = page.getByTestId('open-download-page')
    await expect(toDownload).toHaveAttribute('target', '_blank')
    await expect(toDownload).toHaveAttribute('rel', /noopener/)
    await expect(toDownload).toHaveAttribute('href', /mode=download/)
    // the file being watched travels with it, rather than making somebody find it again
    await expect(toDownload).toHaveAttribute('href', new RegExp(`fileIndex=${SINTEL_VIDEO}`))

    expect(errors).toEqual([])
  })

  test('the Ripple link opens the library with that torrent already open', async ({ page, context }) => {
    test.setTimeout(180_000)
    await page.goto(watchUrl)
    const toRipple = page.getByTestId('open-in-ripple')
    await expect(toRipple).toBeVisible({ timeout: 90_000 })

    const [opened] = await Promise.all([context.waitForEvent('page'), toRipple.click()])
    /*
     * `waitForURL`, not `waitForLoadState`.
     *
     * A page opened by a target=_blank click exists before it has navigated, and
     * `waitForLoadState('domcontentloaded')` is satisfied by the `about:blank` it starts on. Reading
     * `url()` there returns "about:blank", so the next line failed with `TypeError: Invalid URL`
     * rather than with anything about the link: three of three runs, locally.
     */
    await opened!.waitForURL(/[?&]torrent=/, { timeout: 30_000 })
    expect(new URL(opened!.url()).searchParams.get('torrent')).toBe(SINTEL_HASH)

    /*
     * The deep link is not the href, it is what the href DOES. `?torrent=` resolves an info hash to
     * the row it names and opens that torrent, so a viewer arriving from a player lands on the
     * torrent rather than on a library they now have to search.
     */
    /*
     * Two assertions, because one cannot tell the two failures apart. A library that has not listed
     * the torrent yet and a library that listed it and did not open it look identical through a
     * single selector, and they have nothing to do with each other: the first is the engine still
     * starting, the second is this feature being broken.
     */
    await expect(opened!.locator('.torrent'), 'the engine never listed the torrent, so selection was never reachable')
      .not.toHaveCount(0, { timeout: 120_000 })
    await expect(opened!.locator('.torrent.selected').first(), 'the row was there and the link did not open it')
      .toBeVisible({ timeout: 30_000 })
  })

  /*
   * Adding the state and the two links pushed this row past a phone's width: at 480px the links were
   * off the right edge entirely, and nothing failed, because an overlay that overflows still renders.
   * Measured against the VIEWPORT rather than eyeballed in a screenshot, which only ever shows the
   * part that fits and is therefore blind to exactly this.
   *
   * The WORST case is forced rather than waited for. Measured live this row fit every time and
   * overflowed by 35px once, because the width depends on text that changes: VPN Reconnecting is
   * about 70px wider than VPN On and is what a player shows while it starts, and a speed reads
   * anywhere from 0 B/s to 999.9 MB/s. A test that samples whatever happened to be on screen passes
   * or fails on timing, so every string is pinned to the longest it can be first.
   */
  test('the whole row fits on a phone, with nothing pushed off the edge', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 480, height: 720 })
    await page.goto(watchUrl)
    await expect(page.getByTestId('torrent-state')).toBeVisible({ timeout: 90_000 })

    const edges = await page.evaluate(() => {
      // the longest each item can be: the widest VPN label, a five-digit peer count, and a speed at
      // its longest form. Written into the live DOM, so this measures the real layout rules.
      const widest = (selector: string, text: string) => {
        const span = document.querySelector(`${selector} span`)
        if (span) span.textContent = text
      }
      widest('.item.vpn', 'VPN Reconnecting')
      widest('[data-testid="torrent-state"]', 'Downloading')
      // peers is a COUNT and the two after it are speeds, so they get different worst cases: giving
      // the peer count a speed's width invents 60px this row will never actually be asked to hold
      const numbers = [...document.querySelectorAll('.media-information .item')]
        .filter((el) => !el.className.includes('vpn') && !el.getAttribute('data-testid'))
      const widths = ['99999', '999.9 MB/s', '999.9 MB/s']
      numbers.forEach((el, index) => {
        const span = el.querySelector('span')
        if (span && widths[index]) span.textContent = widths[index]!
      })

      /*
       * The LAST item is the rightmost readout, not a link.
       *
       * The links used to end the row and were what this measured. They are at its head now, so
       * reading the download link here would measure something 40px from the left edge and pass
       * whatever the row did on the right, which is a check that cannot fail.
       */
      const readouts = document.querySelectorAll('.media-information .item')
      const last = readouts[readouts.length - 1]
      const links = document.querySelector('.player-links')
      const name = document.querySelector('.file-name')
      const counter = document.querySelector('.downloaded') ?? document.querySelector('.loading-information')
      const group = document.querySelector('.media-information')
      if (!last || !links || !name || !group) return null
      return {
        lastRight: last.getBoundingClientRect().right,
        linksLeft: links.getBoundingClientRect().left,
        linksRight: links.getBoundingClientRect().right,
        nameRight: name.getBoundingClientRect().right,
        counterLeft: counter ? counter.getBoundingClientRect().left : null,
        groupLeft: group.getBoundingClientRect().left,
        width: window.innerWidth,
      }
    })
    expect(edges, 'the row is missing the items this measures').not.toBeNull()
    expect(edges!.lastRight, 'the last readout hangs off the right edge').toBeLessThanOrEqual(edges!.width)
    expect(edges!.linksLeft, 'the links start off the left edge').toBeGreaterThanOrEqual(0)
    /*
     * The links lead the RIGHT-HAND side of the row: after the filename, in front of everything the
     * torrent is reporting. Both bounds, because only having one lets them drift to either end and
     * still pass, and they have been at both ends already.
     */
    expect(edges!.linksLeft, 'the links are not after the filename').toBeGreaterThanOrEqual(edges!.nameRight)
    if (edges!.counterLeft !== null) {
      expect(edges!.linksRight, 'the links are not in front of the byte counter').toBeLessThanOrEqual(edges!.counterLeft)
    }
    expect(edges!.linksRight, 'the links are not in front of the readouts').toBeLessThanOrEqual(edges!.groupLeft)

    // the readouts fold their words at this width and their icons stay, which is what makes it fit
    await expect(page.getByTestId('torrent-state').locator('span')).toBeHidden()
    // the links never carry a word at any width: the glyph is the control and the tooltip is the label
    await expect(page.getByTestId('open-in-ripple').locator('span')).toHaveCount(0)
    await expect(page.getByTestId('open-in-ripple')).toHaveAttribute('aria-label', /Ripple/)
    await expect(page.getByTestId('open-download-page')).toHaveAttribute('aria-label', /Download/)
    // and the readouts get their words back when there is room
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect(page.getByTestId('torrent-state').locator('span')).toBeVisible()
    await expect(page.getByTestId('open-in-ripple').locator('span')).toHaveCount(0)
  })

  test('the header survives inside a cross-origin frame', async ({ page }) => {
    test.setTimeout(180_000)
    const url = new URL(page.url() || 'http://127.0.0.1/')
    await page.goto('/')
    const base = new URL(page.url()).origin
    // an embedder's page, served from a different origin, holding the player in a frame
    await page.setContent(`<iframe src="${base}${watchUrl}" style="width:900px;height:520px;border:0"></iframe>`)
    const frame = page.frameLocator('iframe')
    await expect(frame.getByTestId('torrent-state')).toBeVisible({ timeout: 90_000 })
    // absolute, so an href read from the embedder's side still points at Ripple rather than at them
    const href = await frame.getByTestId('open-in-ripple').getAttribute('href')
    expect(href, 'a relative href would resolve against the embedder').toMatch(/^https?:\/\//)
    expect(url).toBeTruthy()
  })
})
