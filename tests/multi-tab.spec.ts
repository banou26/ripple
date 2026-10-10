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
  window.Worker = Probe
}

const engineWorkers = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (window as unknown as { __workers: string[] }).__workers.filter((url) => !/libav|jassub/.test(url)))

const firstRow = (page: Page) => page.locator('.torrent').first()

/*
 * Records which engine last reported this tab's first torrent paused for good: paused with
 * auto-management off. Paused with it on is libtorrent's queue, which starts the torrent again a tick
 * later. Opened after the app's own channel, so it hears each broadcast after the app has.
 */
const listenForPause = (page: Page) => page.evaluate(() => {
  new BroadcastChannel('ripple:torrent').onmessage = ({ data }) => {
    const status = data?.to === 'all' && data.msg?.type === 'state' ? data.msg.torrents?.[0]?.status : null
    if (status?.paused && !status.autoManaged) (window as unknown as { __pausedBy: string }).__pausedBy = data.gen
  }
})

const pausedBy = (page: Page) => page.evaluate(() => (window as unknown as { __pausedBy?: string }).__pausedBy)

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

  /*
   * RESUME, not Pause, because the demo now arrives paused (`5a416fa`).
   *
   * What is under test is unchanged: a command issued in the tab that only BORROWS the engine has to
   * reach the tab hosting it, and be visible there. Resume is simply the direction that exists from
   * the state a first run starts in, and the second test in this file already handles both.
   */
  const resumeInB = firstRow(b).getByRole('button', { name: 'Resume' })
  await expect(resumeInB).toBeVisible({ timeout: 30_000 })
  await resumeInB.click()
  await expect(firstRow(a).locator('.badge'), 'the borrowing tab\'s Resume never reached the engine')
    .not.toHaveText('Paused', { timeout: 30_000 })

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

  const survivors = [tabs[1]!, tabs[2]!]
  for (const tab of survivors) await listenForPause(tab)
  // the demo arrives paused, and has to be in the library that way before its engine goes
  await expect.poll(() => pausedBy(survivors[0]!), { timeout: 30_000 }).toBeTruthy()
  const before = await pausedBy(survivors[0]!)

  await tabs[0]!.close()

  await expect
    .poll(
      async () => (await Promise.all(survivors.map(async (t) => (await engineWorkers(t)).length))).reduce((a, b) => a + b, 0),
      { timeout: 60_000, message: 'nobody took over the engine' },
    )
    .toBe(1)

  const counts = await Promise.all(survivors.map(async (t) => (await engineWorkers(t)).length))
  const promoted = survivors[counts.findIndex((n) => n === 1)]!
  const bystander = survivors[counts.findIndex((n) => n === 0)]!

  /*
   * Nothing is pressed until the NEW engine has reported the torrent paused for good. Until then the
   * row is the old engine's, whose commands the new one drops by design, or a state about to change:
   * a null status drawn as Downloading, or the queue's park, which the engine undoes a tick later.
   * Either swaps the row's Pause and Resume under a click already on its way.
   */
  await expect
    .poll(() => pausedBy(bystander), { timeout: 60_000, message: 'the new engine never reported the torrent paused' })
    .not.toBe(before)
  await firstRow(bystander).getByRole('button', { name: 'Resume' }).click()
  const pause = firstRow(bystander).getByRole('button', { name: 'Pause' })
  await expect(pause).toBeVisible({ timeout: 30_000 })
  await pause.click()

  await expect(firstRow(promoted).locator('.badge'), 'the bystander\'s command never reached the new engine')
    .toHaveText('Paused', { timeout: 30_000 })

  await context.close()
})
