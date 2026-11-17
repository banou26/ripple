/*
 * A torrent added from a .torrent file and moved into the person's folder, against the real engine and the built page.
 *
 * The move adds the torrent again at the folder. A .torrent add's stored magnet is its bare hash, so a re-add from it
 * has no file list until a peer sends one, and with no peer the row read "Fetching metadata…" at 0% until a reload.
 * Here the files are placed in browser storage before the add, so the torrent finishes with no peer and moves on its
 * own, and nothing but its kept .torrent can give the folder copy its file list. No transfer, so this is headless.
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

const NAME = 'Whole'
const FILES = [{ path: 'x.bin', size: 50_000, fill: 0x44 }, { path: 'y.bin', size: 30_000, fill: 0x55 }]

const all = Buffer.concat(FILES.map((f) => Buffer.alloc(f.size, f.fill)))
const pieces: Buffer[] = []
for (let at = 0; at < all.length; at += PIECE) pieces.push(createHash('sha1').update(all.subarray(at, at + PIECE)).digest())
const info = { name: NAME, 'piece length': PIECE, pieces: Buffer.concat(pieces), files: FILES.map((f) => ({ length: f.size, path: [f.path] })) }
const TORRENT = bencode({ info })
const INFO_HASH = createHash('sha1').update(bencode(info)).digest('hex')
const MOVED = `/native/${INFO_HASH}`

type Row = { progress: number, state: number | null, files: number }

test('a .torrent add moved into the folder keeps its file list and its progress', async ({ page }) => {
  test.setTimeout(180_000)
  await page.addInitScript((moved) => {
    const w = window as any
    try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
    w.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true })
    // every report of the torrent once it is at the folder, from the first
    w.__moved = []
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor (url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type !== 'state') return
          const t = (event.data.torrents ?? []).find((row: any) => row.status?.savePath === moved)
          if (t) w.__moved.push({ progress: t.status.progress, state: t.status.state, files: (t.files?.files ?? []).length })
        })
      }
    }
  }, MOVED)
  const reports = () => page.evaluate(() => (window as any).__moved as Row[])

  await page.goto('/')
  await page.getByRole('link', { name: 'Settings', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'picked', exact: true }).waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Start straight away', exact: true }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Ask what to download', exact: true }).waitFor({ timeout: 10_000 })
  await page.locator('header a.back').click()

  // a .torrent add saves under the shared root, so this is where the engine's first check finds them
  await page.evaluate(async ({ name, files }) => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('dl', { create: true })).getDirectoryHandle(name, { create: true })
    for (const { path, size, fill } of files) {
      const writable = await (await dir.getFileHandle(path, { create: true })).createWritable()
      await writable.write(new Uint8Array(size).fill(fill))
      await writable.close()
    }
  }, { name: NAME, files: FILES })

  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${NAME}.torrent`, mimeType: 'application/x-bittorrent', buffer: TORRENT })
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Add torrent' }).waitFor({ timeout: 20_000 })
  await dialog.locator('label.check', { hasText: 'picked' }).locator('input').check()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 10_000 })

  // THE CONTROL: it reached the folder, so the move ran
  await expect.poll(async () => (await reports()).length, { timeout: 90_000, message: 'the torrent never moved into the folder' }).toBeGreaterThan(0)
  await expect.poll(async () => ((await reports()).at(-1)?.progress ?? 0) >= 1, { timeout: 30_000, message: 'the moved torrent lost its progress' }).toBe(true)
  const seen = await reports()
  // libtorrent's 2 is downloading metadata
  expect(seen.filter((r) => r.state === 2), 'the moved torrent waited for its metadata').toEqual([])
  expect(seen.at(-1)?.files).toBe(FILES.length)
  await expect(page.locator('strong', { hasText: /^Whole$/ }).first()).toBeVisible()
  await expect(page.getByText('Fetching metadata…')).toHaveCount(0)
  // its saved state, which a reload restores it from
  const saved = () => page.evaluate((key) => new Promise<boolean>((resolve) => {
    const open = indexedDB.open('keyval-store')
    open.onsuccess = () => {
      const read = open.result.transaction('keyval', 'readonly').objectStore('keyval').get(key)
      read.onsuccess = () => resolve(!!read.result?.byteLength)
      read.onerror = () => resolve(false)
    }
    open.onerror = () => resolve(false)
  }), `ripple:resume:${INFO_HASH}`)
  await expect.poll(saved, { timeout: 15_000, message: 'the moved torrent saved no state' }).toBe(true)
})

/*
 * A magnet add whose metadata landed keeps no .torrent of its own, only its saved state, which the move deletes. The
 * state is made here the way the engine makes it, by a .torrent add in browser storage; the kept file is then dropped
 * and the entry given a magnet, which is what a magnet add looks like once its metadata is in. The reload restores it
 * from that state and the move follows.
 */
test('a magnet add whose metadata landed, moved into the folder, keeps its file list without a peer', async ({ page }) => {
  test.setTimeout(240_000)
  await page.addInitScript((moved) => {
    const w = window as any
    try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
    w.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true })
    w.__moved = []
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor (url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type !== 'state') return
          const t = (event.data.torrents ?? []).find((row: any) => row.status?.savePath === moved)
          if (t) w.__moved.push({ progress: t.status.progress, state: t.status.state, files: (t.files?.files ?? []).length })
        })
      }
    }
  }, MOVED)
  const reports = () => page.evaluate(() => (window as any).__moved as Row[])
  const stored = (key: string) => page.evaluate((key) => new Promise<number[] | null>((resolve) => {
    const open = indexedDB.open('keyval-store')
    open.onsuccess = () => {
      const read = open.result.transaction('keyval', 'readonly').objectStore('keyval').get(key)
      read.onsuccess = () => resolve(read.result?.byteLength ? [...new Uint8Array(read.result)] : null)
      read.onerror = () => resolve(null)
    }
    open.onerror = () => resolve(null)
  }), key)

  await page.goto('/')
  await page.getByRole('link', { name: 'Settings', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'picked', exact: true }).waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Start straight away', exact: true }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Ask what to download', exact: true }).waitFor({ timeout: 10_000 })
  await page.locator('header a.back').click()

  await page.evaluate(async ({ name, files }) => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('dl', { create: true })).getDirectoryHandle(name, { create: true })
    for (const { path, size, fill } of files) {
      const writable = await (await dir.getFileHandle(path, { create: true })).createWritable()
      await writable.write(new Uint8Array(size).fill(fill))
      await writable.close()
    }
  }, { name: NAME, files: FILES })

  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${NAME}.torrent`, mimeType: 'application/x-bittorrent', buffer: TORRENT })
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Add torrent' }).waitFor({ timeout: 20_000 })
  await dialog.locator('label.check', { hasText: 'Browser storage' }).locator('input').check()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 10_000 })

  // THE CONTROL: the saved state carries the metadata, which is all a magnet add has once it landed
  const carriesInfo = async () => {
    const bytes = await stored(`ripple:resume:${INFO_HASH}`)
    return !!bytes && Buffer.from(bytes).includes('4:info')
  }
  await expect.poll(carriesInfo, { timeout: 60_000, message: 'the torrent saved no state with its metadata' }).toBe(true)

  await page.evaluate(({ hash, magnet }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('keyval-store')
    open.onsuccess = () => {
      const tx = open.result.transaction('keyval', 'readwrite')
      const store = tx.objectStore('keyval')
      store.delete(`ripple:torrent:${hash}`)
      const list = store.get('ripple:torrents')
      list.onsuccess = () => store.put(list.result.map((e: any) => (e.infoHash === hash ? { ...e, magnet, saveTo: 'folder' } : e)), 'ripple:torrents')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
    open.onerror = () => reject(open.error)
  }), { hash: INFO_HASH, magnet: `magnet:?xt=urn:btih:${INFO_HASH}&dn=${NAME}` })
  expect(await stored(`ripple:torrent:${INFO_HASH}`), 'the .torrent add\'s own file is still kept').toBeNull()
  await page.reload()

  await expect.poll(async () => (await reports()).length, { timeout: 90_000, message: 'the torrent never moved into the folder' }).toBeGreaterThan(0)
  await expect.poll(async () => ((await reports()).at(-1)?.progress ?? 0) >= 1, { timeout: 30_000, message: 'the moved torrent lost its progress' }).toBe(true)
  const seen = await reports()
  expect(seen.filter((r) => r.state === 2), 'the moved torrent waited for its metadata').toEqual([])
  expect(seen.at(-1)?.files).toBe(FILES.length)
  await expect(page.getByText('Fetching metadata…')).toHaveCount(0)
})
