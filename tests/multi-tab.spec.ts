// A libtorrent session holds an exclusive OPFS lock on every file it writes, so only one may run per
// browser: two sessions over one library is the corruption this whole mechanism exists to prevent.

import type { BrowserContext, Page } from '@playwright/test'

import { expect, test } from '@playwright/test'

const recordWorkers = () => {
  const scope = window as unknown as { __workers: string[] }
  scope.__workers = []
  const Original = window.Worker
  class Probe extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      scope.__workers.push(String(url))
    }
  }
  window.Worker = Probe as unknown as typeof Worker
}

const engineWorkers = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (window as unknown as { __workers: string[] }).__workers.filter((url) => !/libav|jassub/.test(url)))

const firstRow = (page: Page) => page.locator('.torrent').first()

const openTab = async (context: BrowserContext): Promise<Page> => {
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  ;(page as Page & { __errors: string[] }).__errors = errors
  await page.goto('/')
  return page
}

test('a second tab borrows the first tab\'s engine, then takes it over when that tab closes', async ({ browser }) => {
  const context = await browser.newContext()
  await context.addInitScript(recordWorkers)

  const a = await openTab(context)
  await expect(firstRow(a)).toBeVisible({ timeout: 60_000 })
  expect(await engineWorkers(a), 'the first tab should host exactly one engine').toHaveLength(1)

  const b = await openTab(context)

  await expect(b.getByText('Only one page can be active at a time.')).toHaveCount(0)

  await expect(firstRow(b)).toBeVisible({ timeout: 60_000 })
  expect(await engineWorkers(b), 'the borrowing tab must not build a second engine').toHaveLength(0)

  const nameInA = await firstRow(a).locator('.title strong').innerText()
  await expect(firstRow(b).locator('.title strong')).toHaveText(nameInA)

  const pauseInB = firstRow(b).getByRole('button', { name: 'Pause' })
  await expect(pauseInB).toBeVisible({ timeout: 30_000 })
  await pauseInB.click()
  await expect(firstRow(a).locator('.badge'), 'the borrowing tab\'s Pause never reached the engine')
    .toHaveText('Paused', { timeout: 30_000 })

  await a.close()
  await expect
    .poll(async () => (await engineWorkers(b)).length, { timeout: 60_000, message: 'the survivor never took over the engine' })
    .toBe(1)

  await expect(firstRow(b)).toBeVisible({ timeout: 60_000 })
  expect((b as Page & { __errors: string[] }).__errors).toEqual([])

  await context.close()
})

test('a tab that was not promoted still drives the engine after the handover', async ({ browser }) => {
  const context = await browser.newContext()
  await context.addInitScript(recordWorkers)

  const tabs = [await openTab(context), await openTab(context), await openTab(context)]
  for (const tab of tabs) await expect(firstRow(tab)).toBeVisible({ timeout: 60_000 })

  const hosting = await Promise.all(tabs.map(async (tab) => (await engineWorkers(tab)).length))
  expect(hosting, 'exactly one tab should be hosting the engine').toEqual([1, 0, 0])

  await tabs[0]!.close()

  const survivors = [tabs[1]!, tabs[2]!]
  await expect
    .poll(
      async () => (await Promise.all(survivors.map(async (t) => (await engineWorkers(t)).length))).reduce((a, b) => a + b, 0),
      { timeout: 60_000, message: 'nobody took over the engine' },
    )
    .toBe(1)

  const counts = await Promise.all(survivors.map(async (t) => (await engineWorkers(t)).length))
  const promoted = survivors[counts.findIndex((n) => n === 1)]!
  const bystander = survivors[counts.findIndex((n) => n === 0)]!

  await expect(firstRow(bystander)).toBeVisible({ timeout: 60_000 })
  const pause = firstRow(bystander).getByRole('button', { name: 'Pause' })
  const resume = firstRow(bystander).getByRole('button', { name: 'Resume' })
  // Whether it comes back paused depends on what the first test left behind.
  if (await resume.isVisible().catch(() => false)) await resume.click()
  await expect(pause).toBeVisible({ timeout: 30_000 })
  await pause.click()

  await expect(firstRow(promoted).locator('.badge'), 'the bystander\'s command never reached the new engine')
    .toHaveText('Paused', { timeout: 30_000 })

  await context.close()
})
