// Checks in a real browser what this project cannot typecheck: the module worker loads and the libtorrent session reaches a definite state

import type { Locator, Page } from '@playwright/test'

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test } from './offline'

import { addSample } from './sample-offer'

const probeEngine = () => {
  const w = window as any
  w.__engine = new Promise<string>((resolve) => {
    const OriginalWorker = window.Worker
    class Probe extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as { type?: string, list?: unknown } | null
          if (data?.type === 'ready' || data?.type === 'storage-unavailable') resolve(data.type)
          if (data?.type === 'ready') w.__worker = this
          if (data?.type === 'list') w.__list = data.list
        })
      }
    }
    window.Worker = Probe
  })
}

const engineReady = async (page: Page) =>
  expect(await page.evaluate(() => (window as any).__engine as Promise<string>)).toBe('ready')

/** A message to the engine worker, as the page's client sends it. Needs `probeEngine` and `engineReady`. */
const tell = (page: Page, message: object) => page.evaluate((m) => (window as any).__worker.postMessage(m), message)

/**
 * The hashes in the engine's list once it names `hash`. The worker runs commands one at a time, so that list comes
 * after every command sent before the one that added `hash`.
 */
const listedWith = async (page: Page, hash: string) => (await page.waitForFunction((h) => {
  const hashes = ((window as any).__list ?? []).map((e: { infoHash: string }) => e.infoHash) as string[]
  return hashes.includes(h) && hashes
}, hash, { timeout: 30_000 })).jsonValue()

// past DEMO_GRACE (8 s), the longest the offer waits on a cloud restore before it is decided
const DECIDED = 10_000

// no trackers and an infohash nobody seeds, so nothing ever answers and no data moves
const NOBODY = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Own`

const removeRow = async (page: Page, row: Locator) => {
  await row.getByRole('button', { name: /^Options for / }).click()
  await page.getByRole('button', { name: /^Remove and delete the files/ }).click()
  await page.getByRole('button', { name: 'Remove and delete', exact: true }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)
}

const seeded = (page: Page) => page.evaluate(() => localStorage.getItem('ripple:demo-seeded'))

test('the library boots, the engine reports in, and a first run offers the sample instead of adding it', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.addInitScript(probeEngine)

  await page.goto('/')

  await expect(page.getByText('Ripple is open in another tab.')).toHaveCount(0)
  await expect(page.getByText('Ripple', { exact: true })).toBeVisible()
  await engineReady(page)

  // nothing is added until somebody asks: a first run used to add Sintel by itself, 3 to 6 s in
  const offer = page.getByRole('button', { name: 'Add Sintel' })
  await expect(offer).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(DECIDED)
  await expect(page.locator('.torrent')).toHaveCount(0)
  await expect(offer).toBeVisible()

  const row = await addSample(page)
  await expect(offer).toHaveCount(0)
  // started, because somebody asked for it, and temporary, so it stays out of the synced library
  await expect(row.locator('.badge')).not.toHaveText('Paused')
  await expect(row.locator('.temp')).toBeVisible()

  await page.getByPlaceholder('Add a magnet link').fill(
    'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel',
  )
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  /*
   * `.first()`, because a second status can be on screen and it is not this one.
   *
   * The page renders a storage warning as a `status` when the origin is low on room, which never
   * happens on a roomy dev machine and happens on a CI runner, so the bare role matched two elements
   * and failed strict mode. The assertion is about the add's answer, so it names it.
   */
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' }).first())
    .toBeVisible()
  await expect(page.locator('.torrent')).toHaveCount(1)

  await row.getByRole('button', { name: 'Pause' }).click()
  await expect(row.locator('.badge')).toHaveText('Paused')
  // and it STAYS stopped: a pause that quietly lifts itself is the failure this has always watched for
  await page.waitForTimeout(7_000)
  await expect(row.locator('.badge')).toHaveText('Paused')

  await row.getByRole('button', { name: 'Resume' }).click()
  await expect(row.locator('.badge')).not.toHaveText('Paused')
  await expect(row.locator('.badge')).not.toHaveText('Retrying')

  // the sample is temporary, so it is the press that answered the offer, not its row
  await removeRow(page, row)
  await page.waitForTimeout(2_000)
  await expect(offer).toHaveCount(0)

  await page.reload()
  await engineReady(page)
  await page.waitForTimeout(DECIDED)
  await expect(page.locator('main .empty h1')).toBeVisible()
  await expect(offer).toHaveCount(0)

  expect(pageErrors).toEqual([])
})

test('No thanks answers the offer for good in this browser', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.addInitScript(probeEngine)

  await page.goto('/')
  await engineReady(page)
  await page.getByRole('button', { name: 'No thanks' }).click({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Add Sintel' })).toHaveCount(0)

  await page.reload()
  await engineReady(page)
  await page.waitForTimeout(DECIDED)
  await expect(page.locator('main .empty h1')).toBeVisible()
  await expect(page.getByRole('button', { name: /Add Sintel|No thanks/ })).toHaveCount(0)
  await expect(page.locator('.torrent')).toHaveCount(0)

  expect(pageErrors).toEqual([])
})

test('a torrent of one\'s own answers the offer too, and removing it does not bring it back', async ({ page }) => {
  await page.goto('/')
  const offer = page.getByRole('button', { name: 'Add Sintel' })
  await expect(offer).toBeVisible({ timeout: 20_000 })

  await page.getByPlaceholder('Add a magnet link').fill(NOBODY)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const row = page.locator('.torrent').first()
  await expect(row.locator('.title strong')).toHaveText('Own', { timeout: 30_000 })
  await expect(offer).toHaveCount(0)
  // their own add, not the sample: a deliberate add is never temporary
  await expect(row.locator('.temp')).toHaveCount(0)
  // polled: the row draws from the engine's state, a moment before the library list that sets the flag
  await expect.poll(() => seeded(page)).toBe('1')

  await removeRow(page, row)
  await page.waitForTimeout(2_000)
  await expect(offer).toHaveCount(0)
})

test('closing the tab asks first while a torrent of one\'s own downloads, and not once it is paused', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  await page.goto('/')
  await page.getByPlaceholder('Add a magnet link').fill(NOBODY)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const row = page.locator('.torrent').first()
  await expect(row.locator('.badge')).toHaveText('Downloading', { timeout: 30_000 })

  const asked: string[] = []
  page.on('dialog', (dialog) => { asked.push(dialog.type()); void dialog.dismiss() })
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => asked).toEqual(['beforeunload'])
  expect(page.isClosed(), 'the prompt was turned down, so the tab stays').toBe(false)

  await row.getByRole('button', { name: 'Pause Own', exact: true }).click()
  await expect(row.locator('.badge')).toHaveText('Paused')
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => page.isClosed()).toBe(true)
  expect(asked).toEqual(['beforeunload'])
})

test('closing the tab asks from another of its pages too, which the engine goes on downloading behind', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  await page.goto('/')
  await page.getByPlaceholder('Add a magnet link').fill(NOBODY)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.torrent .badge')).toHaveText('Downloading', { timeout: 30_000 })
  await page.getByRole('link', { name: 'Privacy', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible()
  // a frame or two for the library page's effects to end, as they do once it is gone
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  const asked: string[] = []
  page.on('dialog', (dialog) => { asked.push(dialog.type()); void dialog.dismiss() })
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => asked).toEqual(['beforeunload'])
})

test('a link turned down leaves the offer standing', async ({ page }) => {
  await page.goto(`/add?magnet=${encodeURIComponent(NOBODY)}`)
  // listed as temporary while its dialog asks, which is not an answer to the offer
  await expect(page.locator('.torrent .temp')).toHaveCount(1, { timeout: 30_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)

  await expect(page.getByRole('button', { name: 'Add Sintel' })).toBeVisible({ timeout: 20_000 })
  expect(await seeded(page)).toBeNull()
})

test('a link\'s name for a magnet with none is what its dialog and its row show', async ({ page }) => {
  await page.goto(`/add?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${'c'.repeat(40)}`)}&name=${encodeURIComponent('Given by the link')}`)
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Given by the link', { timeout: 30_000 })
  await expect(page.locator('.torrent .title strong')).toHaveText('Given by the link', { timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)
})

/** A paste, or a drag carrying `magnet` and then its drop, handed to the page the way the browser hands them over. */
const handOver = (page: Page, gesture: 'paste' | 'drag' | 'drop', magnet: string) => page.evaluate(([gesture, magnet]) => {
  const data = new DataTransfer()
  data.setData('text/plain', magnet)
  data.setData('text/uri-list', magnet)
  document.body.dispatchEvent(gesture === 'paste'
    ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true })
    : new DragEvent(gesture === 'drag' ? 'dragenter' : 'drop', { dataTransfer: data, bubbles: true, cancelable: true }))
}, [gesture, magnet] as const)

test('a paste or a drop while the add dialog asks leaves the torrent it asks about', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  const dialog = page.getByRole('dialog')
  const OTHER = `magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=Other`

  await handOver(page, 'paste', NOBODY)
  await expect(dialog.locator('h2')).toHaveText('Own')
  await expect(page.locator('.torrent')).toHaveCount(1, { timeout: 30_000 })

  await handOver(page, 'paste', OTHER)
  await handOver(page, 'drag', OTHER)
  await expect(page.locator('[data-drag]')).toHaveCount(0)
  await handOver(page, 'drop', OTHER)
  await expect(dialog.locator('h2')).toHaveText('Own')
  await expect(page.locator('.torrent')).toHaveCount(1)

  // the control: the same drag and drop with no dialog open is an add
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)
  await handOver(page, 'drag', OTHER)
  await expect(page.locator('[data-drag]')).toHaveCount(1)
  await handOver(page, 'drop', OTHER)
  await expect(dialog.locator('h2')).toHaveText('Other')
})

test('Cancel takes back the torrent the add dialog asked about from the moment it is listed', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)

  await handOver(page, 'paste', NOBODY)
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Own')
  // at once: the library lists an add up to one engine state (500 ms) before the engine's state carries it
  await page.waitForFunction(() => document.querySelectorAll('.torrent').length === 1, null, { polling: 'raf' })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)
})

test('Cancel leaves a torrent of their own that a link asked about', async ({ page }) => {
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  // their own torrent with its files on another device, the one kind of theirs a link still asks about
  const mine = 'e'.repeat(40)
  const magnet = `magnet:?xt=urn:btih:${mine}&dn=Mine`
  await tell(page, { type: 'import-list', list: [{ infoHash: mine, magnet, savePath: `/dl/${mine}`, addedAt: 1_000 }], removed: [] })
  await expect(page.locator('.torrent')).toHaveCount(1)
  await page.evaluate((magnet) => {
    history.pushState(null, '', '/?add=' + encodeURIComponent(magnet))
    dispatchEvent(new PopStateEvent('popstate'))
  }, magnet)
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Mine')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await tell(page, { type: 'add-magnet', magnet: NOBODY })
  expect(await listedWith(page, 'a'.repeat(40))).toContain(mine)
})

test('Cancel on a .torrent leaves that torrent when something else opened it meanwhile', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  await page.locator('label.file-button input[type=file]').first().setInputFiles(join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent'))
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Sintel')
  // a stream, say: Temporary, and not the dialog's, which sends a .torrent to the engine only on Add
  const sintel = '08ada5a7a6183aae1e09d831df6748d566095a10'
  await tell(page, { type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${sintel}`, ephemeral: true })
  await expect(page.locator('.torrent .temp')).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await tell(page, { type: 'add-magnet', magnet: NOBODY })
  expect(await listedWith(page, 'a'.repeat(40))).toContain(sintel)
})

test('a magnet that names two torrents is refused rather than listed as one of them', async ({ page }) => {
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)

  await page.getByPlaceholder('Add a magnet link').fill(`magnet:?xt=urn:btih:${'1a'.repeat(20)}&xt.1=urn:btih:${'2b'.repeat(20)}&dn=Two`)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'That is not a valid magnet link' }).first()).toBeVisible()
  await expect(page.locator('.torrent')).toHaveCount(0)
})

test('a torrent in the list is known by its hash in base32 too, typed or sent by a link', async ({ page }) => {
  await page.goto('/')
  const field = page.getByPlaceholder('Add a magnet link')
  await field.fill(NOBODY)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.torrent .title strong')).toHaveText('Own', { timeout: 30_000 })

  // NOBODY's hash, in base32
  const again = `magnet:?xt=urn:btih:${'VK'.repeat(16)}&dn=Again`
  const known = page.getByRole('status').filter({ hasText: 'Already in your list' }).first()
  await field.fill(again)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(known).toBeVisible()
  await expect(known).toHaveCount(0)

  // the same link from another site, with the list already on screen
  await page.evaluate((magnet) => {
    history.pushState(null, '', '/?add=' + encodeURIComponent(magnet))
    dispatchEvent(new PopStateEvent('popstate'))
  }, again)
  await expect(known).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.torrent')).toHaveCount(1)

  // and a player's link back to it, which names the hash as the player's own link spells it
  await page.evaluate((hash) => {
    history.pushState(null, '', '/?torrent=' + hash)
    dispatchEvent(new PopStateEvent('popstate'))
  }, 'vk'.repeat(16))
  await expect(page.locator('.torrent.selected')).toHaveCount(1)
})

test('a link naming the sample by its base32 hash asks about the sample, with its files', async ({ page }) => {
  await page.goto('/')
  await addSample(page, { pause: true })
  await page.evaluate((magnet) => {
    history.pushState(null, '', '/?add=' + encodeURIComponent(magnet))
    dispatchEvent(new PopStateEvent('popstate'))
  }, 'magnet:?xt=urn:btih:BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ&dn=Sintel')
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add torrent' })).toBeEnabled({ timeout: 30_000 })
  await expect(page.locator('.torrent')).toHaveCount(1)
})

test('a .torrent already in the list is said to be there', async ({ page }) => {
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  const open = page.locator('label.file-button input[type=file]').first()
  const sintel = join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent')
  await open.setInputFiles(sintel)
  const row = page.locator('.torrent').first()
  await expect(row.locator('.title strong')).toHaveText('Sintel', { timeout: 30_000 })

  await open.setInputFiles(sintel)
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' }).first()).toBeVisible()
  await expect(page.locator('.torrent')).toHaveCount(1)
})

test('the same .torrent picked twice at once is listed once and said to be there', async ({ page }) => {
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  const buffer = await readFile(join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent'))
  // the page sends the copy before the engine has named the first, so only the engine can say they are one torrent
  await page.locator('label.file-button input[type=file]').first().setInputFiles([
    { name: 'sintel.torrent', mimeType: 'application/x-bittorrent', buffer },
    { name: 'sintel (1).torrent', mimeType: 'application/x-bittorrent', buffer },
  ])
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' }).first()).toBeVisible()
  await expect(page.locator('.torrent .title strong').first()).toHaveText('Sintel', { timeout: 30_000 })
  await expect(page.locator('.torrent')).toHaveCount(1)
})

test('a .torrent for a torrent listed by its base32 hash is said to be there', async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Add a magnet link').fill('magnet:?xt=urn:btih:BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ&dn=Sintel')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.torrent .title strong')).toHaveText('Sintel', { timeout: 30_000 })

  await page.locator('label.file-button input[type=file]').first().setInputFiles(join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent'))
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' }).first()).toBeVisible()
})

test('with Ask on, a .torrent added unstarted from the dialog is listed paused', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto('/')
  await page.locator('label.file-button input[type=file]').first().setInputFiles(join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent'))
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Sintel')
  await dialog.getByRole('checkbox', { name: 'Start downloading' }).uncheck()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  const row = page.locator('.torrent').first()
  await expect(row.locator('.title strong')).toHaveText('Sintel', { timeout: 30_000 })
  await expect(row.locator('.badge')).toHaveText('Paused')
})

// Cloudflare Pages serves the app for any path, so what an unknown one shows is the router's choice
test('an address the app does not know ends on the library', async ({ page }) => {
  // first, while no service worker is installed, so the server answers the expired save address like any other
  for (const path of ['/__ripple-stream/expired/film.mkv', '/no-such-page', '/download/film.mkv?files=all']) {
    await page.goto(path)
    await expect(page.getByRole('button', { name: 'Create a torrent' }), path).toBeVisible()
    expect(new URL(page.url()).pathname, path).toBe('/')
  }
})

test('the pages the app knows still render where they are', async ({ page }) => {
  const magnet = Buffer.from(NOBODY).toString('base64')
  const pages = [
    ['/', page.getByRole('button', { name: 'Create a torrent' })],
    ['/legal', page.getByRole('heading', { name: 'Legal & Terms' })],
    ['/privacy', page.getByRole('heading', { name: 'Privacy', exact: true })],
    [`/download?magnet=${magnet}`, page.locator('.card')],
    [`/watch?magnet=${magnet}`, page.getByTestId('open-in-ripple')],
  ] as const
  for (const [path, marker] of pages) {
    await page.goto(path)
    await expect(marker, path).toBeVisible({ timeout: 30_000 })
    expect(new URL(page.url()).pathname, path).toBe(path.split('?')[0])
  }
})
