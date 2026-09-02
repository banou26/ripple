/*
 * Run time survives a reload.
 *
 * libtorrent counts `active_duration` and `seeding_duration` itself and writes them into resume data,
 * so this looks like it should already work and does not. A finished torrent's resume blob is written
 * ONCE, because the periodic saver in worker.ts is `state === 3`, downloading, so the number that
 * comes back is whatever it was a few seconds after that torrent finished. A torrent created from the
 * user's own files has no blob at all by design, so its counters restart from nothing every time.
 *
 * That second case is what this drives, because it is the strongest version of the failure: with no
 * resume data anywhere, anything the reloaded page reports has to have come from Ripple's own record.
 *
 * A created torrent also seeds from the instant it exists, so the clock starts without a swarm, a
 * transfer or a network. Headless.
 */
import { expect, test } from '@playwright/test'

const PACK = [
  { path: ['E01.mkv'], bytes: 120_000, fill: 0x11 },
  { path: ['E02.mkv'], bytes: 80_000, fill: 0x22 },
]

/** Long enough that one write-back has certainly happened: the threshold is 30s, checked every 15s. */
const SEEDED_FOR = 35

const install = (pack: typeof PACK) => {
  const w = window as any
  w.__states = []
  const Original = window.Worker
  class Probe extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as any
        if (data?.type !== 'state') return
        w.__states.push((data.torrents ?? []).map((t: any) => ({
          savePath: t.status?.savePath,
          engineSeeding: t.status?.seedingSeconds ?? 0,
          engineActive: t.status?.activeSeconds ?? 0,
          seeding: t.uptime?.seedingSeconds ?? -1,
          active: t.uptime?.activeSeconds ?? -1,
        })))
      })
    }
  }
  window.Worker = Probe as unknown as typeof Worker
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }

  const buildSource = async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('ripple-uptime-source', { create: true })
    for (const file of pack) {
      const handle = await dir.getFileHandle(file.path[file.path.length - 1]!, { create: true })
      const writable = await (handle as any).createWritable()
      await writable.write(new Uint8Array(file.bytes).fill(file.fill))
      await writable.close()
    }
    return dir
  }
  w.__sourceReady = buildSource()
  ;(window as any).showDirectoryPicker = async () => w.__sourceReady
  ;(window as any).showOpenFilePicker = async () => [await (await w.__sourceReady).getFileHandle('E01.mkv')]
}

const source = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const frames = (window as any).__states as any[][]
    const rows = frames[frames.length - 1] ?? []
    return rows.find((t) => (t.savePath ?? '').startsWith('/source/')) ?? null
  })

const stored = (page: import('@playwright/test').Page) =>
  page.evaluate(() => new Promise<any>((resolve) => {
    const request = indexedDB.open('keyval-store')
    request.onerror = () => resolve(null)
    request.onsuccess = () => {
      const read = request.result.transaction('keyval', 'readonly').objectStore('keyval').get('ripple:torrents')
      read.onsuccess = () => {
        const list = read.result as any[] | undefined
        resolve({ count: (list ?? []).length, entries: (list ?? []).map((e) => ({ ih: String(e.infoHash).slice(0, 8), saveTo: e.saveTo, started: e.started, activeSeconds: e.activeSeconds, seedingSeconds: e.seedingSeconds })) })
      }
      read.onerror = () => resolve(null)
    }
  }))

test('a torrent keeps the time it has been seeding across a reload', async ({ page }) => {
  test.setTimeout(300_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.addInitScript(install, PACK)

  await page.goto('/')
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  await page.getByRole('button', { name: 'Choose a folder', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.getByText('is being shared from where it sits')).toBeVisible({ timeout: 120_000 })
  await dialog.getByRole('button', { name: 'Close' }).click()

  /*
   * Wait on the WRITE, not on a duration.
   *
   * Waiting for the on-screen number to reach 35 is what this did first, and it read the library a
   * few seconds too early every time: the threshold is 30 seconds of accumulated time and the check
   * runs every 15, so the first write lands on the tick after 30 rather than at 30. Polling the thing
   * that actually has to have happened has no cadence to get wrong.
   */
  await expect
    .poll(async () => (await stored(page)).entries[0]?.seedingSeconds ?? 0, { timeout: 150_000, message: 'nothing was ever written to the library, so nothing can survive a reload' })
    .toBeGreaterThanOrEqual(SEEDED_FOR - 5)

  const before = await source(page)
  const entry = await stored(page)
  console.log('[before reload]', JSON.stringify(before))
  console.log('[library      ]', JSON.stringify(entry))

  await page.reload()

  const after = await page
    .waitForFunction(
      () => {
        const frames = (window as any).__states as any[][]
        const rows = frames[frames.length - 1] ?? []
        const row = rows.find((t: any) => (t.savePath ?? '').startsWith('/source/'))
        return row && row.seeding >= 0 ? row : null
      },
      undefined,
      { timeout: 120_000 },
    )
    .then((h) => h.jsonValue() as Promise<any>)

  console.log('[after reload ]', JSON.stringify(after))

  /*
   * THE CONTROL IS IN THE SAME ROW. `engineSeeding` is libtorrent's own counter, which restarts from
   * nothing here because this torrent has no resume data at all, so it is what the readout used to
   * show. If the accumulated figure were coming from the same place it would have collapsed to it.
   */
  expect(after.engineSeeding, 'the engine kept its own counter, so this proves nothing about ours')
    .toBeLessThan(SEEDED_FOR - 10)
  expect(after.seeding, 'the seeding time reset on reload, which is the whole bug')
    .toBeGreaterThanOrEqual(SEEDED_FOR - 15)
  expect(after.active).toBeGreaterThanOrEqual(after.seeding)

  // and the row says so, which is the half of this anybody actually sees
  await expect(page.locator('.torrent .seeded').first()).toHaveText(/seeded for \d+[smhd]/)
  expect(pageErrors).toEqual([])
})
