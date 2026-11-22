/*
 * A temporary torrent with every file on this device, started again while nobody watches it, against the real engine
 * and the built page. A restart with no saved state checks the files from the start, and a temporary torrent nobody
 * watches is parked, which stops a check where it is: the row read Queued at 0% for good. No transfer, so this is
 * headless.
 */
import type { Page } from '@playwright/test'

import { createHash } from 'node:crypto'

import { expect, test } from './offline'

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

const NAME = 'Watched'
const PIECE = 64 * 1024
const FILES = [{ path: 'film.bin', size: 4 * 1024 * 1024, fill: 0x46 }, { path: 'film.srt', size: 20_000, fill: 0x53 }]
const all = Buffer.concat(FILES.map((f) => Buffer.alloc(f.size, f.fill)))
const pieces: Buffer[] = []
for (let at = 0; at < all.length; at += PIECE) pieces.push(createHash('sha1').update(all.subarray(at, at + PIECE)).digest())
const info = { name: NAME, 'piece length': PIECE, pieces: Buffer.concat(pieces), files: FILES.map((f) => ({ length: f.size, path: [f.path] })) }
const TORRENT = bencode({ info })
const INFO_HASH = createHash('sha1').update(bencode(info)).digest('hex')

type Report = { savePath: string, paused: boolean, progress: number }

/** Every page opens with no sample offer, a folder the picker gives, and a record of the engine's reports. */
const prepare = (page: Page) => page.addInitScript((infoHash) => {
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
  const w = window as unknown as { __reports: Report[] }
  w.__reports = []
  Object.assign(window, { showDirectoryPicker: async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true }) })
  const Original = window.Worker
  window.Worker = class extends Original {
    constructor (url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type !== 'state') return
        const t = (event.data.torrents ?? []).find((row: { magnet?: string }) => row.magnet?.toLowerCase().includes(infoHash))
        if (t?.status) w.__reports.push({ savePath: t.status.savePath, paused: t.status.paused, progress: t.status.progress })
      })
    }
  }
}, INFO_HASH)

const reports = (page: Page) => page.evaluate(() => (window as unknown as { __reports: Report[] }).__reports)

/** One key of the raw idb-keyval store, where the worker keeps the list and each torrent's saved state. */
const stored = (page: Page, key: string) => page.evaluate((key) => new Promise<unknown>((resolve) => {
  const open = indexedDB.open('keyval-store')
  open.onerror = () => resolve('open failed')
  open.onsuccess = () => {
    const read = open.result.transaction('keyval', 'readonly').objectStore('keyval').get(key)
    read.onsuccess = () => resolve(read.result)
    read.onerror = () => resolve('read failed')
  }
}), key)

const savedState = async (page: Page) => !!((await stored(page, `ripple:resume:${INFO_HASH}`)) as Uint8Array | undefined)?.byteLength
const entry = async (page: Page) => ((await stored(page, 'ripple:torrents')) as { infoHash: string, ephemeral?: boolean, paused?: boolean }[] | undefined)
  ?.find((e) => e.infoHash === INFO_HASH)

const row = (page: Page) => page.locator('.torrent', { hasText: NAME }).first()

/** Placed under the shared root, where a .torrent add saves, so its first check finds every file, then added. */
const addWhole = async (page: Page) => {
  await page.locator('input[type=file][accept*=".torrent"]').waitFor({ state: 'attached', timeout: 30_000 })
  await page.evaluate(async ({ name, files }) => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('dl', { create: true })).getDirectoryHandle(name, { create: true })
    for (const { path, size, fill } of files) {
      const writable = await (await dir.getFileHandle(path, { create: true })).createWritable()
      await writable.write(new Uint8Array(size).fill(fill))
      await writable.close()
    }
  }, { name: NAME, files: FILES })
  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${NAME}.torrent`, mimeType: 'application/x-bittorrent', buffer: TORRENT })
  await expect(row(page).locator('.badge')).toHaveText('Seeding', { timeout: 60_000 })
}

/** Keep this download off, which makes it temporary as a film opened from a link is. */
const makeTemporary = async (page: Page) => {
  await row(page).getByRole('button', { name: `Options for ${NAME}` }).click()
  await page.getByRole('switch', { name: 'Keep this download' }).click()
  await page.getByRole('dialog').last().getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => (await entry(page))?.ephemeral, { timeout: 10_000 }).toBe(true)
}

/** Completed is finished and stopped, so it reads only once the check ended and the park landed; and it stays. */
const parkedWhole = async (page: Page) => {
  await expect(row(page).locator('.badge')).toHaveText('Completed', { timeout: 30_000 })
  await expect(row(page).locator('.pct')).toHaveText('100%')
  // the park saves its state, which the engine refuses mid-check
  await expect.poll(() => savedState(page), { timeout: 10_000, message: 'the park saved no state' }).toBe(true)
  const from = (await reports(page)).length
  await page.waitForTimeout(3_000)
  const after = (await reports(page)).slice(from)
  expect(after.length, 'the engine stopped reporting').toBeGreaterThan(2)
  expect(after.filter((r) => !r.paused || r.progress < 1), 'the parked torrent started again').toEqual([])
  await expect(row(page).locator('.badge')).toHaveText('Completed')
  // nobody's pause: the person never stopped it
  expect((await entry(page))?.paused).not.toBe(true)
  expect((await entry(page))?.ephemeral).toBe(true)
}

test('a temporary torrent started again with no saved state, nobody watching, reads Completed and stays parked', async ({ page }) => {
  test.setTimeout(180_000)
  await prepare(page)
  await page.goto('/')
  await addWhole(page)
  await makeTemporary(page)

  // a page left before the state was saved: the engine stops with the page, and its saved state is gone
  await page.goto('/README.md')
  await page.evaluate((key) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('keyval-store')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('keyval', 'readwrite')
      tx.objectStore('keyval').delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
  }), `ripple:resume:${INFO_HASH}`)
  // THE CONTROL: no saved state, so the start checks the files, and the kept .torrent gives it its file list
  expect(await savedState(page)).toBe(false)
  expect(((await stored(page, `ripple:torrent:${INFO_HASH}`)) as Uint8Array | undefined)?.byteLength).toBeGreaterThan(0)
  await page.goto('/')

  await parkedWhole(page)
})

test('a temporary torrent moved into the folder with nobody watching reads Completed and stays parked', async ({ page }) => {
  test.setTimeout(180_000)
  await prepare(page)
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'picked', exact: true }).waitFor({ timeout: 10_000 })
  await page.locator('header a.back').click()
  await addWhole(page)
  await makeTemporary(page)

  await row(page).getByRole('button', { name: `Options for ${NAME}`, exact: true }).click()
  await page.getByRole('dialog').last().getByRole('radio', { name: 'Move to picked' }).click({ timeout: 10_000 })
  await page.getByRole('dialog').last().getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // THE CONTROL: it was added again at the folder, which checks the files there from the start
  const moved = `/native/${INFO_HASH}`
  await expect.poll(async () => (await reports(page)).some((r) => r.savePath === moved), { timeout: 60_000, message: 'the torrent never moved into the folder' }).toBe(true)
  await parkedWhole(page)
})
