/*
 * A download that finishes while the tab is hidden, against the real engine and the built page: the tab's title counts
 * it, its icon takes a dot and the app's badge the count, and all three go once the tab is seen again.
 *
 * Added with nothing on disk, the torrent downloads from nobody. Its bytes are then put where the engine reads them and
 * a recheck finds them, which finishes it. No peer and no transfer, so this is headless.
 */
import { createHash } from 'node:crypto'

import { expect, test } from './offline'

const PIECE = 16_384
const NAME = 'Finish'
const FILES = [{ path: 'a.bin', fill: 0x51 }, { path: 'b.bin', fill: 0x52 }]

const bencode = (value: unknown): Buffer => {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
  }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  const record = value as Record<string, unknown>
  return Buffer.concat([Buffer.from('d'), ...Object.keys(record).sort().flatMap((key) => [bencode(key), bencode(record[key])]), Buffer.from('e')])
}

const torrent = () => {
  const all = Buffer.concat(FILES.map(({ fill }) => Buffer.alloc(2 * PIECE, fill)))
  const pieces: Buffer[] = []
  for (let at = 0; at < all.length; at += PIECE) pieces.push(createHash('sha1').update(all.subarray(at, at + PIECE)).digest())
  return bencode({ info: { name: NAME, 'piece length': PIECE, pieces: Buffer.concat(pieces), files: FILES.map(({ path }) => ({ length: 2 * PIECE, path: [path] })) } })
}

const setHidden = (page: import('@playwright/test').Page, hidden: boolean) => page.evaluate((hide) => {
  if (hide) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  else delete (document as { visibilityState?: unknown }).visibilityState
  document.dispatchEvent(new Event('visibilitychange'))
}, hidden)

test('a download finished while the tab is hidden is counted in its title, icon and badge until the tab is seen', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
    const badges: (number | 'cleared')[] = []
    Object.assign(window, { __badges: badges })
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: async (count: number) => { badges.push(count) } })
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: async () => { badges.push('cleared') } })
  })
  const badges = () => page.evaluate(() => (window as unknown as { __badges: unknown[] }).__badges)
  const icon = page.locator('link[rel~="icon"]')

  await page.goto('/')
  const title = await page.title()
  const ordinaryIcon = await icon.getAttribute('href')
  expect(ordinaryIcon).toBeTruthy()

  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${NAME}.torrent`, mimeType: 'application/x-bittorrent', buffer: torrent() })
  const row = page.locator('.torrent', { has: page.locator('.title strong', { hasText: new RegExp(`^${NAME}$`) }) })
  await expect(row.locator('.badge')).toHaveText('Downloading', { timeout: 30_000 })

  // a .torrent add saves under the shared root, where the recheck reads them
  await page.evaluate(async ({ name, files, size }) => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('dl', { create: true })).getDirectoryHandle(name, { create: true })
    for (const { path, fill } of files) {
      const writable = await (await dir.getFileHandle(path, { create: true })).createWritable()
      await writable.write(new Uint8Array(size).fill(fill))
      await writable.close()
    }
  }, { name: NAME, files: FILES, size: 2 * PIECE })

  await setHidden(page, true)
  await row.getByRole('button', { name: `Options for ${NAME}`, exact: true }).click()
  await page.getByRole('dialog').last().getByRole('button', { name: 'Force recheck', exact: true }).click()
  await expect(row.locator('.badge')).toHaveText('Seeding', { timeout: 60_000 })
  await expect(page).toHaveTitle(`(1) ${title}`)
  await expect.poll(() => icon.getAttribute('href'), 'the icon takes its dot').toMatch(/^data:image\/png/)
  expect(await badges()).toEqual([1])

  await setHidden(page, false)
  await expect(page).toHaveTitle(title)
  expect(await icon.getAttribute('href')).toBe(ordinaryIcon)
  expect(await badges()).toEqual([1, 'cleared'])
})
