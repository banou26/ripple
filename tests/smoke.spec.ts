// Boots the built app in a real browser and checks that the parts this project cannot
// typecheck actually come up: the module worker loads, the libtorrent session reaches a
// definite state (ready, or a clear "no OPFS here"), and nothing throws on the way.
// Deliberately offline-tolerant: it asserts nothing about peers or the relay.

import { expect, test } from '@playwright/test'

test('the library boots, the engine reports in, and nothing throws', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  // The worker's own verdict on storage, captured before the app can act on it.
  await page.addInitScript(() => {
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
      window.Worker = Probe as unknown as typeof Worker
    })
  })

  await page.goto('/')

  // The single-tab guard used to paint its takeover prompt on every load before settling.
  await expect(page.getByText('Only one page can be active at a time.')).toHaveCount(0)
  await expect(page.getByText('Ripple', { exact: true })).toBeVisible()

  const engine = await page.evaluate(() => (window as any).__engine as Promise<string>)
  expect(engine).toBe('ready')

  // A first run seeds the bundled demo, which is the quickest way to a real torrent in
  // the session with real metadata behind it.
  const row = page.locator('.torrent').first()
  await expect(row).toBeVisible()
  await expect(row.locator('.title strong')).toHaveText('Sintel')

  // A magnet already in the list must never be re-added: doing so is how a torrent the
  // user removed comes back.
  await page.getByPlaceholder('Add a magnet link').fill(
    'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel',
  )
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Already in your list')
  await expect(page.locator('.torrent')).toHaveCount(1)

  // Pausing is a decision, so it must read as Paused and never get auto-recovered.
  await row.getByRole('button', { name: 'Pause' }).click()
  await expect(row.locator('.badge')).toHaveText('Paused')
  await page.waitForTimeout(7_000)
  await expect(row.locator('.badge')).toHaveText('Paused')

  await row.getByRole('button', { name: 'Resume' }).click()
  await expect(row.locator('.badge')).not.toHaveText('Paused')
  // A resume must not flash "Retrying" while the engine catches up.
  await expect(row.locator('.badge')).not.toHaveText('Retrying')

  expect(pageErrors).toEqual([])
})
