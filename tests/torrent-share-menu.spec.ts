/*
 * The same two actions, from the row rather than from a download page.
 *
 * Both surfaces are built from ONE `buildTorrentOptions` list, so the right-click menu and the
 * torrent's settings offer the same items by construction. What this adds over the unit tests is that
 * the list is actually reachable: a right-click opens it and the item runs.
 */
import { expect, test } from '@playwright/test'

test('a torrent offers its magnet and its .torrent from the right-click menu', async ({ page, context }) => {
  test.setTimeout(180_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')

  const row = page.locator('.torrent').first()
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.click({ button: 'right' })

  const copy = page.getByRole('menuitem', { name: 'Copy magnet' })
  await expect(copy, 'the right-click menu never offered it').toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('menuitem', { name: 'Save .torrent' })).toBeVisible()

  await copy.click()
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboard, 'the clipboard did not get a magnet').toMatch(/^magnet:\?xt=urn:btih:[0-9a-f]{40}/)
})
