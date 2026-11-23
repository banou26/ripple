/*
 * A group shared by its link, through the real engine on both ends: Copy link in one browser, then the link opened in
 * a second one with nothing in it. The second lists the group's torrents as rows not on this device, in a group of
 * the sender's name, and asks nothing again on a reload. No network and no transfer, so this is headless.
 */
import type { BrowserContext, Page } from '@playwright/test'

import { expect, test } from './offline'

import { GROUP_LINK_PREFIX } from '../src/router/group-link'

const MAGNETS = [`magnet:?xt=urn:btih:${'1a'.repeat(20)}&dn=Group.One`, `magnet:?xt=urn:btih:${'2b'.repeat(20)}&dn=Group.Two`]

const str = (value: string) => `${Buffer.byteLength(value)}:${value}`
// a .torrent whose info dictionary says private, as a private tracker hands one out
const MEMBERS = Buffer.from(
  'd' + str('announce') + str('https://members.example/key/announce')
  + str('info') + 'd' + str('length') + 'i11e' + str('name') + str('Members') + str('piece length') + 'i16384e' + str('pieces') + str('p'.repeat(20))
  + str('private') + 'i1e' + 'ee',
)

// the demo torrent would add itself eight seconds in
const prepare = (context: BrowserContext) => context.addInitScript(() => {
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
})

const openGroupMenu = async (page: Page, name: string) => {
  const row = page.locator('.group-row', { hasText: name })
  await row.locator('button.more').click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

test('a group copied by its link opens in another browser as the same group, its torrents not on that device', async ({ page, context, browser }) => {
  test.setTimeout(180_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await prepare(context)
  await page.goto('/')
  for (const magnet of MAGNETS) {
    await page.getByPlaceholder('Add a magnet link').fill(magnet)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
  }
  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: 'Members.torrent', mimeType: 'application/x-bittorrent', buffer: MEMBERS })
  await expect(page.locator('.torrent:not(.group-row) .row-check')).toHaveCount(3, { timeout: 30_000 })
  await page.getByRole('checkbox', { name: 'Select all' }).check()
  await page.locator('.bulk-bar button[aria-haspopup=menu]').click()
  await page.getByRole('menu').getByRole('menuitem', { name: 'New group...' }).click()
  await page.getByRole('dialog').locator('label.name input').fill('Week 2')
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.group-row', { hasText: 'Week 2' })).toBeVisible()
  await openGroupMenu(page, 'Week 2')
  await page.getByRole('dialog').getByRole('button', { name: 'Copy link' }).click()
  await expect(page.locator('.toast')).toHaveText('Link copied, 1 private torrent left out')
  const link = await page.evaluate(() => navigator.clipboard.readText())
  expect(link.startsWith(GROUP_LINK_PREFIX)).toBe(true)

  const other = await browser.newContext()
  await prepare(other)
  const receiver = await other.newPage()
  await receiver.goto(link.replace(GROUP_LINK_PREFIX, '/add#'))
  const dialog = receiver.getByRole('dialog')
  await expect(dialog).toHaveAccessibleName('Week 2', { timeout: 30_000 })
  await expect(dialog.locator('p')).toHaveText('2 torrents')
  await expect(receiver).toHaveURL(/\/$/u)
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(receiver.locator('.group-row', { hasText: 'Week 2' })).toBeVisible()
  const rows = receiver.locator('.group-children .torrent')
  await expect(rows).toHaveCount(2, { timeout: 30_000 })
  for (const row of await rows.all()) await expect(row).toHaveAttribute('data-state', 'missing')
  await expect(receiver.getByRole('heading', { name: 'Not on this device 1' })).toBeVisible()

  await receiver.reload()
  await expect(receiver.locator('.group-row', { hasText: 'Week 2' })).toBeVisible({ timeout: 30_000 })
  await expect(rows).toHaveCount(2, { timeout: 30_000 })
  await expect(dialog).toHaveCount(0)
  await other.close()
})
