// Removing torrent_flags::no_verify_files once made a restored torrent come back at zero bytes.
// Needs network, so it skips itself without one. Run with `npm run test:resume`.
//
// IN THE SWARM LANE, moved there 2026-09-03, because "needs network" is the whole of what the lanes
// split on and this was sitting in the one that gates a push. It was observed passing one run and
// skipping the next on the same machine, which is what a swarm dependency looks like from inside a
// lane whose rule is "deterministic anywhere": the skip is honest, and its being invisible in a
// gate is not.
//
// It also has to START the demo now. A first run adds it PAUSED since `5a416fa`, so the wait below
// was for bytes that were never coming, and the test would have skipped every time on a clean
// profile whatever the network did.

import { expect, test } from '@playwright/test'

type Snap = { state: number, downloaded: number }

test('a reload keeps the bytes a torrent already downloaded', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await page.addInitScript(() => {
    const w = window as any
    w.__snap = []
    w.__checked = false
    const Original = window.Worker
    class Probe extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          const data = event.data
          if (data?.type !== 'state') return
          w.__snap = data.torrents.map((t: any) => ({
            state: t.status?.state ?? -1,
            downloaded: t.status?.totalDone ?? 0,
          }))
          // 1 is checking_files, the hash pass itself
          if (data.torrents.some((t: any) => t.status?.state === 1)) w.__checked = true
        })
      }
    }
    window.Worker = Probe
  })

  await page.goto('/')

  // the demo arrives paused since `5a416fa`; nothing downloads until something presses this
  const resume = page.locator('.torrent').first().getByRole('button', { name: 'Resume' })
  if (await resume.isVisible().catch(() => false)) await resume.click()

  const downloaded = await page
    .waitForFunction(
      () => {
        const s = (window as any).__snap as Snap[]
        return s?.length && s[0]!.downloaded > 4 * 1024 * 1024 ? s[0]!.downloaded : null
      },
      undefined,
      { timeout: 90_000 },
    )
    .then((h) => h.jsonValue() as Promise<number>)
    .catch(() => 0)

  test.skip(downloaded === 0, 'no network: the demo torrent never started downloading')

  // without a resume blob the restore falls back to re-adding the .torrent, a different path
  const gotResume = await page
    .waitForFunction(
      () => new Promise<boolean>((resolve) => {
        let request: IDBOpenDBRequest
        try { request = indexedDB.open('keyval-store') } catch { resolve(false); return }
        request.onerror = () => resolve(false)
        request.onsuccess = () => {
          try {
            const keys = request.result.transaction('keyval', 'readonly').objectStore('keyval').getAllKeys()
            keys.onerror = () => resolve(false)
            keys.onsuccess = () => resolve(keys.result.some((k) => String(k).startsWith('ripple:resume:')))
          } catch { resolve(false) }
        }
      }),
      undefined,
      { timeout: 60_000, polling: 1_000 },
    )
    .then(() => true)
    .catch(() => false)

  expect(gotResume, 'no resume blob was written, so the restore path under test never ran').toBe(true)

  await page.reload()
  await page.waitForFunction(() => ((window as any).__snap as Snap[])?.length > 0, undefined, { timeout: 60_000 })
  // long enough for a hash pass to show up if one is going to
  await page.waitForTimeout(8_000)

  const after = (await page.evaluate(() => (window as any).__snap as Snap[]))[0]
  const checked = await page.evaluate(() => (window as any).__checked as boolean)
  console.log(`restore: ${downloaded} bytes before, ${after?.downloaded} after, hash pass: ${checked}`)

  // slightly under: a torrent still downloading can drop a piece it was mid-way through
  expect(after!.downloaded, 'the restore lost the bytes already on disk').toBeGreaterThanOrEqual(downloaded * 0.9)
  expect(pageErrors).toEqual([])
})
