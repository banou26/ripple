/*
 * A temporary torrent stays in browser storage with a folder chosen, in both auto-save modes, until the person keeps it,
 * against the real engine and the built page. Two kinds: a .torrent the engine is told to add as temporary, as a film
 * opened from a link is, and the sample, whose .torrent is answered here with a small one. Their files are placed
 * before the add, so each finishes with no peer. No transfer, so this is headless.
 */
import type { Page } from '@playwright/test'

import { createHash } from 'node:crypto'

import { expect, test } from './offline'

// the page fetches the sample's .torrent itself, so the route below answers it
test.use({ serviceWorkers: 'block' })

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

type Placed = { path: string, size: number, fill: number }

const torrent = (name: string, dir: string, files: Placed[]) => {
  const all = Buffer.concat(files.map((f) => Buffer.alloc(f.size, f.fill)))
  const pieces: Buffer[] = []
  for (let at = 0; at < all.length; at += PIECE) pieces.push(createHash('sha1').update(all.subarray(at, at + PIECE)).digest())
  const info = { name, 'piece length': PIECE, pieces: Buffer.concat(pieces), files: files.map((f) => ({ length: f.size, path: [f.path] })) }
  return { name, dir, files, bytes: [...bencode({ info })], inFolder: files.map((f) => `${name}/${f.path}:${f.size}`).sort() }
}
type Fixture = ReturnType<typeof torrent>

// a .torrent add with no save path of its own saves under the shared root
const FILM = torrent('Lantern', 'dl', [{ path: 'lantern.webm', size: 300_000, fill: 0x4c }, { path: 'lantern.srt', size: 2_000, fill: 0x53 }])
// the sample saves in Sintel's own directory, whatever .torrent it is given
const SAMPLE = torrent('Sintel', 'dl/08ada5a7a6183aae1e09d831df6748d566095a10', [{ path: 'sintel.webm', size: 200_000, fill: 0x49 }])

/** No folder yet, a picker that gives one, and a record of the engine and of each move it is asked for. */
const prepare = async (page: Page) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __engines: Worker[], __relocates: string[] }
    w.__engines = []
    w.__relocates = []
    Object.assign(window, { showDirectoryPicker: async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true }) })
    // oxlint-disable-next-line typescript/unbound-method
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
      apply: (post, worker, args) => {
        if (args[0]?.type === 'relocate') w.__relocates.push(args[0].to)
        return Reflect.apply(post, worker, args)
      },
    })
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor (url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => { if (event.data?.type === 'ready') w.__engines.push(this) })
      }
    }
  })
  await page.route((url) => /\/sintel[^/]*\.torrent$/.test(url.pathname), (route) => route.fulfill({ body: Buffer.from(SAMPLE.bytes), contentType: 'application/x-bittorrent' }))
}

const place = (page: Page, t: Fixture) => page.evaluate(async ({ dir, name, files }) => {
  let at = await navigator.storage.getDirectory()
  for (const part of [...dir.split('/'), name]) at = await at.getDirectoryHandle(part, { create: true })
  for (const { path, size, fill } of files) {
    const writable = await (await at.getFileHandle(path, { create: true })).createWritable()
    await writable.write(new Uint8Array(size).fill(fill))
    await writable.close()
  }
}, { dir: t.dir, name: t.name, files: t.files })

/** Every file in the picked folder, as `path:size`, a swap file mid-write included. */
const inFolder = (page: Page) => page.evaluate(async () => {
  const walk = async (dir: FileSystemDirectoryHandle, at: string): Promise<string[]> => {
    const found: string[] = []
    for await (const [name, handle] of (dir as unknown as { entries: () => AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind === 'directory') found.push(...await walk(handle as FileSystemDirectoryHandle, `${at}${name}/`))
      else found.push(`${at}${name}:${(await (handle as FileSystemFileHandle).getFile()).size}`)
    }
    return found
  }
  return (await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true }), '')).sort()
})

const relocates = (page: Page) => page.evaluate(() => (window as unknown as { __relocates: string[] }).__relocates)

const row = (page: Page, name: string) => page.locator('.torrent', { hasText: name }).first()

const filesGoThere = async (page: Page) => {
  await page.getByRole('button', { name: 'Files stay in the browser', exact: true }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Files go to picked', exact: true }).waitFor({ timeout: 10_000 })
}

/** From the library, and back to it: chooses the picked folder in Settings, with files going there when `move`. */
const chooseFolder = async (page: Page, move: boolean) => {
  await page.getByRole('link', { name: 'Settings', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Files stay in the browser', exact: true }).waitFor({ timeout: 10_000 })
  if (move) await filesGoThere(page)
  await page.locator('header a.back').click()
}

/** The sample offer taken, then the film added as temporary, each finished from the files placed for it. */
const addBoth = async (page: Page) => {
  await place(page, SAMPLE)
  await place(page, FILM)
  await page.getByRole('button', { name: 'Add Sintel' }).click({ timeout: 60_000 })
  await page.waitForFunction(() => (window as unknown as { __engines: Worker[] }).__engines.length > 0, undefined, { timeout: 30_000 })
  await page.evaluate((bytes) => {
    (window as unknown as { __engines: Worker[] }).__engines.at(-1)!.postMessage({ type: 'add-torrent-file', bytes: new Uint8Array(bytes), ephemeral: true })
  }, FILM.bytes)
  for (const name of [SAMPLE.name, FILM.name]) {
    await expect(row(page, name).locator('.badge')).toHaveText(/^(Seeding|Completed)$/, { timeout: 60_000 })
    await expect(row(page, name).locator('.temp'), `${name} is not temporary`).toHaveCount(1)
  }
}

const keep = async (page: Page, name: string) => {
  await row(page, name).getByRole('button', { name: `Options for ${name}`, exact: true }).click()
  const dialog = page.getByRole('dialog').last()
  await dialog.getByRole('switch', { name: 'Keep this download' }).click()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

// a move or a copy starts on the state tick after a row finishes or a folder comes, twice a second
const SETTLE = 8_000

for (const move of [true, false]) {
  test(`a temporary torrent and the sample finished with files ${move ? 'going to the folder' : 'staying in the browser'} stay out of it until kept`, async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    await page.goto('/')
    await chooseFolder(page, move)
    await addBoth(page)

    await page.waitForTimeout(SETTLE)
    expect(await inFolder(page), 'a temporary torrent went into the folder').toEqual([])
    expect(await relocates(page)).toEqual([])

    // THE CONTROL: kept, the film goes into the folder, so the checks above could see it
    await keep(page, FILM.name)
    await expect.poll(() => inFolder(page), { timeout: 30_000, message: 'the kept film never reached the folder' }).toEqual(FILM.inFolder)
    expect(await relocates(page)).toEqual(move ? ['folder'] : [])
    await page.waitForTimeout(SETTLE)
    expect(await inFolder(page), 'the sample went into the folder').toEqual(FILM.inFolder)
  })
}

test('a folder chosen later leaves a temporary torrent and the sample in browser storage, in both modes, until kept', async ({ page }) => {
  test.setTimeout(180_000)
  await prepare(page)
  await page.goto('/')
  await addBoth(page)

  await chooseFolder(page, false)
  await page.waitForTimeout(SETTLE)
  expect(await inFolder(page), 'a temporary torrent was copied into the folder chosen').toEqual([])

  await page.getByRole('link', { name: 'Settings', exact: true }).click({ timeout: 30_000 })
  await filesGoThere(page)
  await page.locator('header a.back').click()
  await page.waitForTimeout(SETTLE)
  expect(await inFolder(page), 'a temporary torrent moved into the folder chosen').toEqual([])
  expect(await relocates(page)).toEqual([])

  // THE CONTROL: the sample, kept, moves into the folder
  await keep(page, SAMPLE.name)
  await expect.poll(() => inFolder(page), { timeout: 30_000, message: 'the kept sample never reached the folder' }).toEqual(SAMPLE.inFolder)
  expect(await relocates(page)).toEqual(['folder'])
})
