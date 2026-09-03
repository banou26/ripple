/*
 * A folder holding exactly ONE file, in every format.
 *
 * Its own spec because it is the one shape where hybrid and v2 need DIFFERENT file lists while
 * producing identical bytes, which is a combination nothing else in the suite can catch:
 *
 *  - a hybrid's file list is read straight out of the v1 `files` key, which libtorrent's creator
 *    leaves unpadded when there is one file;
 *  - a v2 torrent has no such key, so libtorrent SYNTHESIZES the list from the file tree on parse,
 *    and that path pads unconditionally.
 *
 * The metainfo is identical either way, so the byte-for-byte reference tests pass whichever rule is
 * used. The difference only appears one layer down, where reads are served BY INDEX into
 * libtorrent's parsed list. With the wrong rule the v2 arm died on arrival:
 * `hybrid storage: /source/... has 1 handles for 2 files`, an I/O error, and no progress at all.
 *
 * No network and no transfer: the torrent is complete from the moment it exists, so this is headless.
 */
import { expect, test } from '@playwright/test'

type Row = {
  progress: number
  state: number | null
  savePath: string | undefined
  error: string | undefined
  numFiles: number
}

const PIECE = 64 * 1024
/** Deliberately UNALIGNED, since a file that already ends on a boundary needs no pad in any format. */
const ONLY = { name: 'only.mkv', bytes: 100_000, fill: 0x55 }

/** hybrid keeps libtorrent's writer rule, v2 takes its parser's. Both were read off the parser. */
const WANTED_FILES = { v1: 1, hybrid: 1, v2: 2 } as const

const install = (only: typeof ONLY) => {
  const w = window as any
  w.__states = []
  const Original = window.Worker
  class Probe extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.addEventListener('message', (event: MessageEvent) => {
        const data = event.data
        if (data?.type !== 'state') return
        w.__states.push((data.torrents ?? []).map((t: any) => ({
          progress: t.status?.progress ?? 0,
          state: t.status?.state ?? null,
          savePath: t.status?.savePath,
          error: t.status?.error || undefined,
          // libtorrent's OWN list, which is the one reads are indexed by
          numFiles: (t.files?.files ?? []).length,
        })))
      })
    }
  }
  window.Worker = Probe
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }

  const build = async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('ripple-one-file', { create: true })
    const handle = await dir.getFileHandle(only.name, { create: true })
    const writable = await (handle as any).createWritable()
    await writable.write(new Uint8Array(only.bytes).fill(only.fill))
    await writable.close()
    return dir
  }
  w.__sourceReady = build()
  ;(window as any).showDirectoryPicker = async () => w.__sourceReady
}

for (const format of ['v1', 'hybrid', 'v2'] as const) {
  test(`a folder holding one file verifies and seeds as ${format}`, async ({ page }) => {
    test.setTimeout(180_000)
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.addInitScript(install, ONLY)

    await page.goto('/')
    await page.getByRole('button', { name: 'Create a torrent' }).click()
    await page.getByRole('button', { name: 'Choose a folder', exact: true }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Format')).toBeVisible({ timeout: 30_000 })
    await dialog.getByLabel('Piece size').selectOption(String(PIECE))
    await dialog.getByLabel('Format').selectOption(format)
    await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
    await expect(dialog.getByText('is being shared from where it sits')).toBeVisible({ timeout: 120_000 })

    const infoHash = (await dialog.locator('code').first().textContent())!
    expect(infoHash).toMatch(format === 'v2' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/)
    await dialog.getByRole('button', { name: 'Close' }).click()

    const row = await page
      .waitForFunction(
        () => {
          const frames = (window as any).__states as Row[][]
          const rows = frames[frames.length - 1] ?? []
          const found = rows.find((t) => (t.savePath ?? '').startsWith('/source/'))
          return found && (found.error || found.progress >= 1) ? found : null
        },
        undefined,
        { timeout: 120_000 },
      )
      .then((handle) => handle.jsonValue() as Promise<Row>)

    console.log(`[${format}]`, JSON.stringify(row))
    expect(row.error, 'the engine could not read the file it was pointed at').toBeUndefined()
    expect(row.progress).toBe(1)
    expect(row.state === 4 || row.state === 5, `state was ${row.state}, not finished or seeding`).toBe(true)

    /*
     * The count that decides it. Ripple registers one handle per entry in ITS plan, and the storage
     * refuses to serve a read when the two lists are different lengths, because a mismatch means
     * every index past the first pad points at the wrong file.
     */
    expect(row.numFiles, 'Ripple and libtorrent disagree about how many files this torrent has')
      .toBe(WANTED_FILES[format])

    expect(pageErrors).toEqual([])
  })
}
