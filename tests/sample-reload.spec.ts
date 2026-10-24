// The sample reloaded mid-download used to sit at Checking, 0 B, with no Pause or Resume, until
// somebody pressed Watch. Needs network for its web seed, so it skips itself without one.

import type { Locator } from '@playwright/test'

import { expect, test } from '@playwright/test'

import { addSample } from './sample-offer'

const percent = async (row: Locator) => parseFloat(await row.locator('.pct').innerText())

test('the sample reloaded mid-download goes on downloading, with Pause', async ({ page }) => {
  await page.goto('/')
  const row = await addSample(page)

  const started = await expect.poll(() => percent(row), { timeout: 90_000 }).toBeGreaterThan(1).then(() => true, () => false)
  test.skip(!started, 'no network: the sample never started downloading')
  const before = await percent(row)
  expect(before, 'the sample finished before the reload, so nothing was mid-download').toBeLessThan(100)

  const reloaded = Date.now()
  await page.reload()
  const after = page.locator('.torrent').first()
  await expect(after.locator('.title strong')).toHaveText('Sintel', { timeout: 30_000 })
  // past what it held, since a row can show Pause for the moment before the restore parks it
  await expect.poll(() => percent(after), { timeout: 30_000 }).toBeGreaterThan(before)
  await expect(after.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect(after.locator('.badge')).toHaveText(/^(Downloading|Seeding)$/)
  console.log(`sample: ${before}% before the reload, ${await percent(after)}% ${((Date.now() - reloaded) / 1000).toFixed(1)} s after it`)
})
