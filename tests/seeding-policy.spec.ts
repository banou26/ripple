/*
 * qBittorrent-style seeding limits UI, persistence, and real libtorrent-wasm seeding behavior
 * (default seeding stays on for both library and open playback torrents; configured ratio/time limits stop both cleanly).
 */
import type { BrowserContext, Page } from '@playwright/test'

import { expect, test } from './offline'
import { startTracker } from './vpn-off/tracker.mjs'

test.use({
  launchOptions: {
    executablePath: process.env.RIPPLE_CHROME || undefined,
    args: ['--mute-audio', '--host-resolver-rules=MAP ripple-tracker.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
  },
})

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

  const NativeWorker = window.Worker
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      if (/\/assets\/worker-/.test(String(url))) {
        w.__engine = this
        this.addEventListener('message', (event: MessageEvent) => hear(event.data))
      }
    }
  }

  w.__readSample = (handle: number, offset: number, len: number) => new Promise((resolve) => {
    const id = nextReadId--
    pendingReads.set(id, (data) => resolve([...data]))
    w.__engine!.postMessage({ type: 'read', id, handle, fileIndex: 0, offset, len, prioritize: true, viewer: 'spec-opfs' })
  })

  w.showDirectoryPicker = async () => {
    const bytes = new Uint8Array(file.bytes)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + 17) & 0xff
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('ripple-seeding-policy', { create: true })
    const handle = await dir.getFileHandle(file.name, { create: true })
    const writable = await (handle as unknown as { createWritable: () => Promise<{ write: (b: Uint8Array) => Promise<void>, close: () => Promise<void> }> }).createWritable()
    await writable.write(bytes)
    await writable.close()
    return dir
  }
}

const expectedSlice = (offset: number, len: number) => {
  const out = new Array<number>(len)
  for (let i = 0; i < len; i++) out[i] = (((offset + i) * 131) + 17) & 0xff
  return out
}

const openVisitor = async (context: BrowserContext, url: string) => {
  await context.grantPermissions(['microphone'], { origin: new URL(url).origin })
  await context.addInitScript(install, FILE)
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror ${error.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error ${msg.text()}`)
  })
  await page.goto(url)
  return { page, errors }
}

const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: Seen }).__seen)
const rowOf = async (page: Page, infoHash: string) => (await seen(page)).rows.find((row) => row.infoHash === infoHash.toLowerCase())

let tracker: Awaited<ReturnType<typeof startTracker>>
test.beforeAll(async () => { tracker = await startTracker() })
test.afterAll(async () => { await tracker?.close() })

test('Settings Seeding limits default unchecked, persist ratio & time across reload, and sync across tabs', async ({ browser, baseURL }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))

  await page.goto(`${baseURL}/settings`)
  await expect(page.getByRole('group', { name: 'Seeding' })).toBeVisible()
  const row = page.locator('main .folder', { hasText: 'Seeding' })
  const ratioCheck = row.getByRole('checkbox', { name: 'When ratio reaches' })
  const minutesCheck = row.getByRole('checkbox', { name: 'When seeding time reaches' })
  const ratioInput = row.getByLabel('Share ratio')
  const minutesInput = row.getByLabel('Minutes')

  await expect(ratioCheck).not.toBeChecked()
  await expect(minutesCheck).not.toBeChecked()
  await expect(ratioInput).toBeDisabled()
  await expect(minutesInput).toBeDisabled()
  expect(await page.evaluate(() => localStorage.getItem('ripple:seeding-policy'))).toBeNull()

  await ratioCheck.check()
  await expect(ratioInput).toBeEnabled()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ ratio: 1, minutes: null })

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
  // edits stay local until committed by Enter or blur
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ ratio: 1, minutes: null })
  await ratioInput.press('Enter')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ ratio: 1.75, minutes: null })
  expect(await page.evaluate(() => (window as unknown as { __policyWrites: number }).__policyWrites)).toBe(1)

  // Escape reverts the draft without saving
  await ratioInput.fill('2.5')
  await ratioInput.press('Escape')
  await expect(ratioInput).toHaveValue('1.75')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ ratio: 1.75, minutes: null })

  // invalid input (including 0) restores last valid value on blur
  await ratioInput.fill('0')
  await ratioInput.blur()
  await expect(ratioInput).toHaveValue('1.75')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ ratio: 1.75, minutes: null })

  await minutesCheck.check()
  await expect(minutesInput).toBeEnabled()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ ratio: 1.75, minutes: 60 })
  await minutesInput.fill('45')
  await minutesInput.blur()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ ratio: 1.75, minutes: 45 })
  await minutesInput.fill('90')
  await minutesInput.press('Escape')
  await expect(minutesInput).toHaveValue('45')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ ratio: 1.75, minutes: 45 })

  await page.reload()
  await expect(row.getByRole('checkbox', { name: 'When ratio reaches' })).toBeChecked()
  await expect(row.getByRole('checkbox', { name: 'When seeding time reaches' })).toBeChecked()
  await expect(row.getByLabel('Share ratio')).toHaveValue('1.75')
  await expect(row.getByLabel('Minutes')).toHaveValue('45')

  // Unchecking clears the limit while preserving the last entered number in the disabled input
  await row.getByRole('checkbox', { name: 'When ratio reaches' }).uncheck()
  await expect(row.getByLabel('Share ratio')).toBeDisabled()
  await expect(row.getByLabel('Share ratio')).toHaveValue('1.75')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ripple:seeding-policy')!))).toEqual({ ratio: null, minutes: 45 })

  // changing the policy in a second tab updates the first tab live
  const second = await context.newPage()
  await second.goto(`${baseURL}/settings`)
  await second.locator('main .folder', { hasText: 'Seeding' }).getByRole('checkbox', { name: 'When seeding time reaches' }).uncheck()
  await expect(row.getByRole('checkbox', { name: 'When seeding time reaches' })).not.toBeChecked()

  await second.close()
  await context.close()
  expect(errors).toEqual([])
})

const WEBKIT_NO_TRACKER_RIG = 'WebKit has no --host-resolver-rules for ripple-tracker.test and rejects grantPermissions([microphone]) needed for loopback WebRTC ICE candidates (measured WebKit 26.5)'

test('ephemeral /watch playback keeps seeding by default on completion and stops only when viewing closes', async ({ browser, baseURL, browserName }) => {
  test.skip(browserName === 'webkit', WEBKIT_NO_TRACKER_RIG)
  test.setTimeout(240_000)
  const trackerUrl = `ws://ripple-tracker.test:${tracker.port}`
  const seeder = await openVisitor(await browser.newContext(), `${baseURL}/`)

  try {
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
    const viewer = await openVisitor(await browser.newContext(), `${baseURL}${watchPath}`)

    try {
      // download completes in /watch while viewer stays open -> keeps seeding by default (limits unchecked)
      await expect.poll(async () => (await rowOf(viewer.page, infoHash))?.progress, { timeout: 120_000 }).toBe(1)
      const completedRow = (await rowOf(viewer.page, infoHash))!
      expect(completedRow.ephemeral).toBe(true)
      expect(completedRow.state === 4 || completedRow.state === 5, `state ${completedRow.state}`).toBe(true)
      expect(completedRow.paused).toBe(false)

      await viewer.page.waitForTimeout(2_000)
      expect((await rowOf(viewer.page, infoHash))?.paused).toBe(false)

      // OPFS playback reads still work on the completed torrent
      const sampleOffset = 512 * 1024
      const sampleLen = 32 * 1024
      const sample = await viewer.page.evaluate(
        ({ handle, offset, len }) => (window as unknown as { __readSample: (h: number, o: number, l: number) => Promise<number[]> }).__readSample(handle, offset, len),
        { handle: completedRow.handle, offset: sampleOffset, len: sampleLen },
      )
      expect(sample).toEqual(expectedSlice(sampleOffset, sampleLen))

      expect(seeder.errors).toEqual([])
      expect(viewer.errors.filter((e) => !e.includes('Could not open input: Invalid data found when processing input'))).toEqual([])
      expect((await seen(seeder.page)).fatal).toEqual([])
      expect((await seen(viewer.page)).fatal).toEqual([])
    } finally {
      await viewer.page.context().close()
    }
  } finally {
    await seeder.page.context().close()
  }
})

test('library seeding limits keep default Seeding after serving peers, stop at ratio limit, and resume on manual Start', async ({ browser, baseURL, browserName }) => {
  test.skip(browserName === 'webkit', WEBKIT_NO_TRACKER_RIG)
  test.setTimeout(240_000)
  const trackerUrl = `ws://ripple-tracker.test:${tracker.port}`
  const seeder = await openVisitor(await browser.newContext(), `${baseURL}/`)

  try {
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

    const libraryRow = seeder.page.locator('.torrent').first()
    await expect(libraryRow.locator('.badge')).toHaveText('Seeding', { timeout: 30_000 })

    // Serve real bytes to a peer so seeder.allTimeUpload crosses ratio >= 0.5 against 1.5 MB
    const magnet = `magnet:?xt=urn:btih:${infoHash}&tr=${encodeURIComponent(trackerUrl)}`
    const peer = await openVisitor(await browser.newContext(), `${baseURL}/`)
    try {
      await peer.page.getByPlaceholder('Add a magnet link').fill(magnet)
      await peer.page.getByRole('button', { name: 'Add', exact: true }).click()
      await expect.poll(async () => (await rowOf(peer.page, infoHash))?.progress, { timeout: 120_000 }).toBe(1)
      await expect.poll(async () => (await rowOf(seeder.page, infoHash))?.upload ?? 0, { timeout: 60_000 }).toBeGreaterThanOrEqual(FILE.bytes)
      expect(peer.errors).toEqual([])
      expect((await seen(peer.page)).fatal).toEqual([])
    } finally {
      await peer.page.context().close()
    }

    // With default limits unchecked, library torrent keeps Seeding even after serving the full file
    await expect(libraryRow.locator('.badge')).toHaveText('Seeding')
    expect((await rowOf(seeder.page, infoHash))?.paused).toBe(false)

    // Enable When ratio reaches 0.5 -> library torrent stops as Completed
    await seeder.page.getByRole('link', { name: 'Settings' }).click()
    const seedingRow = seeder.page.locator('main .folder', { hasText: 'Seeding' })
    await seedingRow.getByRole('checkbox', { name: 'When ratio reaches' }).check()
    await seedingRow.getByLabel('Share ratio').fill('0.5')
    await seedingRow.getByLabel('Share ratio').press('Enter')
    await seeder.page.locator('header a.back').click()

    await expect(libraryRow.locator('.badge')).toHaveText('Completed', { timeout: 30_000 })
    await expect.poll(async () => (await rowOf(seeder.page, infoHash))?.paused, { timeout: 15_000 }).toBe(true)

    // Manual Start overrides the satisfied limit and resumes Seeding across subsequent pumps
    await libraryRow.locator('button[aria-label^="Start"]').click()
    await expect(libraryRow.locator('.badge')).toHaveText('Seeding', { timeout: 30_000 })
    await seeder.page.waitForTimeout(2_000)
    await expect(libraryRow.locator('.badge')).toHaveText('Seeding')
    expect((await rowOf(seeder.page, infoHash))?.paused).toBe(false)

    expect(seeder.errors).toEqual([])
    expect((await seen(seeder.page)).fatal).toEqual([])
  } finally {
    await seeder.page.context().close()
  }
})
