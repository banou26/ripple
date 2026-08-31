/*
 * A HYBRID torrent, end to end, against the real engine.
 *
 * WHY THIS IS THE PROOF. Ripple builds the metainfo itself, and a hybrid carries two independent
 * descriptions of the same bytes: SHA-1 pieces over the padded concatenation, and a SHA-256 merkle
 * tree per file. libtorrent computes BOTH while checking, and `torrent::on_piece_verified` has a
 * branch for exactly the case where one passes and the other does not: it errors with
 * `torrent_inconsistent_hashes`, drops the whole have-set and pauses.
 *
 * So a hybrid that reaches 100 per cent and seeds is a statement about the merkle trees, the piece
 * layers, the pad arithmetic and the file ordering all at once. One wrong byte anywhere and progress
 * lands short or the row goes red.
 *
 * THE FIXTURE IS CHOSEN SO EVERY RULE RUNS, which the previous fixture did not:
 *
 *  - the piece length is set to 64 KiB, so a piece is FOUR 16 KiB blocks. At Ripple's automatic
 *    choice for a pack this small it would be 16 KiB, one block per piece, and then the merkle
 *    padding rules degenerate: the piece-level pad hash collapses into the leaf fill and a wrong
 *    implementation passes.
 *  - one file is smaller than a single block, one spans several pieces and ends unaligned, one lands
 *    exactly on a piece boundary, and one is empty. Those are the four branches of the leaf count.
 *  - the last file ends unaligned, so the trailing pad is emitted and covered.
 *
 * No network and no transfer: the torrent is complete from the moment it exists, so this is headless.
 */
import { expect, test } from '@playwright/test'

type Row = {
  progress: number
  state: number | null
  savePath: string | undefined
  totalDone: number
  error: string | undefined
  numFiles: number
}

const PIECE = 64 * 1024

const PACK = [
  // under one 16 KiB block: its tree is a single leaf and its root IS that leaf
  { path: ['A-small.bin'], bytes: 1_000, fill: 0x11 },
  // several pieces and an unaligned tail: the only file here with a `piece layers` entry
  { path: ['B-multi.bin'], bytes: PIECE * 3 + 12_345, fill: 0x22 },
  // exactly one piece: four full leaves, and no piece layers entry
  { path: ['C', 'nested-exact.bin'], bytes: PIECE, fill: 0x33 },
  // zero length: no tree, no root, and no pad after it
  { path: ['empty.nfo'], bytes: 0, fill: 0 },
  // the last file, ending unaligned, so the TRAILING pad is emitted
  { path: ['Z-tail.bin'], bytes: 5_000, fill: 0x44 },
]

const TOTAL = PACK.reduce((sum, file) => sum + file.bytes, 0)

/** What `withPads` should produce: a pad after every non-empty file that ends off a boundary. */
const expectedPads = () => {
  const pads: number[] = []
  let offset = 0
  for (const file of PACK) {
    offset += file.bytes
    const pad = file.bytes > 0 ? (PIECE - (offset % PIECE)) % PIECE : 0
    if (pad > 0) { pads.push(pad); offset += pad }
  }
  return { pads, paddedBytes: offset }
}

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
          progress: t.status?.progress ?? 0,
          state: t.status?.state ?? null,
          savePath: t.status?.savePath,
          totalDone: t.status?.totalDone ?? 0,
          error: t.status?.error || undefined,
          // libtorrent's OWN file count, which for a hybrid includes the pads it reconciled
          numFiles: (t.files?.files ?? []).length,
        })))
      })
    }
  }
  window.Worker = Probe as unknown as typeof Worker
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }

  const buildSource = async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('ripple-hybrid-source', { create: true })
    for (const file of pack) {
      let at = dir
      for (const segment of file.path.slice(0, -1)) at = await at.getDirectoryHandle(segment, { create: true })
      const handle = await at.getFileHandle(file.path[file.path.length - 1]!, { create: true })
      const writable = await (handle as any).createWritable()
      // a per-file fill rather than one pattern: content that repeated would let two different
      // padding rules agree by accident, which is the whole failure this is here to catch
      if (file.bytes) await writable.write(new Uint8Array(file.bytes).fill(file.fill))
      await writable.close()
    }
    return dir
  }
  w.__sourceReady = buildSource()
  ;(window as any).showDirectoryPicker = async () => w.__sourceReady
}

test('a hybrid torrent verifies against both of its own hash trees', async ({ page }) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.addInitScript(install, PACK)

  await page.goto('/')
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  await page.getByRole('button', { name: 'Choose a folder' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Format')).toBeVisible({ timeout: 30_000 })

  const fact = (label: string) => dialog.locator('.fact').filter({ hasText: label }).locator('.value')

  // 64 KiB pieces, so a piece is four blocks and the merkle padding rules are not degenerate
  await dialog.getByLabel('Piece size').selectOption(String(PIECE))

  /*
   * v1 first, so the padding is measurably absent, then hybrid. A dialog that showed padding either
   * way would be showing a constant rather than the plan.
   */
  await expect(fact('Padding')).toHaveCount(0)
  await dialog.getByLabel('Format').selectOption('hybrid')

  const { pads, paddedBytes } = expectedPads()
  const padding = paddedBytes - TOTAL
  expect(pads.length, 'the fixture stopped exercising the pad rules').toBe(3)
  await expect(fact('Padding')).toBeVisible()
  await expect(fact('Pieces')).toHaveText(String(paddedBytes / PIECE))
  console.log('[plan]', JSON.stringify({ total: TOTAL, paddedBytes, padding, pads }))

  await page.screenshot({ path: 'test-results/hybrid-review.png' })
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.getByText('is being shared from where it sits')).toBeVisible({ timeout: 120_000 })

  /*
   * TWO hashes, and the v1 one is the identity.
   *
   * A hybrid is one torrent with two names. Ripple keys save paths, library entries and stored
   * handles on the v1 one, because every client understands it; the v2 one is published so a v2-only
   * client reaches the same swarm.
   */
  const hashes = await dialog.locator('code').allTextContents()
  console.log('[hashes]', JSON.stringify(hashes))
  expect(hashes[0]).toMatch(/^[0-9a-f]{40}$/)
  expect(hashes[1], 'the dialog showed no v2 hash, so this may not be a hybrid at all').toMatch(/^[0-9a-f]{64}$/)
  const infoHash = hashes[0]!

  await page.screenshot({ path: 'test-results/hybrid-created.png' })
  await dialog.getByRole('button', { name: 'Close' }).click()

  /*
   * THE ASSERTION THAT MATTERS. libtorrent hashed these files itself, both ways, and reached the end
   * without deciding the two descriptions disagree. State 5 is seeding, 4 is finished.
   */
  const verified = await page
    .waitForFunction(
      () => {
        const frames = (window as any).__states as Row[][]
        const rows = frames[frames.length - 1] ?? []
        const row = rows.find((t) => (t.savePath ?? '').startsWith('/source/'))
        return row && (row.error || (row.progress >= 1 && (row.state === 4 || row.state === 5))) ? row : null
      },
      undefined,
      { timeout: 150_000 },
    )
    .then((handle) => handle.jsonValue() as Promise<Row>)

  console.log('[verified]', JSON.stringify(verified))
  expect(verified.error, 'the engine rejected the hybrid Ripple built').toBeUndefined()
  expect(verified.progress).toBe(1)
  expect(verified.savePath).toBe(`/source/${infoHash}`)

  /*
   * The engine's own file list carries the pads, which is the check that the two halves of the
   * metainfo were reconciled rather than one of them being ignored. libtorrent rebuilds the pad
   * entries from the v2 file tree and compares them against the v1 `files` list index by index; a
   * count that came back without them would mean it read this as a plain v1 torrent.
   */
  expect(verified.numFiles, 'libtorrent did not see the pad files, so this was not read as a hybrid')
    .toBe(PACK.length + pads.length)

  await expect(page.locator('.torrent').filter({ hasText: 'ripple-hybrid-source' }).first()).toBeVisible()
  expect(pageErrors).toEqual([])

  // and nothing was copied: the person's files are still the only copy
  const opfs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const names: string[] = []
    for await (const [name] of (root as any).entries()) names.push(name)
    return names
  })
  console.log('[opfs roots]', JSON.stringify(opfs))
  expect(opfs).not.toContain('source')
})

/*
 * v2 ONLY, which is a different path in three places rather than the same one with a flag.
 *
 * Its info dict carries no `pieces` and no `files` at all, its identity is the 64-character SHA-256
 * of the info dict rather than a 40-character SHA-1, and its magnet names it with `btmh` rather than
 * `btih`. That identity is what this exists to prove survives: a 64-character id becomes an OPFS
 * directory name, and the orphan sweep deletes any directory under the save root whose name it does
 * not recognise, about a minute after the page loads.
 */
test('a v2 torrent keeps a 64 character identity the rest of the app recognises', async ({ page }) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.addInitScript(install, PACK)

  await page.goto('/')
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  await page.getByRole('button', { name: 'Choose a folder' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Format')).toBeVisible({ timeout: 30_000 })
  await dialog.getByLabel('Piece size').selectOption(String(PIECE))
  await dialog.getByLabel('Format').selectOption('v2')
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.getByText('is being shared from where it sits')).toBeVisible({ timeout: 120_000 })

  // ONE hash, and it is the v2 one. A v2 torrent has no v1 name to fall back on.
  const hashes = await dialog.locator('code').allTextContents()
  console.log('[v2 hashes]', JSON.stringify(hashes))
  // ONE line, not two: a v2 torrent's identity IS its v2 hash, so a second line would repeat it
  expect(hashes.length).toBe(1)
  expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/)
  const infoHash = hashes[0]!

  const magnet = await page.evaluate(async () => {
    const request = indexedDB.open('keyval-store')
    return new Promise<string>((resolve) => {
      request.onerror = () => resolve('')
      request.onsuccess = () => {
        const read = request.result.transaction('keyval', 'readonly').objectStore('keyval').get('ripple:torrents')
        read.onsuccess = () => resolve((read.result as any[] ?? []).map((e) => e.magnet).join(' '))
        read.onerror = () => resolve('')
      }
    })
  })
  console.log('[magnet]', magnet)
  // `1220` is the multihash prefix and belongs in the urn, never in the id
  expect(magnet).toContain(`xt=urn:btmh:1220${infoHash}`)
  expect(magnet).not.toContain('xt=urn:btih:')

  await dialog.getByRole('button', { name: 'Close' }).click()

  const verified = await page
    .waitForFunction(
      () => {
        const frames = (window as any).__states as Row[][]
        const rows = frames[frames.length - 1] ?? []
        const row = rows.find((t) => (t.savePath ?? '').startsWith('/source/'))
        return row && (row.error || (row.progress >= 1 && (row.state === 4 || row.state === 5))) ? row : null
      },
      undefined,
      { timeout: 150_000 },
    )
    .then((handle) => handle.jsonValue() as Promise<Row>)

  console.log('[v2 verified]', JSON.stringify(verified))
  expect(verified.error).toBeUndefined()
  expect(verified.progress).toBe(1)
  // the save path carries the 64 character id, which is what the sweep has to recognise
  expect(verified.savePath).toBe(`/source/${infoHash}`)
  expect(pageErrors).toEqual([])
})

/*
 * A created hybrid torrent COMES BACK after a reload, which it did not.
 *
 * Two things have to survive, and each was wrong on its own:
 *
 *  - the library's `size`. The metadata pump patched the entry with libtorrent's `total_size()`,
 *    which counts every pad, over the content total `create-source` had already written. On the next
 *    load `startFrom` replans the same folder, gets the content total back, compares it against the
 *    padded one and throws. The throw is swallowed into "still waiting", so the row sits at needs
 *    access forever and the Allow button does nothing and says nothing.
 *  - the chosen `pieceLength`. Pads are laid out against it, so a reload that recomputed it from the
 *    automatic rule produced a different file list for the same folder, and the handle array no
 *    longer lined up with libtorrent's.
 *
 * The reload is the only way to see either: everything is correct until the page is loaded again.
 */
test('a created hybrid torrent restarts after a reload', async ({ page }) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.addInitScript(install, PACK)

  await page.goto('/')
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  await page.getByRole('button', { name: 'Choose a folder' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Format')).toBeVisible({ timeout: 30_000 })
  // a NON-automatic piece length, so the reload has something to get wrong
  await dialog.getByLabel('Piece size').selectOption(String(PIECE))
  await dialog.getByLabel('Format').selectOption('hybrid')
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.getByText('is being shared from where it sits')).toBeVisible({ timeout: 120_000 })
  const infoHash = (await dialog.locator('code').first().textContent())!
  await dialog.getByRole('button', { name: 'Close' }).click()

  await page.waitForFunction(
    () => {
      const frames = (window as any).__states as Row[][]
      const rows = frames[frames.length - 1] ?? []
      return (rows.find((t) => (t.savePath ?? '').startsWith('/source/'))?.progress ?? 0) >= 1
    },
    undefined,
    { timeout: 150_000 },
  )

  /*
   * The library has to describe the person's files, not the padded stream. Polled rather than read
   * once, because the metadata pump writes this entry a second time a tick after the create does,
   * and it is that second write that used to be wrong.
   */
  const stored = () => page.evaluate((ih: string) => new Promise<any>((resolve) => {
    const request = indexedDB.open('keyval-store')
    request.onerror = () => resolve(null)
    request.onsuccess = () => {
      const read = request.result.transaction('keyval', 'readonly').objectStore('keyval').get('ripple:torrents')
      read.onsuccess = () => resolve((read.result as any[] ?? []).find((e) => e.infoHash === ih) ?? null)
      read.onerror = () => resolve(null)
    }
  }), infoHash)

  await expect.poll(async () => (await stored())?.name, { timeout: 60_000 }).toBeTruthy()
  const entry = await stored()
  console.log('[library]', JSON.stringify({ size: entry?.size, format: entry?.format, pieceLength: entry?.pieceLength, files: entry?.files?.length }))
  expect(entry.size, 'the library recorded the PADDED total, so the reload will refuse it').toBe(TOTAL)
  expect(entry.format).toBe('hybrid')
  expect(entry.pieceLength, 'the chosen piece length was not kept, so the pads move on reload').toBe(PIECE)
  // pads are not the person's files and have no business in a list another device reads
  expect(entry.files.every((f: { name: string }) => !f.name.includes('.pad/'))).toBe(true)

  await page.reload()

  const after = await page
    .waitForFunction(
      () => {
        const frames = (window as any).__states as Row[][]
        const rows = frames[frames.length - 1] ?? []
        const row = rows.find((t) => (t.savePath ?? '').startsWith('/source/'))
        return row && (row.error || row.progress >= 1) ? row : null
      },
      undefined,
      { timeout: 150_000 },
    )
    .then((handle) => handle.jsonValue() as Promise<Row>)

  console.log('[after reload]', JSON.stringify(after))
  expect(after.error, 'the torrent came back with a disk error, so the file lists disagree').toBeUndefined()
  expect(after.progress).toBe(1)
  expect(after.savePath).toBe(`/source/${infoHash}`)
  expect(after.numFiles).toBe(PACK.length + expectedPads().pads.length)
  expect(pageErrors).toEqual([])
})

