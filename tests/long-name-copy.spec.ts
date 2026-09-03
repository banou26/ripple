/*
 * The one name a copied pick cannot be given, measured against the real engine.
 *
 * libtorrent RENAMES a path element it will not use as written, and the copy has already written to
 * the name the torrent carries. So the engine's check looks somewhere nothing was put: measured
 * 2026-09-03 as three files on disk, two written by the copy and one empty one the engine made for
 * itself, a torrent stuck in state 3, and progress that never left zero. Nothing anywhere reports a
 * fault, because from the engine's point of view the files are simply not there yet.
 *
 * Ripple's answer is to DECLINE the copy rather than to guess at the rename rule, which is version
 * dependent and would trade a loud failure for a silent one. The torrent is still made and still
 * seeds; it seeds from the pick, for as long as the tab is open, which is what the platform can
 * promise without a copy.
 *
 * BOTH SIDES OF THE BOUNDARY ARE HERE, and that is the point of the file. A test that only shows the
 * long name being refused cannot tell a working check from one that refuses everything, and this
 * flow has two outcomes that look alike from a screenshot. So the 240 byte case has to copy and the
 * 241 byte case has to not, in the same rig, one selection apart.
 *
 * The pickers are DELETED, which puts Chromium on the same route Firefox and WebKit are always on:
 * `@banou/ponyfill` opens an `<input type="file">` where an engine has no picker, and the handle it
 * wraps around the result cannot be stored, which is the only condition anything is ever copied for.
 * Driving it needs Playwright's `filechooser` event rather than a locator, because the input is
 * created on the click and removed again after. No network and no transfer, so this is headless.
 */
import { expect, test } from '@playwright/test'

/** `MAX_PATH_ELEMENT_BYTES` is 240, measured by creating torrents at 100 through 250 characters. */
const named = (bytes: number) => 'x'.repeat(bytes - 4) + '.mkv'

const CASES = [
  {
    label: 'at the boundary is copied into browser storage',
    name: named(240),
    copied: true,
  },
  {
    label: 'one byte past it is shared from the pick instead, with nothing written',
    name: named(241),
    copied: false,
  },
]

const SIZE = 300_000

for (const subject of CASES) {
test(`a name ${subject.label}`, async ({ page }) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  // real files on disk, because setting a DIRECTORY on the input is what produces the
  // `webkitRelativePath` values the ponyfill rebuilds the tree from, and a fake File carries none
  const fs = await import('node:fs')
  const os = await import('node:os')
  const nodePath = await import('node:path')
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'ripple-long-name-'))
  const folder = nodePath.join(root, 'Long Pack')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(nodePath.join(folder, subject.name), Buffer.alloc(SIZE, 0x11))

  try {
    await page.addInitScript(() => {
      const w = window as any
      w.__states = []
      const Original = window.Worker
      class Probe extends Original {
        constructor (url: string | URL, options?: WorkerOptions) {
          super(url, options)
          this.addEventListener('message', (event: MessageEvent) => {
            const data = event.data as any
            if (data?.type !== 'state') return
            w.__states.push((data.torrents ?? []).map((t: any) => ({
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
      // what sends the ponyfill to its input fallback, whose handle cannot be stored, which is the
      // only condition anything is copied for
      delete (window as any).showDirectoryPicker
      delete (window as any).showOpenFilePicker
    })

    await page.goto('/')
    await page.getByRole('button', { name: 'Create a torrent' }).click()
    const dialog = page.getByRole('dialog')
    // the input the ponyfill opens lives only for the length of the pick, so it is caught as a
    // file chooser rather than found as an element
    const chooser = page.waitForEvent('filechooser')
    await dialog.getByRole('button', { name: 'Choose a folder', exact: true }).click()
    await (await chooser).setFiles(folder)

    /*
     * WHICH OF TWO TRUE SENTENCES IS ON SCREEN, before anybody agrees to anything.
     *
     * The room is measured at pick time rather than at publish time precisely so this can be said in
     * advance, and the refusal is not a smaller version of the promise: one says a copy will be
     * kept, the other says it will not and why. Somebody deciding whether to start is owed the one
     * that applies to them.
     */
    const promise = dialog.getByText(/will keep a .* copy in browser storage/)
    const refusal = dialog.getByText('too long for the engine to keep as written')
    if (subject.copied) {
      await expect(promise).toBeVisible({ timeout: 30_000 })
      await expect(refusal).toHaveCount(0)
    } else {
      await expect(refusal, 'a name the engine will rename was accepted for a copy').toBeVisible({ timeout: 30_000 })
      await expect(promise).toHaveCount(0)
    }

    await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
    await expect(dialog.getByText('is being shared from where it sits')).toBeVisible({ timeout: 120_000 })
    const infoHash = (await dialog.locator('code').first().textContent())!
    expect(infoHash).toMatch(/^[0-9a-f]{40}$/)
    // the closing line says which kind of sharing this turned out to be, and they are different
    // promises: one survives a reload, the other lasts as long as the tab
    await expect(dialog.getByText('Ripple kept its own copy')).toHaveCount(subject.copied ? 1 : 0)
    await dialog.getByRole('button', { name: 'Close' }).click()

    /*
     * THE ASSERTION THAT MATTERS, and it is about WHERE, not about whether.
     *
     * A copied torrent is added at `/dl/<hash>`, where its bytes were just written. A declined one
     * is added as a source torrent at `/source/<hash>` and reads straight from the pick, which is
     * why it still reaches 100 per cent: reads there are served by file INDEX, so a name libtorrent
     * has renamed for itself costs nothing.
     */
    const want = subject.copied ? `/dl/${infoHash}` : `/source/${infoHash}`
    const verified = await page
      .waitForFunction(
        (savePath: string) => {
          const frames = (window as any).__states as any[][]
          const rows = frames[frames.length - 1] ?? []
          const row = rows.find((t: any) => (t.savePath ?? '') === savePath && t.progress >= 1)
          return row ?? null
        },
        want,
        { timeout: 150_000 },
      )
      .then((handle) => handle.jsonValue() as Promise<any>)
    console.log(`[${subject.name.length} byte name]`, JSON.stringify(verified))
    expect(verified.totalDone, 'the engine hashed a different number of bytes than the torrent describes').toBe(SIZE)
    expect([4, 5], 'it has to be running, not parked').toContain(verified.state)

    /*
     * And NOTHING was written under the copy's directory for the refused one.
     *
     * This is the failure the refusal exists to prevent, in its own words: bytes on disk under a
     * path the engine's check does not look at. The 240 byte case is the control that proves the
     * question can come back the other way, so an origin that simply never has a `/dl/<hash>`
     * directory cannot pass this by accident.
     */
    const wrote = await page.evaluate(async (hash: string) => {
      const opfs = await navigator.storage.getDirectory()
      try {
        const dl = await opfs.getDirectoryHandle('dl')
        await dl.getDirectoryHandle(hash)
        return true
      } catch { return false }
    }, infoHash)
    expect(wrote, subject.copied
      ? 'the copy wrote nothing, so the control proves nothing'
      : 'a torrent the engine would rename had bytes written for it anyway').toBe(subject.copied)

    expect(pageErrors).toEqual([])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
}
