/*
 * Several torrents removed in one action, through the real engine: three made on this device, two ticked, one
 * confirmation, and after a reload the two are still gone and the third is still there.
 *
 * Ticking a row is not the selection that fills the detail panel, so the panel stays on the torrent it showed, and an
 * Escape clears the ticks before it would close the panel. The bar's Pause and Resume reach the ticked rows alone. Select
 * all takes the rows the filter shows, and no other. The removals are written where the cloud backup reads them
 * (`ripple:removed`), as a single row's Remove writes its own.
 *
 * The pickers are deleted, so each pick goes through the ponyfill's file input and is copied into browser storage,
 * as in long-name-copy.spec.ts. No network and no transfer, so this is headless.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '@playwright/test'

const NAMES = ['Bulk.One.bin', 'Bulk.Two.bin', 'Bulk.Three.bin']

/** One key of the raw idb-keyval store, which is where the worker keeps the list and the removals. */
const stored = (key: string) => new Promise<unknown>((resolve) => {
  const request = indexedDB.open('keyval-store')
  request.onerror = () => resolve('open failed')
  request.onsuccess = () => {
    const read = request.result.transaction('keyval', 'readonly').objectStore('keyval').get(key)
    read.onsuccess = () => resolve(read.result)
    read.onerror = () => resolve('read failed')
  }
})

/** One file per name in this test's output folder, each with different bytes, so each makes its own info hash. */
const filesFor = async (names: readonly string[]) => {
  const fs = await import('node:fs')
  const nodePath = await import('node:path')
  const dir = test.info().outputPath()
  fs.mkdirSync(dir, { recursive: true })
  return names.map((name, i) => {
    const file = nodePath.join(dir, name)
    fs.writeFileSync(file, Buffer.alloc(150_000 + i * 1_000, i + 1))
    return file
  })
}

/** Every page of `page`'s context opens with no demo torrent and no system pickers. */
const prepare = (page: Page) => page.context().addInitScript(() => {
  // the demo torrent would add itself eight seconds in
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
  delete (window as any).showDirectoryPicker
  delete (window as any).showOpenFilePicker
})

/** Makes a torrent of each file on this device, and returns their info hashes. */
const make = async (page: Page, files: readonly string[]) => {
  const hashes: string[] = []
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  const dialog = page.getByRole('dialog')
  for (const [i, file] of files.entries()) {
    const chooser = page.waitForEvent('filechooser')
    await dialog.getByRole('button', { name: 'Choose a file', exact: true }).click()
    await (await chooser).setFiles(file)
    await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
    await expect(dialog.getByText('is being shared')).toBeVisible({ timeout: 120_000 })
    hashes.push((await dialog.locator('code').first().textContent())!)
    if (i < files.length - 1) await dialog.getByRole('button', { name: 'Create another' }).click()
  }
  await dialog.getByRole('button', { name: 'Close' }).click()
  expect(new Set(hashes).size).toBe(files.length)
  return hashes
}

const tickOf = (page: Page) => (name: string) => page.getByRole('checkbox', { name: `Select ${name}` })
const badgeOf = (page: Page) => (name: string) => page.locator('.torrent', { hasText: name }).locator('.badge')

test('two of three torrents removed in one action stay removed after a reload, and the third stays', async ({ page }) => {
  test.setTimeout(300_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await prepare(page)
  await page.goto('/')
  const hashes = await make(page, await filesFor(NAMES))

  const tick = tickOf(page)
  const badge = badgeOf(page)
  // checked and sharing, so the bar is what the steps below test and not a check still waiting its turn
  for (const name of NAMES) await expect(badge(name)).toHaveText('Seeding', { timeout: 120_000 })
  const [one, two, three] = NAMES as [string, string, string]

  // the detail panel shows the third, and ticking the other two leaves it on the third
  await page.locator('.torrent', { hasText: three }).locator('.title').click()
  const details = page.locator('main ~ section')
  await expect(details).toHaveAttribute('aria-label', `Details for ${three}`)
  await tick(one).check()
  await tick(two).check()
  const bar = page.locator('.bulk-bar')
  await expect(bar).toContainText('2 selected')
  await expect(details).toHaveAttribute('aria-label', `Details for ${three}`)
  // under the list, so no row and no focused control is ever behind it
  const [rows, held] = await Promise.all([page.locator('main').boundingBox(), bar.boundingBox()])
  expect(held!.y).toBeGreaterThanOrEqual(rows!.y + rows!.height)

  // Pause and Resume reach the ticked rows and no other, and Pause is offered only while it would change one
  await bar.getByRole('button', { name: 'Pause' }).click()
  await expect(badge(one)).toHaveText('Paused', { timeout: 30_000 })
  await expect(badge(two)).toHaveText('Paused', { timeout: 30_000 })
  await expect(bar.getByRole('button', { name: 'Pause' })).toBeDisabled()
  await expect(badge(three)).not.toHaveText('Paused')
  await bar.getByRole('button', { name: 'Resume' }).click()
  await expect(badge(one)).not.toHaveText('Paused', { timeout: 30_000 })
  await expect(badge(two)).not.toHaveText('Paused', { timeout: 30_000 })
  await expect(bar.getByRole('button', { name: 'Pause' })).toBeEnabled()

  // Escape clears the ticks first, and the panel, which closes on an Escape of its own, stays open
  await bar.getByRole('button', { name: 'Remove' }).press('Escape')
  await expect(bar).toHaveCount(0)
  await expect(tick(one)).not.toBeChecked()
  await expect(details).toHaveAttribute('aria-label', `Details for ${three}`)

  // the third made temporary, so a filter can hide it: Select all then takes only what the filter shows
  await page.locator('.torrent', { hasText: three }).getByRole('button', { name: `Options for ${three}` }).click()
  await page.getByRole('switch', { name: 'Keep this download' }).click()
  await page.getByRole('button', { name: 'Let Ripple delete it' }).click()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Kept', exact: true }).click()
  await expect(page.locator('.torrent', { hasText: three })).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Select all' }).check()
  await expect(bar).toContainText('2 selected')
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(tick(three)).not.toBeChecked()
  await expect(tick(one)).toBeChecked()
  await expect(tick(two)).toBeChecked()
  await expect(bar).toContainText('2 selected')

  await bar.getByRole('button', { name: 'Remove' }).click()
  const confirm = page.getByRole('dialog')
  await expect(confirm.getByRole('heading')).toHaveText('Remove 2 torrents?')
  await confirm.getByRole('button', { name: 'Remove and delete' }).click()

  await expect(page.locator('.torrent', { hasText: one })).toHaveCount(0)
  await expect(page.locator('.torrent', { hasText: two })).toHaveCount(0)
  await expect(tick(three)).toBeVisible()
  await expect(bar).toHaveCount(0)

  // written down where the cloud backup reads removals, as a single row's Remove is
  await expect.poll(async () => {
    const removed = await page.evaluate(stored, 'ripple:removed') as { infoHash: string }[] | undefined
    return (removed ?? []).map((r) => r.infoHash).sort((a, b) => a.localeCompare(b))
  }, { timeout: 30_000 }).toEqual(hashes.slice(0, 2).sort((a, b) => a.localeCompare(b)))

  await page.reload()
  // the control: the third is back as a live row, so the list and the engine have both answered
  await expect(tick(three)).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.torrent', { hasText: one })).toHaveCount(0)
  await expect(page.locator('.torrent', { hasText: two })).toHaveCount(0)
  const list = await page.evaluate(stored, 'ripple:torrents') as { infoHash: string }[]
  expect(list.map((e) => e.infoHash)).toEqual([hashes[2]])
  expect(pageErrors).toEqual([])
})

/*
 * libtorrent checks one torrent at a time and starts the next at most once a second, so the last of four made back to
 * back reads Checking for a few seconds before its check begins. A pause landing then stops the check where it is, and
 * that torrent has to read Paused, with a Resume on its row and in the bar, or nothing can ever start it again.
 */
test('a torrent paused from the bar while it waits for its check reads Paused, and resumes from its row', async ({ page }) => {
  test.setTimeout(300_000)
  const names = ['Waiting.One.bin', 'Waiting.Two.bin', 'Waiting.Three.bin', 'Waiting.Four.bin'] as const
  const name = names[3]
  await prepare(page)
  await page.goto('/')
  await make(page, await filesFor(names))

  await tickOf(page)(name).check({ timeout: 120_000 })
  // pressed in the first frame the row reads Checking
  await page.waitForFunction((name) => {
    const row = [...document.querySelectorAll('.torrent')].find((r) => r.textContent?.includes(name))
    const pause = document.querySelector<HTMLButtonElement>('.bulk-bar button[aria-label="Pause"]')
    if (row?.querySelector('.badge')?.textContent !== 'Checking' || !pause || pause.disabled) return false
    pause.click()
    return true
  }, name, { timeout: 60_000, polling: 'raf' })

  const row = page.locator('.torrent', { hasText: name })
  await expect(badgeOf(page)(name)).toHaveText('Paused', { timeout: 30_000 })
  // the control: nothing of it checked yet, so the pause did land before the check ran
  await expect(row).toContainText('0 B /')
  await expect(page.locator('.bulk-bar').getByRole('button', { name: 'Resume' })).toBeEnabled()
  await row.getByRole('button', { name: `Resume ${name}` }).click()
  await expect(badgeOf(page)(name)).toHaveText('Seeding', { timeout: 60_000 })
})

/*
 * A handover gives every row a new engine, and for a moment none: the rows are back to "Connecting" and no command can
 * reach them. A removal confirmed in that moment is sent nowhere, so its torrents stay ticked and the bar comes back
 * with them, rather than the ticks going as though the removal were done.
 */
test('a removal confirmed while the engine moves to another tab leaves its torrents ticked, and works after', async ({ page }) => {
  test.setTimeout(300_000)
  const names = ['Handover.One.bin', 'Handover.Two.bin'] as const
  await prepare(page)
  await page.goto('/')
  await make(page, await filesFor(names))

  const other = await page.context().newPage()
  await other.goto('/')
  const tick = tickOf(other)
  for (const name of names) await tick(name).check({ timeout: 120_000 })
  const bar = other.locator('.bulk-bar')
  await expect(bar).toContainText('2 selected')
  await bar.getByRole('button', { name: 'Remove' }).click()
  await expect(other.getByRole('dialog').getByRole('heading')).toHaveText('Remove 2 torrents?')

  // the tab running the engine goes; the press lands in the same frame that finds both rows reconnecting
  await page.close()
  await other.waitForFunction(() => {
    if (document.querySelectorAll('.torrent.starting').length < 2) return false
    const yes = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Remove and delete')
    yes?.click()
    return !!yes
  }, undefined, { timeout: 60_000 })

  // back under this tab's engine, nothing removed and both still ticked
  await expect(tick(names[0])).toBeChecked({ timeout: 120_000 })
  await expect(tick(names[1])).toBeChecked()
  await expect(bar).toContainText('2 selected')
  expect(await other.evaluate(stored, 'ripple:removed') ?? []).toEqual([])

  // and the same bar removes them now, through this engine's handles
  await bar.getByRole('button', { name: 'Remove' }).click()
  await other.getByRole('dialog').getByRole('button', { name: 'Remove and delete' }).click()
  await expect(other.locator('.torrent')).toHaveCount(0, { timeout: 30_000 })
})
