/*
 * Seeding settings persistence, real ephemeral playback completion auto-pause (with OPFS reads while paused),
 * and library seeding policy enforcement + manual Start override against the real app and libtorrent-wasm.
 */
import type { BrowserContext, Page } from '@playwright/test'

import { createHash } from 'node:crypto'

import { expect, test } from './offline'
import { startTracker } from './vpn-off/tracker.mjs'

test.use({
  launchOptions: {
    executablePath: process.env.RIPPLE_CHROME || undefined,
    args: ['--mute-audio', '--host-resolver-rules=MAP ripple-tracker.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
  },
})

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

const FILE = { name: 'film.mkv', bytes: 1_500_000 }
const PIECE = 64 * 1024

type Row = {
  handle: number
  infoHash: string
  ephemeral: boolean
  progress: number
  state: number | null
  paused: boolean
  upload: number
}
type Seen = { rows: Row[], fatal: string[], pausedChanges: boolean[] }

const install = (file: typeof FILE) => {
  const w = window as unknown as {
    __seen: Seen
    __engine?: Worker
    __readSample?: (handle: number, offset: number, len: number) => Promise<number[]>
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
  }
  const seen: Seen = w.__seen = { rows: [], fatal: [], pausedChanges: [] }
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch {}

  const lastPaused = new Map<number, boolean>()
  const pendingReads = new Map<number, (data: Uint8Array) => void>()
  let nextReadId = -1000

  const hear = (data: Record<string, unknown> | null | undefined) => {
    if (!data) return
    if (data.type === 'read-result' && typeof data.id === 'number') {
      const resolve = pendingReads.get(data.id)
      if (resolve) { pendingReads.delete(data.id); resolve(data.data as Uint8Array) }
      return
    }
    if (data.type === 'fatal' || data.type === 'worker-error') {
      seen.fatal.push(String(data.message ?? data.args))
      return
    }
    if (data.type !== 'state') return
    const torrents = (data.torrents ?? []) as {
      handle: number, magnet?: string, ephemeral?: boolean,
      status?: { progress: number, state: number, paused: boolean, allTimeUpload: number },
    }[]
    seen.rows = torrents.map((t) => {
      const paused = t.status?.paused ?? false
      if (lastPaused.get(t.handle) !== paused) {
        lastPaused.set(t.handle, paused)
        seen.pausedChanges.push(paused)
      }
      return {
        handle: t.handle,
        infoHash: /btih:([0-9a-f]{40})/i.exec(t.magnet ?? '')?.[1]?.toLowerCase() ?? '',
        ephemeral: t.ephemeral === true,
        progress: t.status?.progress ?? 0,
        state: t.status?.state ?? null,
        paused,
        upload: t.status?.allTimeUpload ?? 0,
      }
    })
  }

  const Original = window.Worker
  window.Worker = class extends Original {
    constructor (url: string | URL, options?: WorkerOptions) {
      super(url, options)
      if (!/\/assets\/worker-/.test(String(url))) return
      w.__engine = this
      this.addEventListener('message', ({ data }: MessageEvent) => hear(data))
    }
  }
  new BroadcastChannel('ripple:torrent').addEventListener('message', ({ data }) => {
    if (data?.to === 'all' && !w.__engine) hear(data.msg)
  })

  w.__readSample = (handle: number, offset: number, len: number) => new Promise((resolve) => {
    const id = --nextReadId
    pendingReads.set(id, (data) => resolve([...data]))
    w.__engine?.postMessage({ type: 'watch', viewer: 'probe:1', handle, fileIndex: 0, fromOffset: offset, readLen: len })
    w.__engine?.postMessage({ type: 'read', id, handle, fileIndex: 0, offset, len, prioritize: true, viewer: 'probe:1' })
  })

  w.showDirectoryPicker = async () => {
    const bytes = new Uint8Array(file.bytes)
    for (let i = 0, x = 0x9e3779b9; i < bytes.length; i++) {
      x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + i | 0
      bytes[i] = x >>> 24
    }
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('ripple-seed-test', { create: true })
    const handle = await dir.getFileHandle(file.name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(bytes)
    await writable.close()
    return dir
  }
}

const expectedSlice = (offset: number, len: number): number[] => {
  const bytes = new Uint8Array(FILE.bytes)
  for (let i = 0, x = 0x9e3779b9; i < bytes.length; i++) {
    x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + i | 0
    bytes[i] = x >>> 24
  }
  return [...bytes.subarray(offset, offset + len)]
}

const openVisitor = async (context: BrowserContext, origin: string, path = '/') => {
  await context.grantPermissions(['microphone'], { origin })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (/Aborted\(|RuntimeError/.test(message.text())) errors.push(message.text()) })
  await page.addInitScript(install, FILE)
  await page.goto(path)
  return { page, errors }
}

const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: Seen }).__seen)
const rowOf = async (page: Page, infoHash: string) => (await seen(page)).rows.find((r) => r.infoHash === infoHash)

let tracker: Awaited<ReturnType<typeof startTracker>>
test.beforeEach(async () => { tracker = await startTracker() })
test.afterEach(async () => { await tracker.close() })

test('Settings Seeding policy defaults to Keep seeding, persists ratio and duration across reload, and syncs across tabs', async ({ browser, baseURL }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))

  await page.goto(`${baseURL}/settings`)
  const row = page.locator('main .folder', { hasText: 'Seeding' })
  const modeSelect = row.getByLabel('Seeding')
  await expect(modeSelect).toHaveValue('keep')
  expect(await page.evaluate(() => localStorage.getItem('ripple:seeding-policy'))).toBeNull()

  await modeSelect.selectOption('stop')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ mode: 'stop' })

  await modeSelect.selectOption('ratio')
  const ratioInput = row.getByLabel('Share ratio')
  await expect(ratioInput).toBeVisible()
  await page.evaluate(() => {
    const w = window as unknown as { __policyWrites: number }
    w.__policyWrites = 0
    const proto = Storage.prototype as unknown as { setItem: (key: string, value: string) => void }
    const orig = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')?.value as (key: string, value: string) => void
    proto.setItem = function (key: string, value: string) {
      if (key === 'ripple:seeding-policy') w.__policyWrites += 1
      orig.call(this, key, value)
    }
  })
  await ratioInput.fill('1.75')
  // edits stay local until committed by Enter or blur so intermediate keystrokes never trigger engine churn
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ mode: 'ratio', ratio: 1 })
  await ratioInput.press('Enter')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ mode: 'ratio', ratio: 1.75 })
  expect(await page.evaluate(() => (window as unknown as { __policyWrites: number }).__policyWrites)).toBe(1)
  // Escape reverts the draft without saving
  await ratioInput.fill('2.5')
  await ratioInput.press('Escape')
  await expect(ratioInput).toHaveValue('1.75')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ mode: 'ratio', ratio: 1.75 })
  // invalid input does not corrupt stored policy and restores last valid value on blur
  await ratioInput.fill('0')
  await ratioInput.blur()
  await expect(ratioInput).toHaveValue('1.75')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ mode: 'ratio', ratio: 1.75 })

  await modeSelect.selectOption('duration')
  const minutesInput = row.getByLabel('Minutes')
  await expect(minutesInput).toBeVisible()
  await minutesInput.fill('45')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ mode: 'duration', minutes: 60 })
  await minutesInput.blur()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ mode: 'duration', minutes: 45 })
  await minutesInput.fill('90')
  await minutesInput.press('Escape')
  await expect(minutesInput).toHaveValue('45')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ mode: 'duration', minutes: 45 })

  await page.reload()
  await expect(modeSelect).toHaveValue('duration')
  await expect(row.getByLabel('Minutes')).toHaveValue('45')

  // changing the policy in a second tab updates the first tab live
  const second = await context.newPage()
  await second.goto(`${baseURL}/settings`)
  await second.locator('main .folder', { hasText: 'Seeding' }).getByLabel('Seeding').selectOption('stop')
  await expect(modeSelect).toHaveValue('stop')

  await second.close()
  await context.close()
  expect(errors).toEqual([])
})

test('ephemeral /watch playback stops seeding on completion while OPFS reads and seeks keep serving bytes', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const trackerUrl = `ws://ripple-tracker.test:${tracker.port}`
  const seeder = await openVisitor(await browser.newContext(), baseURL!, '/')

  await seeder.page.getByRole('button', { name: 'Create a torrent' }).click()
  await seeder.page.getByRole('button', { name: 'Choose a folder', exact: true }).click()
  const dialog = seeder.page.getByRole('dialog')
  await expect(dialog.getByLabel('Piece size')).toBeVisible({ timeout: 30_000 })
  await dialog.getByLabel('Piece size').selectOption(String(PIECE))
  await dialog.getByLabel('Trackers, one per line').fill(trackerUrl)
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.getByText('is being shared')).toBeVisible({ timeout: 120_000 })
  const infoHash = (await dialog.locator('code').first().textContent())!
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect.poll(async () => (await rowOf(seeder.page, infoHash))?.state, { timeout: 60_000 }).toBe(5)

  const magnet = `magnet:?xt=urn:btih:${infoHash}&tr=${encodeURIComponent(trackerUrl)}`
  const watchPath = `/watch?${new URLSearchParams({ magnet: Buffer.from(magnet).toString('base64') })}`
  const viewer = await openVisitor(await browser.newContext(), baseURL!, watchPath)

  // download completes in /watch while the viewer stays open, then auto-pauses immediately
  await expect.poll(async () => (await rowOf(viewer.page, infoHash))?.progress, { timeout: 120_000 }).toBe(1)
  await expect.poll(async () => (await rowOf(viewer.page, infoHash))?.paused, { timeout: 15_000 }).toBe(true)

  const pausedRow = (await rowOf(viewer.page, infoHash))!
  expect(pausedRow.ephemeral).toBe(true)
  expect(pausedRow.state === 4 || pausedRow.state === 5, `state ${pausedRow.state}`).toBe(true)

  // OPFS playback reads and seeks on the paused torrent return exact bytes without waking/seeding
  const changesBefore = (await seen(viewer.page)).pausedChanges.length
  const sampleOffset = 512 * 1024
  const sampleLen = 32 * 1024
  const sample = await viewer.page.evaluate(
    ({ handle, offset, len }) => (window as unknown as { __readSample: (h: number, o: number, l: number) => Promise<number[]> }).__readSample(handle, offset, len),
    { handle: pausedRow.handle, offset: sampleOffset, len: sampleLen },
  )
  expect(sample).toEqual(expectedSlice(sampleOffset, sampleLen))

  await viewer.page.waitForTimeout(2_000)
  expect((await seen(viewer.page)).pausedChanges.slice(changesBefore)).toEqual([])
  expect((await rowOf(viewer.page, infoHash))?.paused).toBe(true)

  expect(seeder.errors).toEqual([])
  expect(viewer.errors).toEqual([])
  expect((await seen(seeder.page)).fatal).toEqual([])
  expect((await seen(viewer.page)).fatal).toEqual([])
})

test('library seeding policy stops completed torrents per setting while manual Start resumes seeding', async ({ page }) => {
  test.setTimeout(180_000)
  const NAME = 'PolicySeedTest'
  const FILES = [{ path: 'clip.bin', size: 2 * 1024 * 1024, fill: 0x3a }]
  const all = Buffer.concat(FILES.map((f) => Buffer.alloc(f.size, f.fill)))
  const pieces: Buffer[] = []
  for (let at = 0; at < all.length; at += PIECE) pieces.push(createHash('sha1').update(all.subarray(at, at + PIECE)).digest())
  const info = { name: NAME, 'piece length': PIECE, pieces: Buffer.concat(pieces), files: FILES.map((f) => ({ length: f.size, path: [f.path] })) }
  const TORRENT = bencode({ info })

  await page.addInitScript(() => { try { localStorage.setItem('ripple:demo-seeded', '1') } catch {} })
  await page.goto('/')
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

  const row = page.locator('.torrent', { hasText: NAME }).first()
  await expect(row.locator('.badge')).toHaveText('Seeding', { timeout: 60_000 })

  // switching policy to Stop when finished stops seeding on the live library torrent
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.locator('main .folder', { hasText: 'Seeding' }).getByLabel('Seeding').selectOption('stop')
  await page.locator('header a.back').click()
  await expect(row.locator('.badge')).toHaveText('Completed', { timeout: 15_000 })

  // pressing Start manually overrides the policy and stays Seeding
  await row.getByRole('button', { name: `Start ${NAME}`, exact: true }).click()
  await expect(row.locator('.badge')).toHaveText('Seeding', { timeout: 15_000 })
  await page.waitForTimeout(2_000)
  await expect(row.locator('.badge')).toHaveText('Seeding')
})
