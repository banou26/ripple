/*
 * Turning Keep off asks, and says, that Ripple may delete a torrent only where it may: in its own directory in browser
 * storage. A torrent in the person's folder, a .torrent added at the shared root and one made from the person's own
 * file are never deleted to free space (tests/torrent/worker-folder-temporary.test.ts), so for them it asks nothing,
 * says nothing, and the Temporary mark says nothing of deleting. Against the real engine and the built page, each
 * torrent's files placed before its add, so no transfer: headless.
 */
import type { Page } from '@playwright/test'

import { createHash } from 'node:crypto'

import { expect, test } from './offline'

const PIECE = 16_384
const HINT = 'May be deleted to free space. Open options to keep it.'

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

/** One file of `size` bytes of `fill`, placed at `dir` in browser storage, and the one-file torrent of it. */
const file = (name: string, dir: (infoHash: string) => string, size: number, fill: number) => {
  const all = Buffer.alloc(size, fill)
  const pieces: Buffer[] = []
  for (let at = 0; at < size; at += PIECE) pieces.push(createHash('sha1').update(all.subarray(at, at + PIECE)).digest())
  const info = { name, 'piece length': PIECE, pieces: Buffer.concat(pieces), length: size }
  const infoHash = createHash('sha1').update(bencode(info)).digest('hex')
  return { name, size, fill, dir: dir(infoHash), infoHash, bytes: [...bencode({ info })] }
}

// in its own directory, where the engine puts a magnet's files, and later moved into the folder
const OWN = file('Lantern.bin', (infoHash) => `dl/${infoHash}`, 300_000, 0x4c)
// a .torrent added through the page, which saves at the shared root
const AT_ROOT = file('Harbor.bin', () => 'dl', 200_000, 0x48)
// the person's own file, which the picker gives to make a torrent from
const MADE = file('Cove.bin', () => 'own', 150_000, 0x43)

/** A folder and a file the pickers give, and a record of the engine and of where it says each torrent is. */
const prepare = (page: Page) => page.addInitScript(() => {
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
  const w = window as unknown as { __engines: Worker[], __at: Record<string, string> }
  w.__engines = []
  w.__at = {}
  Object.assign(window, {
    showDirectoryPicker: async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true }),
    showOpenFilePicker: async () => [await (await (await navigator.storage.getDirectory()).getDirectoryHandle('own')).getFileHandle('Cove.bin')],
  })
  const Original = window.Worker
  window.Worker = class extends Original {
    constructor (url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type === 'ready') w.__engines.push(this)
        if (event.data?.type !== 'state') return
        for (const t of event.data.torrents ?? []) {
          const hash = /xt=urn:btih:([0-9a-f]{40})/i.exec(t.magnet ?? '')?.[1]?.toLowerCase()
          if (hash && t.status?.savePath) w.__at[hash] = t.status.savePath
        }
      })
    }
  }
})

const place = (page: Page) => page.evaluate(async (files) => {
  for (const { dir, name, size, fill } of files) {
    let at = await navigator.storage.getDirectory()
    for (const part of dir.split('/')) at = await at.getDirectoryHandle(part, { create: true })
    const writable = await (await at.getFileHandle(name, { create: true })).createWritable()
    await writable.write(new Uint8Array(size).fill(fill))
    await writable.close()
  }
}, [OWN, AT_ROOT, MADE].map(({ dir, name, size, fill }) => ({ dir, name, size, fill })))

/** Where the engine last said the torrent is. */
const at = (page: Page, infoHash: string) => page.evaluate((hash) => (window as unknown as { __at: Record<string, string> }).__at[hash], infoHash)

/** Whether the list the engine keeps has the torrent temporary. */
const temporary = (page: Page, infoHash: string) => page.evaluate((hash) => new Promise<boolean | undefined>((resolve) => {
  const open = indexedDB.open('keyval-store')
  open.onerror = () => resolve(undefined)
  open.onsuccess = () => {
    const read = open.result.transaction('keyval', 'readonly').objectStore('keyval').get('ripple:torrents')
    read.onsuccess = () => resolve((read.result as { infoHash: string, ephemeral?: boolean }[] | undefined)?.find((e) => e.infoHash === hash)?.ephemeral)
    read.onerror = () => resolve(undefined)
  }
}), infoHash)

/** Every toast shown from now, since one is gone within seconds. */
const toasts = async (page: Page) => {
  await page.evaluate(() => {
    const w = window as unknown as { __toasts: string[] }
    w.__toasts = []
    new MutationObserver(() => {
      for (const { textContent } of document.querySelectorAll('.toast')) if (textContent && !w.__toasts.includes(textContent)) w.__toasts.push(textContent)
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  return () => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)
}

const row = (page: Page, name: string) => page.locator('.torrent', { hasText: name }).first()

test('turning Keep off asks and says Ripple may delete a torrent only in its own directory in browser storage', async ({ page }) => {
  test.setTimeout(240_000)
  await prepare(page)
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'picked', exact: true }).waitFor({ timeout: 10_000 })
  await page.locator('header a.back').click()
  await place(page)
  const shown = await toasts(page)

  const create = page.getByRole('dialog')
  await page.getByRole('button', { name: 'Create a torrent' }).click({ timeout: 30_000 })
  await create.getByRole('button', { name: 'Choose a file', exact: true }).click()
  await create.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(create.getByText('is being shared')).toBeVisible({ timeout: 60_000 })
  const made = (await create.locator('code').first().textContent())!.toLowerCase()
  await create.getByRole('button', { name: 'Close' }).click()
  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: 'Harbor.torrent', mimeType: 'application/x-bittorrent', buffer: Buffer.from(AT_ROOT.bytes) })
  await page.waitForFunction(() => (window as unknown as { __engines: Worker[] }).__engines.length > 0, undefined, { timeout: 30_000 })
  await page.evaluate(({ bytes, savePath }) => {
    (window as unknown as { __engines: Worker[] }).__engines.at(-1)!.postMessage({ type: 'add-torrent-file', bytes: new Uint8Array(bytes), savePath })
  }, { bytes: OWN.bytes, savePath: `/dl/${OWN.infoHash}` })
  for (const name of [MADE.name, AT_ROOT.name, OWN.name]) await expect(row(page, name).locator('.badge')).toHaveText('Seeding', { timeout: 60_000 })
  // each where its kind is
  await expect.poll(() => Promise.all([at(page, OWN.infoHash), at(page, AT_ROOT.infoHash), at(page, made)]))
    .toEqual([`/dl/${OWN.infoHash}`, '/dl', `/source/${made}`])

  const keep = page.getByRole('switch', { name: 'Keep this download' })
  const asked = (name: string) => page.getByRole('heading', { name: `Let Ripple delete ${name}?` })
  const told = (name: string) => `${name} can be deleted to free space`
  const mark = (name: string) => row(page, name).locator('.temp')
  const options = async (name: string) => {
    await row(page, name).getByRole('button', { name: `Options for ${name}`, exact: true }).click()
    await expect(keep).toBeVisible()
  }
  const done = async () => {
    await page.getByRole('dialog').last().getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  /** Keep off on a torrent Ripple never deletes: no question, no message, and a mark with nothing to say of it. */
  const neverAsked = async (name: string, infoHash: string) => {
    await page.evaluate(() => { (window as unknown as { __toasts: string[] }).__toasts.length = 0 })
    await options(name)
    await keep.click()
    await expect.poll(() => temporary(page, infoHash), { timeout: 10_000, message: `${name} was asked about` }).toBe(true)
    await expect(keep).not.toBeChecked()
    await expect(asked(name)).toHaveCount(0)
    await done()
    await expect(mark(name)).toHaveCount(1)
    await expect(mark(name)).not.toHaveAttribute('data-tooltip-content')
    expect(await shown()).not.toContain(told(name))
  }

  const askOff = async (name: string, infoHash: string) => {
    await page.evaluate(() => { (window as unknown as { __toasts: string[] }).__toasts.length = 0 })
    await options(name)
    await keep.click()
    await expect(asked(name)).toBeVisible()
    await expect(page.getByRole('dialog').last()).toContainText('Ripple may delete its files when storage runs low.')
    await page.getByRole('button', { name: 'Let Ripple delete it' }).click()
    await expect.poll(shown).toContain(told(name))
    await expect.poll(() => temporary(page, infoHash), { timeout: 10_000 }).toBe(true)
    await done()
    await expect(mark(name)).toHaveAttribute('data-tooltip-content', HINT)
  }

  // THE CONTROL, in its own directory: asked, told after, and its mark says it may be deleted
  await askOff(OWN.name, OWN.infoHash)
  await neverAsked(AT_ROOT.name, AT_ROOT.infoHash)
  await neverAsked(MADE.name, made)

  // table view carries the same rule on every row
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const tableMark = (name: string) => page.locator('.torrent-table tbody tr', { hasText: name }).locator('.temp')
  await expect(tableMark(OWN.name)).toHaveAttribute('data-tooltip-content', HINT)
  await expect(tableMark(AT_ROOT.name)).not.toHaveAttribute('data-tooltip-content')
  await expect(tableMark(MADE.name)).not.toHaveAttribute('data-tooltip-content')
  await page.getByRole('button', { name: 'Cards', exact: true }).click()

  // moved into the folder while still temporary: the mark stays and stops saying it may be deleted
  await options(OWN.name)
  await page.getByRole('dialog').last().getByRole('radio', { name: 'Move to picked' }).click({ timeout: 10_000 })
  await done()
  await expect.poll(() => at(page, OWN.infoHash), { timeout: 60_000, message: 'it never moved into the folder' }).toBe(`/native/${OWN.infoHash}`)
  await expect(mark(OWN.name)).toHaveCount(1)
  await expect(mark(OWN.name)).not.toHaveAttribute('data-tooltip-content')

  // kept in the folder, then un-kept there: still never asked or told
  await options(OWN.name)
  await keep.click()
  await expect.poll(() => temporary(page, OWN.infoHash), { timeout: 10_000 }).toBe(false)
  await done()
  await neverAsked(OWN.name, OWN.infoHash)

  // moved back to browser storage while temporary: owns its directory again, so the mark and Keep off say so again
  await options(OWN.name)
  await page.getByRole('dialog').last().getByRole('radio', { name: 'Keep in browser storage' }).click({ timeout: 10_000 })
  await done()
  await expect.poll(() => at(page, OWN.infoHash), { timeout: 60_000, message: 'it never moved back to browser storage' }).toBe(`/dl/${OWN.infoHash}`)
  await expect(mark(OWN.name)).toHaveAttribute('data-tooltip-content', HINT)
  await options(OWN.name)
  await keep.click()
  await expect.poll(() => temporary(page, OWN.infoHash), { timeout: 10_000 }).toBe(false)
  await done()
  await askOff(OWN.name, OWN.infoHash)
})
