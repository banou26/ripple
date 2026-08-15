// The library has to be on screen before the engine exists.
//
// MEASURED, and the numbers are why this test is here. On a reload the torrent list is readable from
// IndexedDB in ONE millisecond, while `createSession` takes about 1.5 seconds. Almost none of that is
// the engine: the wasm chunk fetches in 13ms and compiles in roughly 115, and the remaining ~1.36
// SECONDS is the relay granting a listen port, which is two round trips to whatever region the tunnel
// landed in. The engine genuinely has to wait for that, because libtorrent snapshots a listen
// socket's endpoint between bind and listen and never refreshes it, so a port discovered later can
// never be announced.
//
// The library has no such excuse, and it used to wait anyway: the first row painted at 2059ms. It now
// paints at 65ms. The whole point of this file is that the second number cannot quietly become the
// first one again, so it asserts ORDER against the engine's own `ready` message rather than a
// duration, which would be a flaky thing to assert and would say nothing about the cause.
//
// Headless: this reads the DOM and worker messages, it never observes a transfer.

import { expect, test } from '@playwright/test'

test('a reload shows the library before the engine is ready', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  // Record when the worker says `ready`, and when a row first exists, on one clock. Installed as an
  // init script so it survives the reload that is the actual subject here.
  await page.addInitScript(() => {
    const w = window as any
    w.__order = { readyAt: null as number | null, rowAt: null as number | null }
    const t0 = performance.now()
    const Original = window.Worker
    class Probe extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          const type = (event.data as { type?: string } | null)?.type
          if (type === 'ready' && w.__order.readyAt == null) w.__order.readyAt = performance.now() - t0
        })
      }
    }
    window.Worker = Probe as unknown as typeof Worker
    const observer = new MutationObserver(() => {
      if (w.__order.rowAt == null && document.querySelector('.torrent')) {
        w.__order.rowAt = performance.now() - t0
        observer.disconnect()
      }
    })
    document.addEventListener('DOMContentLoaded', () => observer.observe(document.body, { childList: true, subtree: true }))
  })

  await page.goto('/')
  // the demo seeds itself on a first run, which is what gives the reload something to restore
  await expect(page.locator('.torrent')).toHaveCount(1)
  await page.waitForTimeout(4000)

  await page.reload()
  await expect(page.locator('.torrent')).toHaveCount(1)
  // wait past the engine so both marks are recorded
  await expect.poll(() => page.evaluate(() => (window as any).__order.readyAt), { timeout: 40_000 }).not.toBeNull()

  const order = await page.evaluate(() => (window as any).__order as { readyAt: number, rowAt: number })
  expect(order.rowAt, 'a row should exist before the engine reports ready').toBeLessThan(order.readyAt)

  expect(pageErrors).toEqual([])
})

test('a starting row carries the torrent name, and becomes the real row', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.torrent')).toHaveCount(1)
  await page.waitForTimeout(4000)

  await page.reload()

  const starting = page.locator('.torrent.starting').first()
  await starting.waitFor({ timeout: 10_000 })
  // The NAME, not an info hash. Most stored magnets carry no `dn` at all (the demo entry is a bare
  // `magnet:?xt=urn:btih:...`), so this falls back to the name the torrent occupies on disk. Without
  // it the row shows eight hex characters where a title belongs, which reads as a different torrent
  // rather than as this one still loading.
  await expect(starting).toContainText('Sintel')
  await expect(starting).toContainText('Starting')

  // and it has to be REPLACED rather than joined: one torrent must never occupy two rows
  await expect(page.locator('.torrent.starting')).toHaveCount(0, { timeout: 40_000 })
  await expect(page.locator('.torrent')).toHaveCount(1)
})
