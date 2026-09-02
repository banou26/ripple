// Checks in a real browser what this project cannot typecheck: the module worker loads and the libtorrent session reaches a definite state

import { expect, test } from '@playwright/test'

test('the library boots, the engine reports in, and nothing throws', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

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

  await expect(page.getByText('Only one page can be active at a time.')).toHaveCount(0)
  await expect(page.getByText('Ripple', { exact: true })).toBeVisible()

  const engine = await page.evaluate(() => (window as any).__engine as Promise<string>)
  expect(engine).toBe('ready')

  const row = page.locator('.torrent').first()
  await expect(row).toBeVisible()
  await expect(row.locator('.title strong')).toHaveText('Sintel')

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

  /*
   * The demo arrives PAUSED, and that is the assertion rather than a step to get past.
   *
   * A first run used to add it started, so opening Ripple for the first time pulled 129.3 MB nobody
   * had asked for and then seeded it, against a metered allowance. It is added paused and temporary
   * now, so the row is an offer rather than a transfer, and this is the only test that sees a first
   * run at all.
   */
  await expect(row.locator('.badge')).toHaveText('Paused')

  // and it STAYS stopped: a pause that quietly lifts itself is the failure this has always watched
  // for, whether it was the person's pause or the one the add came with
  await page.waitForTimeout(7_000)
  await expect(row.locator('.badge')).toHaveText('Paused')

  await row.getByRole('button', { name: 'Resume' }).click()
  await expect(row.locator('.badge')).not.toHaveText('Paused')
  await expect(row.locator('.badge')).not.toHaveText('Retrying')

  // and back, which is the half the old version covered by pausing first
  await row.getByRole('button', { name: 'Pause' }).click()
  await expect(row.locator('.badge')).toHaveText('Paused')

  expect(pageErrors).toEqual([])
})
