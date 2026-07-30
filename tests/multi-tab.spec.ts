// Two tabs, one engine.
//
// A libtorrent session holds an exclusive OPFS lock on every file it writes, so only one may
// run per browser. The app used to enforce that by letting exactly one tab render and
// offering the rest a "take over" prompt. Now a Web Lock picks the tab that hosts the worker
// and the others borrow it over a BroadcastChannel.
//
// The three things worth proving, in order of how badly they fail if wrong:
//   1. The second tab does NOT build its own worker. Two sessions over one library is the
//      corruption this whole mechanism exists to prevent.
//   2. A command issued in the borrowing tab reaches the engine.
//   3. Closing the hosting tab promotes another one, rather than leaving a dead library.
//
// Needs no network: the demo torrent falls back to a magnet add, which produces a row
// whether or not a swarm answers.

import type { BrowserContext, Page } from '@playwright/test'

import { expect, test } from '@playwright/test'

// Wraps the Worker constructor before any app code runs, so every construction is recorded
// with its URL. Counting workers is the only direct evidence that a tab did not quietly
// start a second engine.
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

// The player pulls in libav and jassub workers of its own, which have nothing to do with the
// engine. Only the torrent worker is being counted.
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

  // The old behaviour: a second tab rendered a takeover prompt instead of the app.
  await expect(b.getByText('Only one page can be active at a time.')).toHaveCount(0)

  // Seeing the library at all proves the borrowed transport is delivering, since this tab has
  // no engine of its own to hear from.
  await expect(firstRow(b)).toBeVisible({ timeout: 60_000 })
  expect(await engineWorkers(b), 'the borrowing tab must not build a second engine').toHaveLength(0)

  const nameInA = await firstRow(a).locator('.title strong').innerText()
  await expect(firstRow(b).locator('.title strong')).toHaveText(nameInA)

  // A command from the borrowing tab has to reach the engine in the other one. Watching the
  // badge flip in tab A is the whole round trip: B's click, the engine acting on it, and the
  // state broadcast landing back in A.
  const pauseInB = firstRow(b).getByRole('button', { name: 'Pause' })
  await expect(pauseInB).toBeVisible({ timeout: 30_000 })
  await pauseInB.click()
  await expect(firstRow(a).locator('.badge'), 'the borrowing tab\'s Pause never reached the engine')
    .toHaveText('Paused', { timeout: 30_000 })

  // Closing the host releases the Web Lock, which is what promotes the survivor.
  await a.close()
  await expect
    .poll(async () => (await engineWorkers(b)).length, { timeout: 60_000, message: 'the survivor never took over the engine' })
    .toBe(1)

  // Promotion restores from the persisted list, so the library has to still be there.
  await expect(firstRow(b)).toBeVisible({ timeout: 60_000 })
  expect((b as Page & { __errors: string[] }).__errors).toEqual([])

  await context.close()
})

// The harder case. When the host closes, one survivor is promoted and the others have to
// notice, throw away everything they knew (their handles name different torrents in the new
// session) and re-aim at the tab that won. A command issued in the gap between the two
// engines reaches nobody unless it is held, and nothing retries it.
test('a tab that was not promoted still drives the engine after the handover', async ({ browser }) => {
  const context = await browser.newContext()
  await context.addInitScript(recordWorkers)

  const tabs = [await openTab(context), await openTab(context), await openTab(context)]
  for (const tab of tabs) await expect(firstRow(tab)).toBeVisible({ timeout: 60_000 })

  const hosting = await Promise.all(tabs.map(async (tab) => (await engineWorkers(tab)).length))
  expect(hosting, 'exactly one tab should be hosting the engine').toEqual([1, 0, 0])

  await tabs[0]!.close()

  // Whichever of the two survivors the lock went to.
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

  // The bystander was talking to an engine that no longer exists. Its Pause has to reach the
  // one that replaced it, which means noticing the change and re-aiming, not just retrying.
  await expect(firstRow(bystander)).toBeVisible({ timeout: 60_000 })
  const pause = firstRow(bystander).getByRole('button', { name: 'Pause' })
  const resume = firstRow(bystander).getByRole('button', { name: 'Resume' })
  // Whether it comes back paused depends on what the first test left behind, so drive it to a
  // known state first rather than assuming.
  if (await resume.isVisible().catch(() => false)) await resume.click()
  await expect(pause).toBeVisible({ timeout: 30_000 })
  await pause.click()

  await expect(firstRow(promoted).locator('.badge'), 'the bystander\'s command never reached the new engine')
    .toHaveText('Paused', { timeout: 30_000 })

  await context.close()
})
