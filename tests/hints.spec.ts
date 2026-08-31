/*
 * The hints that replaced the native `title` attribute.
 *
 * Two properties, and both are the reason for replacing it. `title` waits about a second before the
 * browser draws it, and the browser positions it wherever it likes, which near a window edge means
 * off the edge with the text cut off. Neither is adjustable from the page.
 *
 * So both are MEASURED here rather than assumed from a prop: how long a hint takes to appear, and
 * whether the chip stays inside the window. The viewport is deliberately narrow, because a hint only
 * runs off an edge when there is an edge close enough to run off.
 *
 * Headless: this is a layout and timing measurement, not a transfer.
 */
import { expect, test } from '@playwright/test'

/** Comfortably under the native delay, and far enough over zero to survive a busy machine. */
const INSTANT_MS = 500

const CHIP = '.react-tooltip'

test.use({ viewport: { width: 720, height: 620 } })

test('a hint appears at once, and never leaves the page', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))

  await page.goto('/')
  await expect(page.locator('.stats')).toBeVisible({ timeout: 60_000 })

  /*
   * NOTHING carries a native title any more, which is the half a screenshot cannot show. A leftover
   * one would draw the browser's own slow tooltip beside the new one, and only on hover.
   */
  const natives = await page.locator('[title]:not(iframe)').count()
  expect(natives, 'a native title survived, so the browser will draw its own tooltip too').toBe(0)

  const anchors = page.locator('[data-tooltip-id="ripple-hint"]')
  const total = await anchors.count()
  expect(total, 'no hints were found at all, so this test would pass by checking nothing').toBeGreaterThan(6)

  const viewport = page.viewportSize()!
  const skipped: string[] = []
  let measured = 0
  let fastest = Number.POSITIVE_INFINITY

  for (let i = 0; i < total; i++) {
    const anchor = anchors.nth(i)
    const content = await anchor.getAttribute('data-tooltip-content')
    if (!content) continue

    await page.mouse.move(1, 1)
    await expect(page.locator(CHIP)).toHaveCount(0, { timeout: 3_000 }).catch(() => {})

    const started = Date.now()
    const opened = await anchor.scrollIntoViewIfNeeded()
      .then(() => anchor.hover({ timeout: 2_000 }))
      .then(() => page.locator(CHIP).first().waitFor({ state: 'visible', timeout: INSTANT_MS }))
      .then(() => true, () => false)
    if (!opened) {
      // a control that cannot be hovered at all, such as the hidden input behind a file label
      skipped.push(`${i}:${content.slice(0, 24)}`)
      continue
    }
    fastest = Math.min(fastest, Date.now() - started)

    const box = await page.locator(CHIP).first().boundingBox()
    expect(box, `hint ${i} has no box`).toBeTruthy()
    const { x, y, width, height } = box!

    /*
     * INSIDE THE WINDOW on every side. One pixel of slack for subpixel rounding and no more: the
     * whole complaint about the native tooltip is that it hangs off the edge.
     */
    const where = `hint ${i} (${content.slice(0, 30)}) at ${JSON.stringify(box)}`
    expect(x, `${where} runs off the left`).toBeGreaterThanOrEqual(-1)
    expect(y, `${where} runs off the top`).toBeGreaterThanOrEqual(-1)
    expect(x + width, `${where} runs off the right of a ${viewport.width}px window`).toBeLessThanOrEqual(viewport.width + 1)
    expect(y + height, `${where} runs off the bottom of a ${viewport.height}px window`).toBeLessThanOrEqual(viewport.height + 1)
    measured++
  }

  console.log('[hints]', JSON.stringify({ total, measured, fastestMs: fastest, skipped }))
  await page.screenshot({ path: 'test-results/hints.png' })

  /*
   * A floor on how much was actually checked, so a change that stopped hints opening cannot pass by
   * skipping everything. The skips are printed rather than swallowed.
   */
  expect(measured, `only ${measured} hints were measured; skipped ${JSON.stringify(skipped)}`).toBeGreaterThan(8)
  expect(fastest, 'no hint opened quickly, which is the whole point of replacing title').toBeLessThan(INSTANT_MS)
  expect(errors).toEqual([])
})

/*
 * And on the OTHER routes, because the tooltip is mounted once at the router root rather than by
 * each page. A route that had to remember to mount its own would show no hints at all when it
 * forgot, which looks exactly like hints not being wired up.
 */
test('hints work on the download page too, which mounts none of its own', async ({ page }) => {
  test.setTimeout(120_000)
  const magnet = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'
  await page.goto(`/embed?magnet=${Buffer.from(magnet).toString('base64')}&mode=download`)

  const anchor = page.locator('[data-tooltip-id="ripple-hint"]').first()
  await expect(anchor).toBeVisible({ timeout: 60_000 })
  expect(await page.locator('[title]:not(iframe)').count()).toBe(0)

  await anchor.hover()
  const chip = page.locator(CHIP).first()
  await expect(chip).toBeVisible({ timeout: INSTANT_MS })

  const box = (await chip.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.y).toBeGreaterThanOrEqual(-1)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
})

