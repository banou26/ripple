/*
 * The VPN off, end to end, with nothing leaving this machine: two browsers of this build, each with the VPN
 * off, find each other through a WebSocket tracker on loopback and move a file over WebRTC. One made the torrent
 * from a folder and seeds it; the other has only its magnet, so the metadata arrives over WebRTC too.
 *
 * The torrent names the tracker by a name the browser is told to find on loopback: the engine opens no tracker
 * on the person's own machine or network, and every other name resolves to nothing, so the two default trackers,
 * the STUN host and FKN's own hosts are all out of reach. A granted microphone is what makes Chrome hand a page
 * its real address in place of an mDNS name, which nothing here could resolve.
 */
import type { BrowserContext, Page } from '@playwright/test'

import { expect, test } from '@playwright/test'

import { WEBRTC_PEERS } from '../src/torrent/vpn-config'
import { startTracker } from './vpn-off/tracker.mjs'

// the one constant that stops WebRTC peers leaves the VPN on in every page, and nothing here to drive
test.skip(!WEBRTC_PEERS, 'WebRTC peers are stopped in this build')

test.use({
  launchOptions: {
    executablePath: process.env.RIPPLE_CHROME || undefined,
    args: ['--mute-audio', '--host-resolver-rules=MAP ripple-tracker.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
  },
})

type Row = { infoHash: string, progress: number, state: number | null, numPeers: number, upload: number, noPeersSince?: number }
type Seen = { transports: string[], rows: Row[], fatal: string[], made: number, engines: number }

const FILE = { name: 'film.mkv', bytes: 6_000_000 }
const PIECE = 64 * 1024

/** Runs in the page before anything: the VPN choice, a file to make a torrent from, and what the engine says. */
const install = ({ file, vpn }: { file: typeof FILE, vpn: 'on' | 'off' }) => {
  const w = window as any
  const seen: Seen = w.__seen = { transports: [], rows: [], fatal: [], made: 0, engines: 0 }
  try {
    localStorage.setItem('ripple:demo-seeded', '1')
    if (vpn === 'off') localStorage.setItem('ripple:vpn', 'off')
  } catch { /* a page with no storage shows nothing either */ }

  const hear = (data: any) => {
    if (data?.type === 'fatal' || data?.type === 'worker-error') seen.fatal.push(String(data.message ?? data.args))
    if (data?.type !== 'state') return
    if (seen.transports.at(-1) !== data.transport) seen.transports.push(data.transport)
    seen.rows = (data.torrents ?? []).map((t: any): Row => ({
      infoHash: /btih:([0-9a-f]{40})/i.exec(t.magnet)?.[1]?.toLowerCase() ?? '',
      progress: t.status?.progress ?? 0,
      state: t.status?.state ?? null,
      numPeers: t.status?.numPeers ?? 0,
      upload: t.status?.allTimeUpload ?? 0,
      noPeersSince: t.noPeersSince,
    }))
  }
  // a tab that runs the engine hears its worker, and one that borrows it hears the tab that does
  const Original = window.Worker
  window.Worker = class extends Original {
    constructor (url: string | URL, options?: WorkerOptions) {
      super(url, options)
      // the player's and the thumbnails' workers are not engines
      if (!/\/assets\/worker-/.test(String(url))) return
      seen.engines++
      this.addEventListener('message', ({ data }: MessageEvent) => hear(data))
    }
  }
  new BroadcastChannel('ripple:torrent').addEventListener('message', ({ data }) => { if (data?.to === 'all' && !seen.engines) hear(data.msg) })

  const Native = window.RTCPeerConnection
  window.RTCPeerConnection = class extends Native {
    constructor (configuration?: RTCConfiguration) { super(configuration); seen.made++ }
  }

  // not one byte repeated: every piece has its own hash, so a piece put in the wrong place fails
  w.showDirectoryPicker = async () => {
    const bytes = new Uint8Array(file.bytes)
    for (let i = 0, x = 0x9e3779b9; i < bytes.length; i++) { x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + i | 0; bytes[i] = x >>> 24 }
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('ripple-vpn-off', { create: true })
    const handle = await dir.getFileHandle(file.name, { create: true })
    const writable = await (handle as any).createWritable()
    await writable.write(bytes)
    await writable.close()
    return dir
  }
}

const seen = (page: Page) => page.evaluate(() => (window as any).__seen as Seen)
const engines = (page: Page) => page.workers().filter((worker) => /\/assets\/worker-/.test(worker.url()))
const row = async (page: Page, infoHash: string) => (await seen(page)).rows.find((r) => r.infoHash === infoHash)

/** A browser of its own, with its own storage and so its own engine. */
const visitor = async (context: BrowserContext, origin: string, vpn: 'on' | 'off' = 'off') => {
  await context.grantPermissions(['microphone'], { origin })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  // the engine's wasm says so on the console when it aborts
  page.on('console', (message) => { if (/Aborted\(|RuntimeError/.test(message.text())) errors.push(message.text()) })
  await page.addInitScript(install, { file: FILE, vpn })
  await page.goto('/')
  return { page, errors }
}

/** Makes the torrent from the page's folder, naming `tracker` alone, and waits until the engine seeds it. */
const seed = async (page: Page, tracker: string) => {
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  await page.getByRole('button', { name: 'Choose a folder', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Piece size')).toBeVisible({ timeout: 30_000 })
  await dialog.getByLabel('Piece size').selectOption(String(PIECE))
  await dialog.getByLabel('Trackers, one per line').fill(tracker)
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.getByText('is being shared')).toBeVisible({ timeout: 120_000 })
  const infoHash = (await dialog.locator('code').first().textContent())!
  expect(infoHash).toMatch(/^[0-9a-f]{40}$/)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect.poll(async () => (await row(page, infoHash))?.state, { timeout: 60_000, message: 'the engine never seeded what it made' }).toBe(5)
  return infoHash
}

const add = async (page: Page, magnet: string) => {
  await page.getByPlaceholder('Add a magnet link').fill(magnet)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
}

let tracker: Awaited<ReturnType<typeof startTracker>>
test.beforeEach(async () => { tracker = await startTracker() })
test.afterEach(async () => { await tracker.close() })

test('two browsers with the VPN off move a file between them over WebRTC, found through a tracker', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const url = `ws://ripple-tracker.test:${tracker.port}`
  const seeder = await visitor(await browser.newContext(), baseURL!)
  const infoHash = await seed(seeder.page, url)
  expect((await seen(seeder.page)).transports).toEqual(['direct'])
  await expect.poll(() => tracker.peers(), { timeout: 30_000, message: 'the seeder never announced' }).toBe(1)
  expect((await seen(seeder.page)).made, 'a swarm with nobody in it costs no connection').toBe(0)

  const leecher = await visitor(await browser.newContext(), baseURL!)
  await add(leecher.page, `magnet:?xt=urn:btih:${infoHash}&tr=${encodeURIComponent(url)}`)

  await expect
    .poll(async () => (await row(leecher.page, infoHash))?.progress, { timeout: 120_000, message: 'the file never arrived' })
    .toBe(1)
  // every piece passed its hash in the engine, or the progress would be short of 1
  const got = (await row(leecher.page, infoHash))!
  expect(got.state === 4 || got.state === 5, `state ${got.state}`).toBe(true)
  expect((await seen(leecher.page)).transports).toEqual(['direct'])
  // the bytes came from the seeder, through a connection the tracker introduced and each page made itself
  await expect.poll(async () => (await row(seeder.page, infoHash))!.upload, { timeout: 15_000 }).toBeGreaterThanOrEqual(FILE.bytes)
  expect(tracker.seen.offers).toBeGreaterThan(0)
  expect(tracker.seen.answers).toBeGreaterThan(0)
  expect((await seen(seeder.page)).made).toBeGreaterThan(0)
  expect((await seen(leecher.page)).made).toBeGreaterThan(0)

  for (const { page, errors } of [seeder, leecher]) {
    expect(errors).toEqual([])
    expect((await seen(page)).fatal).toEqual([])
  }
})

// THE CONTROL: the same visit with no seeder moves nothing, makes no connection, and says so
test('with nobody to find, no connection is made and the torrent says since when it has had nobody', async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const url = `ws://ripple-tracker.test:${tracker.port}`
  const infoHash = 'c'.repeat(40)
  const alone = await visitor(await browser.newContext(), baseURL!)
  await add(alone.page, `magnet:?xt=urn:btih:${infoHash}&tr=${encodeURIComponent(url)}`)
  // and one that names no tracker, so it has the two default ones alone, which nothing here reaches
  await add(alone.page, `magnet:?xt=urn:btih:${'e'.repeat(40)}`)

  await expect.poll(() => tracker.peers(), { timeout: 30_000, message: 'the tracker was never asked' }).toBe(1)
  await expect.poll(async () => (await row(alone.page, infoHash))?.noPeersSince, { timeout: 30_000 }).toBeGreaterThan(0)
  await alone.page.waitForTimeout(5_000)
  const after = (await row(alone.page, infoHash))!
  expect({ progress: after.progress, numPeers: after.numPeers }).toEqual({ progress: 0, numPeers: 0 })
  expect(tracker.seen.offers).toBe(0)
  expect((await seen(alone.page)).made).toBe(0)
  expect((await seen(alone.page)).transports).toEqual(['direct'])

  // the strip says Off as the choice it is, and nothing of a relay port, since there is none to dial in through
  const strip = alone.page.locator('.stats .readouts')
  await expect(strip.locator('.stat.vpn strong')).toHaveText('Off')
  await expect(strip.locator('.stat.vpn')).not.toHaveClass(/error/)
  await expect(strip.locator('.stat', { hasText: 'Inbound' })).toHaveCount(0)
})

// THE CONTROL of the strip above: the same page with the VPN on, and a relay this machine cannot reach
test('with the VPN on and no relay in reach, the strip says so and keeps its inbound readout', async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const relayed = await visitor(await browser.newContext(), baseURL!, 'on')
  await add(relayed.page, `magnet:?xt=urn:btih:${'d'.repeat(40)}`)
  const strip = relayed.page.locator('.stats .readouts')
  await expect(strip.locator('.stat', { hasText: 'Inbound' })).toHaveCount(1, { timeout: 60_000 })
  await expect(strip.locator('.stat.vpn strong')).not.toHaveText('Off')
  await expect(strip.locator('.stat.vpn')).toHaveClass(/error/)
  expect((await seen(relayed.page)).transports).toEqual(['relay'])
  expect(tracker.seen.announces, 'an engine behind the relay opened a tracker from the browser').toBe(0)
})

/*
 * The switch itself, as it reaches an engine: the stored choice changes 20 times in a row, from a tab that only
 * borrows the engine, while the engine's tab downloads from the seeder, held to a speed that leaves most of the
 * file to come. Each change the engine's tab catches replaces its worker, so engines are ended while they start,
 * restore the torrent, announce and connect. The last change leaves the VPN off, and the rest of the file arrives.
 */
test('20 changes of the VPN in a row from another tab, while peers connect, leave one engine and the torrent', async ({ browser, baseURL }) => {
  test.setTimeout(300_000)
  const url = `ws://ripple-tracker.test:${tracker.port}`
  const seeder = await visitor(await browser.newContext(), baseURL!)
  const infoHash = await seed(seeder.page, url)

  const context = await browser.newContext()
  const engine = await visitor(context, baseURL!)
  await expect.poll(async () => (await seen(engine.page)).transports, { timeout: 60_000 }).toEqual(['direct'])
  const borrower = await visitor(context, baseURL!)
  await expect.poll(async () => (await seen(borrower.page)).transports, { timeout: 60_000, message: 'the second tab never heard the engine' }).toEqual(['direct'])
  expect(engines(borrower.page), 'the second tab started an engine of its own').toHaveLength(0)

  // 150 kB/s: the 6 MB take 40 s, and the engine keeps the limit for every engine after it
  await engine.page.locator('footer .controls button:has-text("down")').click()
  const limit = engine.page.getByRole('dialog')
  await limit.getByRole('checkbox').uncheck()
  await limit.getByRole('spinbutton').fill('150')
  await limit.getByRole('button', { name: /Limit to/ }).click()
  await expect(engine.page.locator('footer .controls button:has-text("down")')).toHaveText('150 kB/s down')

  await add(engine.page, `magnet:?xt=urn:btih:${infoHash}&tr=${encodeURIComponent(url)}`)
  await expect.poll(async () => (await row(engine.page, infoHash))?.progress, { timeout: 60_000, message: 'nothing arrived before the changes' }).toBeGreaterThan(0)
  // the page holds every engine change for 12 s after an add, as it holds an update: the engine stores the torrent then
  await expect
    .poll(() => engine.page.evaluate(async () => (await navigator.locks.query()).held?.some((lock) => lock.name === 'ripple:page-work')), { timeout: 30_000 })
    .toBe(false)
  const before = (await row(engine.page, infoHash))!.progress
  expect(before, 'the file was already here, so nothing was connecting during the changes').toBeLessThan(0.6)

  // some within a step of the engine's tab, some long enough for an engine to announce and be answered
  const gaps = [0, 50, 150, 400, 900, 30, 250, 1_500, 80, 600]
  for (let i = 0; i < 20; i++) {
    await borrower.page.evaluate((off) => {
      if (off) localStorage.setItem('ripple:vpn', 'off')
      else localStorage.removeItem('ripple:vpn')
    }, i % 2 === 1)
    await borrower.page.waitForTimeout(gaps[i % gaps.length]!)
  }

  await expect
    .poll(async () => (await row(engine.page, infoHash))?.progress, { timeout: 180_000, message: 'the file never arrived after the changes' })
    .toBe(1)
  for (const { page, errors } of [engine, borrower]) {
    const told = await seen(page)
    expect(told.transports.at(-1), 'the last change turned the VPN off').toBe('direct')
    expect(told.rows.map((r) => r.infoHash), 'the torrent is gone from a tab').toEqual([infoHash])
    await expect(page.locator('.torrent')).toHaveCount(1)
    expect(told.fatal).toEqual([])
    expect(errors).toEqual([])
  }
  const started = (await seen(engine.page)).engines
  console.log(`[vpn-off] 20 changes started ${started} engines in the engine's tab`)
  expect(started, 'the changes were all folded into one, so no engine was replaced while it started').toBeGreaterThan(4)
  expect((await seen(borrower.page)).engines, 'the tab that borrows the engine started one').toBe(0)
  expect([...engines(engine.page), ...engines(borrower.page)], 'an engine worker was left behind').toHaveLength(1)
  expect((await seen(seeder.page)).fatal).toEqual([])
})
