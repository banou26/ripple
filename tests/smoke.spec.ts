// Checks in a real browser what this project cannot typecheck: the module worker loads and the libtorrent session reaches a definite state

import type { Locator, Page } from '@playwright/test'

import { expect, test } from '@playwright/test'

import { addSample } from './sample-offer'

const probeEngine = () => {
  ;(window as any).__engine = new Promise<string>((resolve) => {
    const OriginalWorker = window.Worker
    class Probe extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          const type = (event.data as { type?: string } | null)?.type
          if (type === 'ready' || type === 'storage-unavailable') resolve(type)
        })
      }
    }
    window.Worker = Probe
  })
}

const engineReady = async (page: Page) =>
  expect(await page.evaluate(() => (window as any).__engine as Promise<string>)).toBe('ready')

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

test('a link turned down leaves the offer standing', async ({ page }) => {
  await page.goto(`/add?magnet=${encodeURIComponent(NOBODY)}`)
  // listed as temporary while its dialog asks, which is not an answer to the offer
  await expect(page.locator('.torrent .temp')).toHaveCount(1, { timeout: 30_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)

  await expect(page.getByRole('button', { name: 'Add Sintel' })).toBeVisible({ timeout: 20_000 })
  expect(await seeded(page)).toBeNull()
})
