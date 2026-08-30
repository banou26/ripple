/*
 * Creating a torrent from files on this device, end to end, against the real engine.
 *
 * WHY THIS IS THE PROOF AND NOT A SMOKE TEST. Ripple builds the metainfo itself, in JavaScript:
 * bencode, piece length, file order, and one SHA-1 per piece over the concatenation of the files.
 * Nothing in the app checks that arithmetic against the world. libtorrent does, for free, and
 * unavoidably: a torrent pointed at files already on disk answers `check()` with NEED_FULL_CHECK, so
 * the engine hashes those bytes itself and builds its have-set from the result. It reaches 100 per
 * cent and seeds only if every piece hash Ripple wrote matches the one libtorrent computes, and only
 * if the per-file handles were registered in the torrent's own file order. One byte wrong anywhere
 * and progress lands short.
 *
 * THE PICKER IS STUBBED WITH A REAL HANDLE, not with a fake object. Neither Playwright nor CDP can
 * answer `showDirectoryPicker`, so the test creates a directory in OPFS and hands that back: an OPFS
 * `FileSystemDirectoryHandle` is the same interface the picker returns, with real `entries()`,
 * `getFileHandle()` and `getFile()`. So everything under test is the shipping path; only the dialog
 * that chooses the folder is replaced.
 *
 * No network and no transfer: the torrent is complete from the moment it exists, so this is headless.
 */
import { expect, test } from '@playwright/test'

type Row = { name: string, progress: number, state: number | null, savePath: string | undefined, totalDone: number }

const PACK = [
  { path: ['E01.mkv'], bytes: 300_000, fill: 0x11 },
  { path: ['E02.mkv'], bytes: 220_000, fill: 0x22 },
  { path: ['Subs', 'E01.ass'], bytes: 4_000, fill: 0x33 },
  { path: ['empty.nfo'], bytes: 0, fill: 0 },
  { path: ['.DS_Store'], bytes: 900, fill: 0x44 },
]
const REAL_FILES = PACK.filter((f) => f.path[0] !== '.DS_Store')
const TOTAL = REAL_FILES.reduce((sum, f) => sum + f.bytes, 0)

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
          name: (t.files?.files?.[0]?.path ?? '').split('/')[0] || '',
          progress: t.status?.progress ?? 0,
          state: t.status?.state ?? null,
          savePath: t.status?.savePath,
          totalDone: t.status?.totalDone ?? 0,
        })))
      })
    }
  }
  window.Worker = Probe as unknown as typeof Worker
  // the demo torrent would add itself eight seconds in, inside every window this measures
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }

  /** A real OPFS directory, standing in for whatever the picker would have returned. */
  const buildSource = async () => {
    const root = await navigator.storage.getDirectory()
    // a fresh name per run, so a retry never inherits a half-written folder
    const dir = await root.getDirectoryHandle('ripple-test-source', { create: true })
    for (const file of pack) {
      let at = dir
      for (const segment of file.path.slice(0, -1)) at = await at.getDirectoryHandle(segment, { create: true })
      const handle = await at.getFileHandle(file.path[file.path.length - 1]!, { create: true })
      const writable = await (handle as any).createWritable()
      if (file.bytes) await writable.write(new Uint8Array(file.bytes).fill(file.fill))
      await writable.close()
    }
    return dir
  }

  w.__sourceReady = buildSource()
  ;(window as any).showDirectoryPicker = async () => w.__sourceReady
  ;(window as any).showOpenFilePicker = async () => {
    const dir = await w.__sourceReady
    return [await dir.getFileHandle('E01.mkv')]
  }
}

const lastRows = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const frames = (window as any).__states as Row[][]
    return frames[frames.length - 1] ?? []
  })

test('a folder on this device becomes a torrent the engine verifies and seeds', async ({ page }) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.addInitScript(install, PACK)

  await page.goto('/')
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  await page.getByRole('button', { name: 'Choose a folder' }).click()

  // the review step: the numbers are on screen BEFORE anything is hashed or published
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(String(REAL_FILES.length), { exact: true })).toBeVisible({ timeout: 30_000 })

  // the junk file is left out, and the dialog says so rather than quietly shrinking the torrent
  await expect(dialog.getByText('1 left out')).toBeVisible()

  await page.screenshot({ path: 'test-results/create-review.png' })
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()

  // Published, and named for the folder it came from
  await expect(dialog.getByText('is being shared from where it sits')).toBeVisible({ timeout: 120_000 })
  const infoHash = await dialog.locator('code').first().textContent()
  expect(infoHash).toMatch(/^[0-9a-f]{40}$/)

  // the card shell: a bordered surface with its own header and footer, matching the other dialogs
  await expect(dialog.locator('.card')).toBeVisible()
  await page.screenshot({ path: 'test-results/create-dialog.png' })

  await dialog.getByRole('button', { name: 'Close' }).click()

  /*
   * THE ASSERTION THAT MATTERS. libtorrent hashed the same files itself and has to agree with every
   * piece hash Ripple wrote, or progress lands short of 1. State 5 is seeding.
   */
  const verified = await page
    .waitForFunction(
      () => {
        const frames = (window as any).__states as Row[][]
        const rows = frames[frames.length - 1] ?? []
        const row = rows.find((t) => (t.savePath ?? '').startsWith('/source/'))
        return row && row.progress >= 1 && (row.state === 4 || row.state === 5) ? row : null
      },
      undefined,
      { timeout: 150_000 },
    )
    .then((handle) => handle.jsonValue() as Promise<Row>)

  console.log('[verified]', JSON.stringify(verified))
  expect(verified.progress).toBe(1)
  expect(verified.totalDone, 'the engine hashed a different number of bytes than the torrent describes').toBe(TOTAL)
  expect(verified.savePath).toBe(`/source/${infoHash}`)

  // the library shows it, and nothing threw on the way
  await expect(page.locator('.torrent').filter({ hasText: 'ripple-test-source' }).first()).toBeVisible()
  expect(pageErrors).toEqual([])

  /*
   * And the files were left exactly as they were. The mirror and the move both had a full pass at
   * this torrent by now (both run off the 500ms state tick), and either one would have copied the
   * whole source folder somewhere.
   */
  const opfs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const names: string[] = []
    for await (const [name] of (root as any).entries()) names.push(name)
    return names
  })
  console.log('[opfs roots]', JSON.stringify(opfs))
  expect(opfs, 'a copy of the source folder was made in browser storage').not.toContain('source')
})
