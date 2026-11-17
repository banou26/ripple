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
import { linkParams } from '../src/router/path'
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
  // after the #, so a request for the link names no torrent
  expect(new URL(link ?? '').search).toBe('')
  const shared = decodeMagnetParam(linkParams(new URL(link ?? ''))) ?? ''
  expect(magnetParam(shared, 'dn'), 'the share link has no name').toBe('Sintel')
  expect(magnetParams(shared, 'tr').length, 'the share link has no trackers').toBeGreaterThanOrEqual(2)
})

/*
 * A private tracker's address carries the member's own key, so a torrent added from a .torrent that says it is
 * private gets no share link from its row, and still none after a reload, since what says so is the file this device
 * kept. The same file without the flag is the control: its link is made, key and all.
 */
test('a private .torrent gets no share link from its row, before a reload and after', async ({ page }) => {
  test.setTimeout(180_000)
  const KEY = '0123456789abcdef'
  const tracker = `https://tracker.invalid/${KEY}/announce`
  const torrent = (name: string, flag: string) => Buffer.from(
    `d8:announce${tracker.length}:${tracker}4:infod6:lengthi11e4:name${name.length}:${name}`
    + `12:piece lengthi16384e6:pieces20:${'p'.repeat(20)}${flag}ee`,
  )
  await page.goto('/')
  await page.locator('label.file-button input[type=file]').first().setInputFiles([
    { name: 'Private pack.torrent', mimeType: 'application/x-bittorrent', buffer: torrent('Private pack', '7:privatei1e') },
    { name: 'Public pack.torrent', mimeType: 'application/x-bittorrent', buffer: torrent('Public pack', '') },
  ])

  const share = async (name: string) => {
    await page.locator('.torrent', { hasText: name }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Get a share link' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Share link' })).toBeVisible()
    return dialog
  }

  for (const reloaded of [false, true]) {
    if (reloaded) await page.reload()
    for (const name of ['Private pack', 'Public pack']) {
      await expect(page.locator('.torrent', { hasText: name }), `${name} is not listed`).toBeVisible({ timeout: 30_000 })
    }
    // a row still starting is replaced by the engine's, which closes a menu opened on it
    await expect(page.locator('.torrent.starting')).toHaveCount(0, { timeout: 40_000 })

    const refused = await share('Private pack')
    await expect(refused.getByText('No share link for a private torrent.')).toBeVisible({ timeout: 15_000 })
    await expect(refused.getByTestId('embed-url')).toHaveCount(0)
    await refused.getByRole('button', { name: 'Close' }).click()
    await expect(refused).toHaveCount(0)

    const shared = await share('Public pack')
    const link = await shared.getByTestId('embed-url').textContent({ timeout: 15_000 })
    expect(decodeMagnetParam(linkParams(new URL(link ?? ''))), 'the control made no link with its tracker').toContain(KEY)
    await expect(shared.getByText('No share link for a private torrent.')).toHaveCount(0)
    await shared.getByRole('button', { name: 'Close' }).click()
    await expect(shared).toHaveCount(0)
  }

  // the same refusal through Get a share link in a torrent's options, from its card's ... and from its table row's
  for (const view of ['cards', 'table']) {
    if (view === 'table') await page.getByRole('button', { name: 'Table', exact: true }).click()
    const row = page.locator(view === 'cards' ? '.torrent' : '.torrent-table tbody tr', { hasText: 'Private pack' })
    await expect(row, `${view}: Private pack is not listed`).toBeVisible({ timeout: 30_000 })
    await row.getByRole('button', { name: 'Options for Private pack' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Get a share link' }).click()
    const refused = page.getByRole('dialog')
    await expect(refused.getByRole('heading', { name: 'Share link' }), view).toBeVisible()
    await expect(refused.getByText('No share link for a private torrent.'), view).toBeVisible({ timeout: 15_000 })
    await expect(refused.getByTestId('embed-url')).toHaveCount(0)
    await refused.getByRole('button', { name: 'Close' }).click()
    await expect(refused).toHaveCount(0)
  }
})
