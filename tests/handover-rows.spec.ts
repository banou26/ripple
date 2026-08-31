/*
 * A row is keyed by a HANDLE, and a handle is a counter inside the session that minted it. Once that
 * session is gone the numbers on screen name whatever the next one assigns them, so `client.ts`
 * refuses to send a handle command across the boundary. That makes the buttons safe; it does not make
 * them honest. This is about what the page SHOWS while no engine is up.
 */
import type { BrowserContext, Page } from '@playwright/test'

import { expect, test } from '@playwright/test'

const firstRow = (page: Page) => page.locator('.torrent').first()

const openTab = async (context: BrowserContext): Promise<Page> => {
  const page = await context.newPage()
  await page.goto('/')
  return page
}

test('the survivor shows its library reconnecting, not live rows it cannot act on', async ({ browser }) => {
  test.setTimeout(180_000)
  const context = await browser.newContext()

  const a = await openTab(context)
  await expect(firstRow(a)).toBeVisible({ timeout: 60_000 })
  const b = await openTab(context)
  await expect(firstRow(b)).toBeVisible({ timeout: 60_000 })
  // a live row, which is what must go away when the engine behind it does
  await expect(firstRow(b).getByRole('button', { name: /Pause|Resume/ })).toBeVisible({ timeout: 30_000 })
  const name = await firstRow(b).locator('.title strong').innerText()

  /*
   * Poll from the instant the host closes. The window is the time the promoted tab needs to open a
   * session and restore the library, which is seconds rather than frames, but it is still a window:
   * sampling once after an await would miss it and report a pass for the wrong reason.
   */
  const seen = { starting: false, buttonWhileStarting: false }
  const watch = (async () => {
    for (let i = 0; i < 300; i++) {
      /*
       * Both facts read in ONE evaluation, off the same element in the same frame.
       *
       * Sampling the class and then the buttons in two awaits reads two different renders: the row
       * turns back into a live one in between, and the check reports a reconnecting row offering a
       * button that never coexisted with it. That is what the first version of this test did, and it
       * failed for that reason rather than for the behaviour under test.
       */
      const sample = await firstRow(b).evaluate((el) => ({
        starting: el.classList.contains('starting'),
        buttons: el.querySelectorAll('button').length,
      })).catch(() => null)
      if (sample?.starting) {
        seen.starting = true
        if (sample.buttons > 0) seen.buttonWhileStarting = true
      }
      await b.waitForTimeout(100)
    }
  })()

  await a.close()
  await watch

  expect(seen.starting, 'the row never went back to Connecting, so it kept offering a dead engine\'s handle').toBe(true)
  expect(seen.buttonWhileStarting, 'a reconnecting row offered a button to press').toBe(false)

  // and it comes back on its own, with the same torrent in it
  await expect(firstRow(b).getByRole('button', { name: /Pause|Resume/ })).toBeVisible({ timeout: 90_000 })
  await expect(firstRow(b).locator('.title strong')).toHaveText(name)

  await context.close()
})
