// Speed ceilings surviving the things that lose settings: a reload, and the engine moving tabs.
//
// Everything below the UI here is untestable in a unit test and is exactly where this feature can go
// wrong. The session ceilings live in IndexedDB, are read by whichever tab won the engine election,
// and come back to every tab on the engine's own broadcast. None of that exists outside a browser.
//
// No transfer is observed, so this runs HEADLESS like every other check that only reads the DOM.
//
// The engine cannot be asked what its limits are (its getters are sync calls into a context that only
// runs inside a tick, so asking would hang it), which means there is no way to assert the value from
// the inside. What IS assertable is the round trip: the number goes to the worker, the worker stores
// it, and what comes back on the broadcast is what the UI draws. A wrong value anywhere in that chain
// shows up as a wrong button label, because the label is rendered from the broadcast and never from
// local state.

import { expect, test } from '@playwright/test'

const downButton = 'footer .controls button:has-text("down")'
const upButton = 'footer .controls button:has-text("up")'

test('a session ceiling is kept across a reload and reported back from the engine', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await page.goto('/')
  await expect(page.getByText('Ripple', { exact: true })).toBeVisible()

  // nothing set yet, and the control says so rather than showing a 0
  await expect(page.locator(downButton)).toHaveText('Unlimited down')

  await page.locator(downButton).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // opens on the current value, which is no value, so the checkbox carries it
  await expect(dialog.getByRole('checkbox')).toBeChecked()

  await dialog.getByRole('checkbox').uncheck()
  await dialog.getByRole('spinbutton').fill('1500')
  await dialog.getByRole('button', { name: /Limit to/ }).click()
  await expect(dialog).toHaveCount(0)

  // 1500 kB/s is 1.5 MB/s, and this label is drawn from what the ENGINE broadcast back rather than
  // from the number that was typed, so an error anywhere along the round trip lands here
  await expect(page.locator(downButton)).toHaveText('1.5 MB/s down')
  // the direction that was not touched is untouched
  await expect(page.locator(upButton)).toHaveText('Unlimited up')

  // the whole point: a reload builds a new engine, which has to read the ceiling back out of storage
  await page.reload()
  await expect(page.locator(downButton)).toHaveText('1.5 MB/s down')
  await expect(page.locator(upButton)).toHaveText('Unlimited up')

  // and removing it has to stick just as well, since 0 is a value and not an absence
  await page.locator(downButton).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('checkbox').check()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove limit' }).click()
  await expect(page.locator(downButton)).toHaveText('Unlimited down')

  await page.reload()
  await expect(page.locator(downButton)).toHaveText('Unlimited down')

  expect(pageErrors).toEqual([])
})

test('a second tab sees a ceiling set in the first, without being told directly', async ({ context }) => {
  const first = await context.newPage()
  await first.goto('/')
  await expect(first.getByText('Ripple', { exact: true })).toBeVisible()

  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByText('Ripple', { exact: true })).toBeVisible()

  await first.locator(upButton).click()
  const dialog = first.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('checkbox').uncheck()
  await dialog.getByRole('spinbutton').fill('500')
  await dialog.getByRole('button', { name: /Limit to/ }).click()

  await expect(first.locator(upButton)).toHaveText('500 kB/s up')

  // Only ONE of these tabs owns the engine, and the other is a follower forwarding commands to it.
  // Whichever way round it landed, the value has to reach both: it rides the engine's ordinary state
  // broadcast rather than being mirrored in each page, so a tab that never sent the command still
  // renders the truth. Without that, two settings screens disagree and neither is obviously wrong.
  await expect(second.locator(upButton)).toHaveText('500 kB/s up')

  await first.close()
  await second.close()
})
