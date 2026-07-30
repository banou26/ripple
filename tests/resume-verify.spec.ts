// Reloading must not throw away what is already on disk. The whole fast-resume path exists
// for this, and nothing else in the suite exercises it: the unit tests never see libtorrent,
// and the smoke test never reloads.
//
// This caught a real regression while a resume-vs-files verification was being tried out.
// Removing torrent_flags::no_verify_files, so the disk layer could check the resume data
// against the actual file sizes, made a restored torrent come back at zero bytes. The
// change was dropped; this test is what found it, so it stays.
//
// Needs network (the demo seeds over a webseed) and skips itself rather than failing when
// there is none. Run with `npm run test:resume`.

import { expect, test } from '@playwright/test'

type Snap = { state: number, downloaded: number }

test('a reload keeps the bytes a torrent already downloaded', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  // Mirror the worker's state messages onto the window, and latch the checking states:
  // a hash pass can start and finish between two polls of the DOM.
  await page.addInitScript(() => {
    const w = window as any
    w.__snap = []
    w.__checked = false
    const Original = window.Worker
    class Probe extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as any
          if (data?.type !== 'state') return
          w.__snap = data.torrents.map((t: any) => ({
            state: t.status?.state ?? -1,
            downloaded: t.status?.totalDone ?? 0,
          }))
          // 1 is checking_files, the hash pass itself.
          if (data.torrents.some((t: any) => t.status?.state === 1)) w.__checked = true
        })
      }
    }
    window.Worker = Probe as unknown as typeof Worker
  })

  await page.goto('/')

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

  // Wait for the blob to be in IndexedDB rather than assuming the pagehide flush wins the
  // race with the reload. Without one the restore falls back to re-adding the .torrent,
  // which is a different path than the one under test.
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
  // Long enough for a hash pass to show up if one is going to.
  await page.waitForTimeout(8_000)

  const after = (await page.evaluate(() => (window as any).__snap as Snap[]))[0]
  const checked = await page.evaluate(() => (window as any).__checked as boolean)
  console.log(`restore: ${downloaded} bytes before, ${after?.downloaded} after, hash pass: ${checked}`)

  // Slightly under, because a torrent that is still downloading can also drop a piece it
  // was mid-way through. Coming back at zero is the failure this is here to catch.
  expect(after!.downloaded, 'the restore lost the bytes already on disk').toBeGreaterThanOrEqual(downloaded * 0.9)
  expect(pageErrors).toEqual([])
})
