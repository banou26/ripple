/*
 * Several torrents removed in one action, through the real engine: three made on this device, two ticked, one
 * confirmation, and after a reload the two are still gone and the third is still there.
 *
 * Ticking a row is not the selection that fills the detail panel, so the panel stays on the torrent it showed, and an
 * Escape clears the ticks before it would close the panel. The bar's Stop and Start reach the ticked rows alone. Select
 * all takes the rows the filter shows, and no other. The removals are written where the cloud backup reads them
 * (`ripple:removed`), as a single row's Remove writes its own.
 *
 * The pickers are deleted, so each pick goes through the ponyfill's file input and is copied into browser storage,
 * as in long-name-copy.spec.ts. No network and no transfer, so this is headless.
 */
import type { Page } from '@playwright/test'

import { expect, test } from './offline'

import { REORDER_QUIET_MS } from '../src/torrent/list-view'
import { magnetParam } from '../src/torrent/magnet'

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

/** Picks the row named `row` from the menu of the toolbar's chip named `chip`. */
const fromChip = async (page: Page, chip: RegExp, row: RegExp | string) => {
  await page.getByRole('button', { name: chip }).click()
  await page.getByRole('menu').getByRole('menuitemradio', { name: row, exact: true }).click()
}

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

/** Every heading the card named `name` stood under while `ms` passed, looked at ten times a second. */
const headingsOver = ({ name, ms }: { name: string, ms: number }) => new Promise<string[]>((resolve) => {
  const seen = new Set<string>()
  const end = performance.now() + ms
  const look = () => {
    let el = [...document.querySelectorAll('main .torrent')].find((card) => card.querySelector('.title strong')?.textContent === name)?.previousElementSibling
    while (el && !el.matches('.group-head')) el = el.previousElementSibling
    seen.add(el ? (el as HTMLElement).innerText.replace(/\s+/gu, ' ') : 'none')
    if (performance.now() < end) setTimeout(look, 100)
    else resolve([...seen])
  }
  look()
})

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

  // finished, so the bar says Stop and Start; each reaches the ticked rows and no other, and Stop is offered only while
  // it would change one. Stopped, a torrent reads Completed, and started again it seeds again.
  await bar.getByRole('button', { name: 'Stop' }).click()
  await expect(badge(one)).toHaveText('Completed', { timeout: 30_000 })
  await expect(badge(two)).toHaveText('Completed', { timeout: 30_000 })
  await expect(bar.getByRole('button', { name: 'Stop' })).toBeDisabled()
  await expect(badge(three)).toHaveText('Seeding')
  await bar.getByRole('button', { name: 'Start' }).click()
  await expect(badge(one)).toHaveText('Seeding', { timeout: 30_000 })
  await expect(badge(two)).toHaveText('Seeding', { timeout: 30_000 })
  await expect(bar.getByRole('button', { name: 'Stop' })).toBeEnabled()

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
  await fromChip(page, /^Show: /u, /^Kept /u)
  await expect(page.locator('.torrent', { hasText: three })).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Select all' }).check()
  await expect(bar).toContainText('2 selected')
  await fromChip(page, /^Show: /u, /^All /u)
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
 * A shift+click on a box ticks every row from the box clicked before it, in the order the list draws them: by name, which
 * is not the order the torrents were made in, and in the cards under their headings, so a download with nobody to fetch
 * it from stands above the three made here, which is not the order of their names. Then, the other way round and with
 * no headings, in the table.
 */
test('a shift+click ticks the run of rows between two boxes, in the order each view draws them', async ({ page }) => {
  test.setTimeout(300_000)
  const names = ['Run.Cherry.bin', 'Run.Apple.bin', 'Run.Date.bin']
  await prepare(page)
  await page.goto('/')
  await page.getByPlaceholder('Add a magnet link').fill(`magnet:?xt=urn:btih:${'3c'.repeat(20)}&dn=Run.Banana.bin`)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await make(page, await filesFor(names))

  const tick = tickOf(page)
  for (const name of [...names, 'Run.Banana.bin']) await expect(tick(name)).toBeVisible({ timeout: 120_000 })
  await fromChip(page, /^Sort by /u, 'Name')
  // every made torrent past its check, so the headings stand as below
  await expect(page.getByRole('heading', { name: 'Done 3' })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('heading', { name: 'Downloading 1' })).toBeVisible()
  const bar = page.locator('.bulk-bar')
  // the boxes from the top of the list down
  const ticked = () => page.locator('.row-check input').evaluateAll((boxes) => boxes.map((box) => (box as HTMLInputElement).checked))

  // Banana under Downloading, then Apple, Cherry, Date under Done
  await tick('Run.Apple.bin').click()
  await tick('Run.Date.bin').click({ modifiers: ['Shift'] })
  await expect(bar).toContainText('3 selected')
  expect(await ticked()).toEqual([false, true, true, true])

  await bar.getByRole('button', { name: 'Clear selection' }).click()
  await page.getByRole('button', { name: 'Table' }).click()
  // the key already sorted by, chosen again, flips the direction
  await fromChip(page, /^Sort by /u, 'Name')
  // Date, Cherry, Banana, Apple
  await tick('Run.Date.bin').click()
  await tick('Run.Banana.bin').click({ modifiers: ['Shift'] })
  await expect(bar).toContainText('3 selected')
  expect(await ticked()).toEqual([true, true, true, false])
  // Cherry is ticked, so the run from Banana unticks
  await tick('Run.Cherry.bin').click({ modifiers: ['Shift'] })
  await expect(bar).toContainText('1 selected')
  expect(await ticked()).toEqual([true, false, false, false])
})

/*
 * A card paused from its own row keeps its heading while the pointer is in the list, so the card under it does not
 * slide under the pointer, and goes under Paused once the pointer leaves. Two downloads with nobody to fetch from, so
 * no state changes but the pause.
 */
test('a card paused under the pointer keeps its heading until the pointer leaves the list', async ({ page }) => {
  await prepare(page)
  await page.goto('/')
  for (const [hash, name] of [['4d', 'Hold.One.bin'], ['5e', 'Hold.Two.bin']] as const) {
    await page.getByPlaceholder('Add a magnet link').fill(`magnet:?xt=urn:btih:${hash.repeat(20)}&dn=${name}`)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: 'Downloading 2' })).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Pause Hold.One.bin' }).click({ timeout: 60_000 })
  await expect(badgeOf(page)('Hold.One.bin')).toHaveText('Paused', { timeout: 30_000 })
  expect(await page.evaluate(headingsOver, { name: 'Hold.One.bin', ms: REORDER_QUIET_MS + 1_500 })).toEqual(['Downloading 2'])

  await page.getByRole('button', { name: /^Sort by /u }).hover()
  await expect(page.getByRole('heading', { name: 'Paused 1' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('heading', { name: 'Downloading 1' })).toBeVisible()
})

/*
 * libtorrent checks one torrent at a time and starts the next at most once a second, so the last of four made back to
 * back reads Checking for a few seconds before its check begins. Its Pause, pressed from the bar in the first frame it
 * reads Checking, lands then and stops the check where it is, and that torrent has to read Paused, with a Resume on its
 * row and in the bar, or nothing can ever start it again.
 */
const pauseBeforeCheck = async (page: Page, names: readonly string[]) => {
  const name = names.at(-1)!
  await prepare(page)
  await page.goto('/')
  await make(page, await filesFor(names))

  await tickOf(page)(name).check({ timeout: 120_000 })
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
  return { name, row }
}

test('a torrent paused from the bar while it waits for its check reads Paused, and resumes from its row', async ({ page }) => {
  test.setTimeout(300_000)
  const { name, row } = await pauseBeforeCheck(page, ['Waiting.One.bin', 'Waiting.Two.bin', 'Waiting.Three.bin', 'Waiting.Four.bin'])
  await expect(page.locator('.bulk-bar').getByRole('button', { name: 'Resume' })).toBeEnabled()
  await row.getByRole('button', { name: `Resume ${name}` }).click()
  await expect(badgeOf(page)(name)).toHaveText('Seeding', { timeout: 60_000 })
})

// A save of the engine's state while the check had not run held no piece, and a reload trusted it, so Resume then
// downloaded the whole torrent again from a swarm that does not exist. Holding its files, it reads Completed.
test('a torrent paused before its check still holds its files after a reload, and starts to Seeding', async ({ page }) => {
  test.setTimeout(300_000)
  const { name, row } = await pauseBeforeCheck(page, ['Reload.One.bin', 'Reload.Two.bin', 'Reload.Three.bin', 'Reload.Four.bin'])
  await page.reload()
  await expect(badgeOf(page)(name)).toHaveText('Completed', { timeout: 120_000 })
  await row.getByRole('button', { name: `Start ${name}` }).click()
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

/*
 * Copy magnets puts the ticked torrents' magnets on the clipboard, one a line in the order the list draws them, and
 * leaves out the one whose kept .torrent says it is private, as a share link does. With only that one ticked nothing is
 * written, and the clipboard keeps what it held.
 */
test('Copy magnets copies the ticked torrents\' magnets in list order, and leaves a private one out', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await prepare(page)
  await page.goto('/')
  for (const magnet of [`magnet:?xt=urn:btih:${'1a'.repeat(20)}&dn=Copy.One`, `magnet:?xt=urn:btih:${'2b'.repeat(20)}&dn=Copy.Two`]) {
    await page.getByPlaceholder('Add a magnet link').fill(magnet)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
  }
  const str = (value: string) => `${Buffer.byteLength(value)}:${value}`
  const members = Buffer.from(
    'd' + str('announce') + str('https://members.example/key/announce')
    + str('info') + 'd' + str('length') + 'i11e' + str('name') + str('Members') + str('piece length') + 'i16384e' + str('pieces') + str('p'.repeat(20))
    + str('private') + 'i1e' + 'ee',
  )
  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: 'Members.torrent', mimeType: 'application/x-bittorrent', buffer: members })
  // a box once the engine has reported each row, which Select all takes
  await expect(page.locator('.torrent .row-check')).toHaveCount(3, { timeout: 30_000 })

  await page.getByRole('checkbox', { name: 'Select all' }).check()
  const bar = page.locator('.bulk-bar')
  await expect(bar).toContainText('3 selected')
  await bar.getByRole('button', { name: 'Copy magnets' }).click()
  await expect(page.locator('.toast')).toHaveText('2 magnets copied, 1 private torrent left out')
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  const drawn = (await page.locator('.torrent .title strong').allTextContents()).filter((name) => name !== 'Members')
  expect(copied.split('\n').map((magnet) => magnetParam(magnet, 'dn'))).toEqual(drawn)

  for (const name of drawn) await tickOf(page)(name).uncheck()
  await expect(bar).toContainText('1 selected')
  await bar.getByRole('button', { name: 'Copy magnets' }).click()
  await expect(page.locator('.toast')).toHaveText('0 magnets copied, 1 private torrent left out')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copied)
})
