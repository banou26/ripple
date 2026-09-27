/*
 * Creating a torrent in an OFF-THE-RECORD profile, the kind an incognito window gets.
 *
 * On Chrome 153.0.8010.47 (measured 2026-09-27) reading a FileSystemHandle back out of IndexedDB in
 * such a profile kills the whole browser with SIGTRAP; the `put` works, the `get` that returns it
 * does not. Reportedly Chromium issue 562119515. The app stores the pick's root and the auto-save
 * folder, and used to read both straight back in the same page: the source as soon as the created
 * entry reached the list, and both again whenever the library route remounted. Now it uses the
 * handles it already holds, so this whole flow reads no stored handle.
 *
 * DELIBERATELY the stock `test`, whose context is `browser.newContext()`: off-the-record is the
 * point. A RELOAD still has to read the stored handles and still crashes on 153; nothing in the page
 * can avoid that, so this spec never reloads.
 *
 * No network and no transfer, so headless.
 */
import { expect, test } from '@playwright/test'

const SOURCE = 'ripple-incognito-source'
const DOWNLOADS = 'ripple-incognito-downloads'

const install = ({ source, downloads }: { source: string, downloads: string }) => {
  const w = window as any
  w.__seeding = false
  const Original = window.Worker
  class Probe extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type !== 'state') return
        for (const t of event.data.torrents ?? []) {
          const status = t.status ?? {}
          if ((status.savePath ?? '').startsWith('/source/') && status.progress >= 1) w.__seeding = true
        }
      })
    }
  }
  window.Worker = Probe
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }

  const directory = async (name: string, files: { name: string, bytes: number, fill: number }[]) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
    for (const file of files) {
      const writable = await (await dir.getFileHandle(file.name, { create: true }) as any).createWritable()
      await writable.write(new Uint8Array(file.bytes).fill(file.fill))
      await writable.close()
    }
    return dir
  }
  const sourceReady = directory(source, [
    { name: 'E01.mkv', bytes: 200_000, fill: 0x11 },
    { name: 'E02.mkv', bytes: 90_000, fill: 0x22 },
  ])
  const downloadsReady = directory(downloads, [])
  // one stub for both pickers the app opens: the create dialog's source and the auto-save folder
  ;(window as any).showDirectoryPicker = async (options?: { id?: string }) =>
    options?.id === 'ripple-downloads' ? downloadsReady : sourceReady
}

test('an off-the-record profile creates a torrent, and the browser survives the route coming back', async ({ page, browser }) => {
  test.setTimeout(180_000)
  let disconnected = false
  const down = new Promise<void>((resolve) => browser.on('disconnected', () => { disconnected = true; resolve() }))
  // raced against every wait, so a crash fails as itself and names the step rather than timing out
  const alive = <T>(what: string, step: Promise<T>) => Promise.race([
    step,
    down.then(() => { throw new Error(`the browser went down ${what}, which is the handle read-back crash`) }),
  ])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.addInitScript(install, { source: SOURCE, downloads: DOWNLOADS })

  await page.goto('/')

  // the auto-save folder, stored in IndexedDB by use-folder.ts
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await expect(page.getByRole('button', { name: DOWNLOADS, exact: true })).toBeVisible()

  // the pick's root, stored in IndexedDB by use-create-torrent.ts, then the entry reaches the list
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  await page.getByRole('button', { name: 'Choose a folder', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await alive('creating the torrent', expect(dialog.getByText('is being shared from where it sits')).toBeVisible({ timeout: 60_000 }))
  await dialog.getByRole('button', { name: 'Close' }).click()

  // the engine re-hashed the files itself and agrees, so the source it seeds from is the pick
  await alive('before it seeded', page.waitForFunction(() => (window as any).__seeding === true, undefined, { timeout: 120_000 }))
  await alive('before it seeded', expect(page.locator('.torrent').filter({ hasText: SOURCE }).first()).toBeVisible())

  // away from the library and back WITHOUT a reload, which remounts both hooks that hold a handle
  await page.getByRole('link', { name: 'Legal', exact: true }).click()
  await alive('on the route away', expect(page.getByRole('heading', { name: 'Legal & Terms' })).toBeVisible())
  await page.getByRole('link', { name: 'Ripple', exact: true }).click()
  await alive('on the route coming back', expect(page.getByRole('button', { name: DOWNLOADS, exact: true })).toBeVisible())
  await alive('on the route coming back', expect(page.locator('.torrent').filter({ hasText: SOURCE }).first()).toBeVisible())
  // the waiting panel would offer it if the remounted page had lost its grant
  await expect(page.getByRole('button', { name: `Allow ${SOURCE}` })).toHaveCount(0)

  // long enough for a list or state message after the remount to reach both hooks again
  await alive('after the route came back', page.waitForTimeout(3_000))
  expect(disconnected, 'the browser went down, which is the handle read-back crash').toBe(false)
  expect(await page.evaluate(() => 1 + 1)).toBe(2)
  expect(pageErrors).toEqual([])
})
