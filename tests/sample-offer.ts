import type { Locator, Page } from '@playwright/test'

import { expect } from '@playwright/test'

/**
 * Takes the first-run offer, which is how a fresh profile gets a row: Sintel from the bundled
 * `.torrent`, so its metadata is there at once and its web seed needs no swarm.
 *
 * Only the tab hosting the engine shows the offer. `pause` stops the sample straight after, for a
 * spec that needs a row rather than a transfer, so a run does not pull 129 MB per spec.
 */
export const addSample = async (page: Page, { pause = false } = {}): Promise<Locator> => {
  await page.getByRole('button', { name: 'Add Sintel' }).click({ timeout: 60_000 })
  const row = page.locator('.torrent').first()
  await expect(row.locator('.title strong')).toHaveText('Sintel', { timeout: 30_000 })
  if (pause) {
    await row.getByRole('button', { name: 'Pause' }).click({ timeout: 30_000 })
    await expect(row.locator('.badge')).toHaveText('Paused')
  }
  return row
}
