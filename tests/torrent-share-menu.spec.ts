/*
 * The same share and copy actions, from the row rather than from a download page.
 *
 * Both surfaces are built from ONE `buildTorrentOptions` list, so the right-click menu and the
 * torrent's settings offer the same items by construction. What this adds over the unit tests is that
 * the list is actually reachable: a right-click opens it and the item runs.
 */
import { expect, test } from './offline'

import { addSample } from './sample-offer'
import { decodeMagnetParam } from '../src/router/magnet-codec'
import { magnetParam, magnetParams } from '../src/torrent/magnet'

test('a torrent offers its magnet, name, info hash and .torrent from the right-click menu', async ({ page, context }) => {
  test.setTimeout(180_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')

  const row = await addSample(page, { pause: true })
  await row.click({ button: 'right' })

  const copy = page.getByRole('menuitem', { name: 'Copy magnet' })
  await expect(copy, 'the right-click menu never offered it').toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('menuitem', { name: 'Save .torrent' })).toBeVisible()

  await copy.click()
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboard, 'the clipboard did not get a magnet').toMatch(/^magnet:\?xt=urn:btih:[0-9a-f]{40}/)
  // the sample is added from the bundled sintel.torrent, whose identity is stored as `xt` alone
  expect(magnetParam(clipboard, 'dn'), 'the copied magnet has no name').toBe('Sintel')
  expect(magnetParams(clipboard, 'tr').length, 'the copied magnet has no trackers').toBeGreaterThanOrEqual(2)

  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy info hash' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(clipboard.match(/btih:([0-9a-f]{40})/)![1])
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy name' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Sintel')

  // a magnet may write its hash in base32, and the hash copied is the 40 hex characters other clients show
  await page.getByPlaceholder('Add a magnet link').fill(`magnet:?xt=urn:btih:${'h47t6pz7'.repeat(4)}`)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.locator('.torrent', { hasText: 'Fetching metadata…' }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Copy name' })).toBeDisabled()
  await page.getByRole('menuitem', { name: 'Copy info hash' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('3f'.repeat(20))

  // the newest row is listed first
  const sintel = page.locator('.torrent', { hasText: 'Sintel' })
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('refused')) })
  await sintel.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy name' }).click()
  await expect(page.locator('.toast')).toHaveText('Could not copy')

  await sintel.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Get a share link' }).click()
  const link = await page.getByTestId('embed-url').textContent({ timeout: 15_000 })
  const shared = decodeMagnetParam(new URL(link ?? '').searchParams) ?? ''
  expect(magnetParam(shared, 'dn'), 'the share link has no name').toBe('Sintel')
  expect(magnetParams(shared, 'tr').length, 'the share link has no trackers').toBeGreaterThanOrEqual(2)
})
