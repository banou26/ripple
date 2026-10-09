/*
 * The same share actions, from the row rather than from a download page.
 *
 * Both surfaces are built from ONE `buildTorrentOptions` list, so the right-click menu and the
 * torrent's settings offer the same items by construction. What this adds over the unit tests is that
 * the list is actually reachable: a right-click opens it and the item runs.
 */
import { expect, test } from '@playwright/test'

import { decodeMagnetParam } from '../src/router/magnet-codec'
import { magnetParam, magnetParams } from '../src/torrent/magnet'

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
  // the demo is added from the bundled sintel.torrent, whose identity is stored as `xt` alone
  expect(magnetParam(clipboard, 'dn'), 'the copied magnet has no name').toBe('Sintel')
  expect(magnetParams(clipboard, 'tr').length, 'the copied magnet has no trackers').toBeGreaterThanOrEqual(2)

  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Get a share link' }).click()
  const link = await page.getByTestId('embed-url').textContent({ timeout: 15_000 })
  const shared = decodeMagnetParam(new URL(link ?? '').searchParams) ?? ''
  expect(magnetParam(shared, 'dn'), 'the share link has no name').toBe('Sintel')
  expect(magnetParams(shared, 'tr').length, 'the share link has no trackers').toBeGreaterThanOrEqual(2)
})
