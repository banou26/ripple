/*
 * Drag-and-drop, keyboard (Alt+ArrowUp / Alt+ArrowDown), and Custom-sort menu reordering
 * for top-level entries, groups, and group members across Card and Table views.
 */
import type { Locator, Page } from '@playwright/test'

import { expect, test } from './offline'

const GB = 1_000_000_000
const magnetOf = (hash: string, name: string) => `magnet:?xt=urn:btih:${hash.repeat(40)}&dn=${name}`
const uptime = (seedingSeconds = 0) => ({ activeSeconds: seedingSeconds, seedingSeconds })
const SEEDING = { state: 5, progress: 1, totalDone: 4.5 * GB, totalWanted: 4.5 * GB, downloadRate: 0, numPeers: 1 }

const snapshot = (handle: number, hash: string, name: string, status: object, over: object = {}) => ({
  handle,
  magnet: magnetOf(hash, name),
  files: { files: [{ path: `${name}.mkv`, size: 4.5 * GB }], contentSize: 4.5 * GB, pieceLength: 16_384 },
  status: { state: 3, paused: false, progress: 0.5, totalDone: 2.25 * GB, totalWanted: 4.5 * GB, downloadRate: 8_700_000, uploadRate: 120_000, numPeers: 82, numSeeds: 12, savePath: `/dl/${hash.repeat(40)}`, ...status },
  bitfield: null,
  recovery: null,
  userPaused: false,
  windowed: false,
  swarmDownloads: -1,
  uptime: uptime(),
  sessionUptime: uptime(),
  totals: {},
  ...over,
})

const entry = (hash: string, name: string, over: object = {}) => ({
  infoHash: hash.repeat(40),
  magnet: magnetOf(hash, name),
  name,
  size: 4.5 * GB,
  addedAt: 1,
  started: true,
  ...over,
})

const TORRENTS = [
  snapshot(1, 'a', 'Some.Release.Name.S01.1080p', {}),
  snapshot(2, 'b', 'A.Season.Pack', SEEDING, {
    files: { files: [{ path: 'one.mkv', size: 2 * GB }, { path: 'two.mkv', size: 2.5 * GB }], contentSize: 4.5 * GB, pieceLength: 16_384 },
    uptime: uptime(7_500),
  }),
  snapshot(4, 'd', 'Having.Trouble', {}, { recovery: { reason: 'stalled', attempt: 1, retryAt: Date.now() + 60_000 } }),
  snapshot(7, '5', 'Stalled', { downloadRate: 0 }),
  snapshot(11, '9', 'Watched.Film', { ...SEEDING, paused: true }, { userPaused: true }),
]

const LIST = [
  entry('a', 'Some.Release.Name.S01.1080p'),
  entry('b', 'A.Season.Pack'),
  entry('d', 'Having.Trouble'),
  entry('5', 'Stalled'),
  entry('9', 'Watched.Film'),
]

const standInWorker = () => {
  localStorage.setItem('ripple:demo-seeded', '1')
  const heard = new Set<EventListener>()
  const engine = (data: unknown) => { for (const listener of heard) listener(new MessageEvent('message', { data })) }
  Object.defineProperty(window, 'Worker', {
    value: class {
      addEventListener (type: string, listener: EventListener) { if (type === 'message') heard.add(listener) }
      removeEventListener (_: string, listener: EventListener) { heard.delete(listener) }
      postMessage () {}
      terminate () {}
    },
  })
  Object.assign(window, {
    engineListens: () => heard.size > 0,
    engine,
  })
}

const drawn = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

const library = async (page: Page, list: object[], torrents: object[]) => {
  await page.waitForFunction(() => (window as unknown as { engineListens?: () => boolean }).engineListens?.())
  await page.evaluate(([l, t]) => {
    const { engine } = window as unknown as { engine: (data: object) => void }
    engine({ type: 'ready' })
    engine({ type: 'list', list: l })
    engine({
      type: 'state',
      torrents: t,
      rateLimits: { down: 5_000_000, up: 0 },
      reachable: { port: 41337, listenFailed: [], listeners: [{ up: true }], portOpen: true, inbound: 3 },
      inboundNow: { total: 1, byTransport: { utp: 1 } },
    })
  }, [list, torrents])
  await drawn(page)
}

const dragRow = async (page: Page, source: Locator, target: Locator, yRatio = 0.5) => {
  await source.scrollIntoViewIfNeeded()
  const srcBox = (await source.boundingBox())!
  await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(srcBox.x + srcBox.width / 2 + 8, srcBox.y + srcBox.height / 2, { steps: 2 })
  await target.scrollIntoViewIfNeeded()
  const dstBox = (await target.boundingBox())!
  await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height * yRatio, { steps: 4 })
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(standInWorker)
})

test('dragging reorders top-level and nested rows to Custom sort, drops torrents into groups, and saves preset icons', async ({ page }) => {
  await page.goto('/')
  await library(page, LIST, TORRENTS)
  await page.locator('.list-toolbar .chip.new-group').click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('label.name input').fill('Shelf')
  await dialog.getByRole('button', { name: 'Film icon' }).click()
  await dialog.locator('button[type=submit]').click()

  const shelf = page.locator('.group-row', { hasText: 'Shelf' })
  await expect(shelf).toBeVisible()
  await expect(shelf.locator('svg.lucide-film')).toBeVisible()

  await page.locator('.list-toolbar .chip.new-group').click()
  await dialog.locator('label.name input').fill('Backup')
  await dialog.locator('button[type=submit]').click()
  const backup = page.locator('.group-row', { hasText: 'Backup' })
  await expect(backup).toBeVisible()

  const film = page.locator('main > .torrent:not(.group-row)', { hasText: 'Watched.Film' })
  const pack = page.locator('main > .torrent:not(.group-row)', { hasText: 'A.Season.Pack' })

  // Dragging a loose torrent into the middle of Shelf adds it without activating the file-drop overlay.
  await dragRow(page, film, shelf)
  await expect(page.locator('[data-drag]')).toHaveCount(0)
  await expect(page.locator('.group-children .torrent .title')).toHaveText(['Watched.Film'])

  await dragRow(page, pack, shelf)
  await expect(page.locator('.group-children .torrent')).toHaveCount(2)
  const beforeNested = await page.locator('.group-children .torrent .title').allTextContents()
  const firstChild = page.locator('.group-children .torrent').nth(0)
  const secondChild = page.locator('.group-children .torrent').nth(1)
  await dragRow(page, firstChild, secondChild, 0.85)
  await expect(page.locator('.list-toolbar .chip.sort .value')).toHaveText('Custom')
  await expect.poll(() => page.locator('.group-children .torrent .title').allTextContents()).toEqual([...beforeNested].reverse())

  // Reorder top-level Shelf above Backup in Done category, then reload to confirm Custom order persists.
  const beforeTop = await page.locator('.group-row .title strong').allTextContents()
  expect(beforeTop).toEqual(['Backup', 'Shelf'])
  await dragRow(page, shelf, backup, 0.15)
  await expect.poll(() => page.locator('.group-row .title strong').allTextContents()).toEqual(['Shelf', 'Backup'])

  await page.goto('/')
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.list-toolbar .chip.sort .value')).toHaveText('Custom')
  await expect(page.locator('.group-row .title strong')).toHaveText(['Shelf', 'Backup'])
})

test('dragging a loose torrent onto another creates a folder on accept, moves between folders, and works in table view', async ({ page }) => {
  await page.goto('/')
  await library(page, LIST, TORRENTS)

  const dialog = page.getByRole('dialog')
  await page.locator('.list-toolbar .chip.new-group').click()
  await dialog.locator('label.name input').fill('Shelf')
  await dialog.locator('button[type=submit]').click()
  const shelf = page.locator('.group-row', { hasText: 'Shelf' })
  await expect(shelf).toBeVisible()

  const film = page.locator('main > .torrent:not(.group-row)', { hasText: 'Watched.Film' })
  const pack = page.locator('main > .torrent:not(.group-row)', { hasText: 'A.Season.Pack' })

  await dragRow(page, pack, film)
  await expect(page.locator('[data-drag]')).toHaveCount(0)
  await expect(dialog).toHaveAccessibleName('New group')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(film).toBeVisible()
  await expect(pack).toBeVisible()

  await dragRow(page, pack, film)
  await expect(dialog).toHaveAccessibleName('New group')
  await dialog.locator('label.name input').fill('Dropped')
  await dialog.locator('button[type=submit]').click()

  const dropped = page.locator('.group-row', { hasText: 'Dropped' })
  await expect(dropped).toBeVisible()
  await expect(dropped.locator('.group-count')).toHaveText('2')
  await expect(film).toHaveCount(0)
  await expect(pack).toHaveCount(0)
  await expect.poll(() => page.locator('.group-children .torrent .title').allTextContents()).toEqual(['Watched.Film', 'A.Season.Pack'])

  const childPack = page.locator('.group-children .torrent', { hasText: 'A.Season.Pack' })
  await dragRow(page, childPack, shelf)
  await expect(dropped.locator('.group-count')).toHaveText('1')
  await expect(dropped.locator('.group-poster .folder-tab')).toBeVisible()
  await expect(dropped.locator('.group-poster img.poster')).toHaveCount(0)
  await expect(dropped.locator('.group-count svg.lucide-folder')).toBeVisible()
  await expect(dropped.locator('button.expand-btn')).toBeVisible()
  await expect(shelf.locator('.group-count')).toHaveText('1')
  await expect(film).toHaveCount(0)
  await expect(pack).toHaveCount(0)

  await page.locator('.list-toolbar').getByRole('button', { name: 'Table' }).click()
  await expect(page.locator('.torrent-table')).toBeVisible()
  const stalledRow = page.locator('.torrent-table tbody tr:not(.group-row):not(.group-child)', { hasText: 'Stalled' })
  const troubleRow = page.locator('.torrent-table tbody tr:not(.group-row):not(.group-child)', { hasText: 'Having.Trouble' })
  await dragRow(page, troubleRow, stalledRow)
  await expect(dialog).toHaveAccessibleName('New group')
  await dialog.locator('label.name input').fill('Table Group')
  await dialog.locator('button[type=submit]').click()

  const tableGroup = page.locator('.torrent-table tbody tr.group-row', { hasText: 'Table Group' })
  await expect(tableGroup).toBeVisible()
  await expect(tableGroup.locator('.group-count')).toHaveText('2')
  await expect(stalledRow).toHaveCount(0)
  await expect(troubleRow).toHaveCount(0)
  await expect(page.locator('.torrent-table tbody tr.group-child .title', { hasText: 'Stalled' })).toBeVisible()
  await expect(page.locator('.torrent-table tbody tr.group-child .title', { hasText: 'Having.Trouble' })).toBeVisible()
})

test('Alt+Arrow keyboard shortcuts and Custom-sort options menu reorder rows and persist across reload', async ({ page }) => {
  await page.goto('/')
  await library(page, LIST, TORRENTS)

  await page.locator('.list-toolbar .chip.new-group').click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('label.name input').fill('Alpha')
  await dialog.locator('button[type=submit]').click()
  await page.locator('.list-toolbar .chip.new-group').click()
  await dialog.locator('label.name input').fill('Beta')
  await dialog.locator('button[type=submit]').click()

  // Default Date added (newest first) puts Beta before Alpha and does not expose Custom List order menu actions.
  const alpha = page.locator('.group-row', { hasText: 'Alpha' })
  await alpha.locator('button.more').click()
  await expect(dialog.locator('button.opt .label', { hasText: 'Move up' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Alt+ArrowUp on focused Alpha swaps it before Beta and switches sort to Custom.
  await expect(page.locator('.group-row .title strong')).toHaveText(['Beta', 'Alpha'])
  await alpha.focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(page.locator('.list-toolbar .chip.sort .value')).toHaveText('Custom')
  await expect.poll(() => page.locator('.group-row .title strong').allTextContents()).toEqual(['Alpha', 'Beta'])

  // In Custom sort, Move down on Alpha swaps it back after Beta via options menu (Move up hidden at index 0).
  await alpha.locator('button.more').click()
  await expect(dialog.locator('button.opt .label', { hasText: 'Move up' })).toHaveCount(0)
  await dialog.locator('button.opt', { hasText: 'Move down' }).click()
  await expect.poll(() => page.locator('.group-row .title strong').allTextContents()).toEqual(['Beta', 'Alpha'])

  await page.goto('/')
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.list-toolbar .chip.sort .value')).toHaveText('Custom')
  await expect(page.locator('.group-row .title strong')).toHaveText(['Beta', 'Alpha'])
})
