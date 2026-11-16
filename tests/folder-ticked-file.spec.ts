/*
 * A file ticked after a torrent was copied to the folder, against the real engine and the built page.
 *
 * The list entry carrying the new choice reaches the page at once, while the state saying the torrent is downloading
 * again comes with the engine's next report, up to half a second later. In between the row reads finished with the
 * new file chosen, so nothing may copy or move it on that reading: a read of a file with no bytes creates it empty in
 * the person's folder and has the engine fetch it.
 *
 * Three torrents with b.bin left out, each finished from bytes placed in browser storage before the add: Gap and
 * Bound have no b.bin anywhere, Held has its bytes, so ticking it there is the control that a ticked file IS copied.
 * Bound is meant for the folder, the other two for browser storage. No peer and no transfer, so this is headless.
 */
import { createHash } from 'node:crypto'

import { expect, test } from './offline'

const PIECE = 16_384

const bencode = (value: unknown): Buffer => {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
  }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((key) => [bencode(key), bencode(record[key])]), Buffer.from('e')])
}

type Spec = { name: string, to: string, fill: number, placeB: boolean }

const FILES = ['a.bin', 'b.bin', 'c.bin']

// two pieces a file, so b.bin shares no piece with a chosen file and the other two finish without it
const torrentOf = ({ name, fill }: Spec) => {
  const fills = FILES.map((_, i) => fill + i)
  const all = Buffer.concat(fills.map((f) => Buffer.alloc(2 * PIECE, f)))
  const pieces: Buffer[] = []
  for (let at = 0; at < all.length; at += PIECE) pieces.push(createHash('sha1').update(all.subarray(at, at + PIECE)).digest())
  const info = { name, 'piece length': PIECE, pieces: Buffer.concat(pieces), files: FILES.map((path) => ({ length: 2 * PIECE, path: [path] })) }
  return { bytes: bencode({ info }), infoHash: createHash('sha1').update(bencode(info)).digest('hex'), fills }
}

const SPECS: Spec[] = [
  { name: 'Gap', to: 'Browser storage', fill: 0x10, placeB: false },
  { name: 'Held', to: 'Browser storage', fill: 0x20, placeB: true },
  { name: 'Bound', to: 'picked', fill: 0x30, placeB: false },
]

type Row = { magnet: string, state: number | null, progress: number, savePath: string | undefined }

test('a file ticked after the copy reaches the folder only once its bytes are held', async ({ page }) => {
  test.setTimeout(180_000)
  const torrents = SPECS.map((spec) => ({ ...spec, ...torrentOf(spec) }))

  await page.addInitScript(() => {
    const w = window as any
    try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
    w.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true })
    w.__rows = []
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor (url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type !== 'state') return
          w.__rows = (event.data.torrents ?? []).map((t: any) => ({
            magnet: String(t.magnet ?? '').toLowerCase(),
            state: t.status?.state ?? null,
            progress: t.status?.progress ?? 0,
            savePath: t.status?.savePath,
          }))
        })
      }
    }
  })

  const rowOf = async (infoHash: string): Promise<Row | undefined> =>
    (await page.evaluate(() => (window as any).__rows as Row[])).find((row) => row.magnet.includes(infoHash))

  const folder = () => page.evaluate(async () => {
    const out: Record<string, number> = {}
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [name, handle] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)
        else out[prefix + name] = (await (handle as FileSystemFileHandle).getFile()).size
      }
    }
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('picked'), '')
    return out
  })

  const options = async (name: string) => {
    await page.getByRole('button', { name: `Options for ${name}`, exact: true }).first().click()
    const menu = page.getByRole('dialog').last()
    await menu.waitFor({ timeout: 10_000 })
    const text = await menu.innerText()
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached', timeout: 10_000 })
    return text
  }

  const tickB = async (name: string) => {
    await page.locator('strong', { hasText: new RegExp(`^${name}$`) }).first().click()
    const dock = page.getByRole('region', { name: `Details for ${name}` })
    await dock.getByRole('button', { name: /^Content/ }).click({ timeout: 10_000 })
    await dock.locator('label', { hasText: 'b.bin' }).locator('input').check({ timeout: 10_000 })
  }

  await page.goto('/')
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'picked', exact: true }).waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Start straight away', exact: true }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Ask what to download', exact: true }).waitFor({ timeout: 10_000 })

  // a .torrent add saves under the shared root, so these are where the engine's first check finds them
  await page.evaluate(async (placed) => {
    const dl = await (await navigator.storage.getDirectory()).getDirectoryHandle('dl', { create: true })
    for (const { name, files } of placed) {
      const dir = await dl.getDirectoryHandle(name, { create: true })
      for (const { path, fill, size } of files) {
        const writable = await (await dir.getFileHandle(path, { create: true })).createWritable()
        await writable.write(new Uint8Array(size).fill(fill))
        await writable.close()
      }
    }
  }, torrents.map((t) => ({
    name: t.name,
    files: FILES.map((path, i) => ({ path, fill: t.fills[i]!, size: 2 * PIECE })).filter(({ path }) => path !== 'b.bin' || t.placeB),
  })))

  for (const t of torrents) {
    await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${t.name}.torrent`, mimeType: 'application/x-bittorrent', buffer: t.bytes })
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Add torrent' }).waitFor({ timeout: 20_000 })
    await dialog.locator('label.file', { hasText: 'b.bin' }).locator('input').uncheck()
    await dialog.locator('label.check', { hasText: t.to }).locator('input').check()
    await dialog.getByRole('button', { name: 'Add torrent' }).click()
    await dialog.waitFor({ state: 'detached', timeout: 10_000 })
  }

  const copied = (files: Record<string, number>, name: string) => files[`${name}/a.bin`] === 2 * PIECE && files[`${name}/c.bin`] === 2 * PIECE
  await expect.poll(async () => { const files = await folder(); return torrents.every((t) => copied(files, t.name)) }, { timeout: 90_000 }).toBe(true)
  // the copy is whole for the choice made, so its removal offers to delete Ripple's copy: the reading the tick must undo
  expect(await options('Gap')).toContain('Remove and delete Ripple\'s copy')

  await tickB('Held')
  await expect.poll(async () => (await folder())['Held/b.bin'], { timeout: 30_000, message: 'a ticked file whose bytes are held is copied' }).toBe(2 * PIECE)

  for (const name of ['Gap', 'Bound']) {
    const { infoHash } = torrents.find((t) => t.name === name)!
    await tickB(name)
    // libtorrent's downloading (3): the engine has the new choice, so the window this is about has passed
    await expect.poll(async () => (await rowOf(infoHash))?.state, { timeout: 15_000 }).toBe(3)
  }
  // a copy or a move started in that window opens its file at once; this is time for one to show
  await page.waitForTimeout(2_000)
  const after = await folder()
  expect(Object.keys(after).filter((path) => /^(Gap|Bound)\/b\.bin/.test(path)), 'a file with no bytes was opened in the folder').toEqual([])
  expect((await rowOf(torrents.find((t) => t.name === 'Bound')!.infoHash))?.savePath, 'a torrent with a file to fetch moved into the folder').toBe('/dl')
})
