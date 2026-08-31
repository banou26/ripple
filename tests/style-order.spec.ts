/*
 * A style that only loses when you ARRIVE from somewhere else.
 *
 * Ripple's routes carry their own emotion styles, and emotion inserts a component's rules the first
 * time it renders. So the order of the stylesheet depends on the order the pages were visited, and
 * two rules of EQUAL specificity swap winners depending on the route somebody came from.
 *
 * That is not hypothetical here. `home`'s stats panel sizes the speed graph with a bare `svg` rule
 * carrying `min-width: 120px`, which reaches every svg inside the panel including the VPN readout's
 * 13px info glyph. `vpn-stat` overrides it, and wins on a direct load only because home's rules were
 * inserted first. The download page mounts the same VPN readout with none of home's rules present,
 * so arriving from there inserts them the other way round and the glyph is laid out in a 120px box.
 *
 * Reported from the app: the info icon "becomes massive" after clicking Ripple from an embed page,
 * and is correctly sized on a refresh. Headless: this is a layout measurement.
 */
import { expect, test } from '@playwright/test'

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'

/** What the glyph is styled to be, from vpn-stat.tsx. */
const ICON = 13

const iconBox = async (page: import('@playwright/test').Page) => {
  const icon = page.locator('.stat.vpn .info svg').first()
  await expect(icon).toBeVisible({ timeout: 60_000 })
  const box = await icon.boundingBox()
  return { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) }
}

test('the VPN info glyph is the same size however you got to the library', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))

  // the control: a direct load, which is the order that has always worked
  await page.goto('/')
  const direct = await iconBox(page)
  console.log('[direct]', JSON.stringify(direct))
  expect(direct.width).toBeLessThanOrEqual(ICON + 3)

  // and the reported path: the download page first, then its wordmark to the library
  await page.goto(`/embed?magnet=${Buffer.from(SINTEL).toString('base64')}&mode=download`)
  await expect(page.locator('.wordmark')).toBeVisible({ timeout: 60_000 })
  await page.locator('.wordmark').click()
  await expect(page.locator('.stats')).toBeVisible({ timeout: 60_000 })
  const arrived = await iconBox(page)
  console.log('[from the download page]', JSON.stringify(arrived))

  await page.screenshot({ path: 'test-results/vpn-glyph-after-embed.png' })
  expect(arrived.width, 'the info glyph was laid out in the speed graph\'s box').toBeLessThanOrEqual(ICON + 3)
  expect(arrived).toEqual(direct)
  expect(errors).toEqual([])
})
