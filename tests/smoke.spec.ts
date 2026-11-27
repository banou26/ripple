// Checks in a real browser what this project cannot typecheck: the module worker loads and the libtorrent session reaches a definite state

import type { Browser, Locator, Page } from '@playwright/test'
import type { AddressInfo } from 'node:net'

import { readFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { join } from 'node:path'

import { expect, test } from './offline'

import { addSample } from './sample-offer'
import { embedPath } from '../src/router/embed-link'
import { decodeMagnetParam, encodeMagnetParam } from '../src/router/magnet-codec'
import { linkParams } from '../src/router/path'

const probeEngine = () => {
  const w = window as any
  w.__engine = new Promise<string>((resolve) => {
    const OriginalWorker = window.Worker
    class Probe extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as { type?: string, list?: unknown, torrents?: unknown } | null
          if (data?.type === 'ready' || data?.type === 'storage-unavailable') resolve(data.type)
          if (data?.type === 'ready') w.__worker = this
          if (data?.type === 'list') w.__list = data.list
          if (data?.type === 'state') w.__state = data.torrents
        })
      }
    }
    window.Worker = Probe
  })
}

const engineReady = async (page: Page) =>
  expect(await page.evaluate(() => (window as any).__engine as Promise<string>)).toBe('ready')

/**
 * Waits for libtorrent's queue to start a torrent, and for the page to draw it. Needs `probeEngine`. A magnet's first
 * state carries no status and its row reads Downloading; the next is paused until the queue starts it, and its row reads
 * Queued.
 */
const queueStarted = async (page: Page) => {
  await page.waitForFunction(() => ((window as any).__state ?? []).some((t: any) => t.status && !t.status.paused), undefined, { timeout: 30_000 })
  // seen as the message arrives, before the page renders it and its effects run
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

/** A message to the engine worker, as the page's client sends it. Needs `probeEngine` and `engineReady`. */
const tell = (page: Page, message: object) => page.evaluate((m) => (window as any).__worker.postMessage(m), message)

/**
 * The hashes in the engine's list once it names `hash`. The worker runs commands one at a time, so that list comes
 * after every command sent before the one that added `hash`.
 */
const listedWith = async (page: Page, hash: string) => (await page.waitForFunction((h) => {
  const hashes = ((window as any).__list ?? []).map((e: { infoHash: string }) => e.infoHash) as string[]
  return hashes.includes(h) && hashes
}, hash, { timeout: 30_000 })).jsonValue()

// past DEMO_GRACE (8 s), the longest the offer waits on a cloud restore before it is decided
const DECIDED = 10_000

// no trackers and an infohash nobody seeds, so nothing ever answers and no data moves
const NOBODY = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Own`

const removeRow = async (page: Page, row: Locator) => {
  await row.getByRole('button', { name: /^Options for / }).click()
  await page.getByRole('button', { name: /^Remove and delete the files/ }).click()
  await page.getByRole('button', { name: 'Remove and delete', exact: true }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)
}

const seeded = (page: Page) => page.evaluate(() => localStorage.getItem('ripple:demo-seeded'))

test('the library boots, the engine reports in, and a first run offers the sample instead of adding it', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.addInitScript(probeEngine)

  await page.goto('/')

  await expect(page.getByText('Ripple is open in another tab.')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Ripple', exact: true })).toBeVisible()
  await engineReady(page)

  // nothing is added until somebody asks: a first run used to add Sintel by itself, 3 to 6 s in
  const offer = page.getByRole('button', { name: 'Add Sintel' })
  await expect(offer).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(DECIDED)
  await expect(page.locator('.torrent')).toHaveCount(0)
  await expect(offer).toBeVisible()

  const row = await addSample(page)
  await expect(offer).toHaveCount(0)
  // started, because somebody asked for it, and temporary, so it stays out of the synced library
  await expect(row.locator('.badge')).not.toHaveText('Paused')
  await expect(row.locator('.temp')).toBeVisible()

  await page.getByPlaceholder('Add a magnet link').fill(
    'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel',
  )
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  /*
   * `.first()`, because a second status can be on screen and it is not this one.
   *
   * The page renders a storage warning as a `status` when the origin is low on room, which never
   * happens on a roomy dev machine and happens on a CI runner, so the bare role matched two elements
   * and failed strict mode. The assertion is about the add's answer, so it names it.
   */
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' }).first())
    .toBeVisible()
  await expect(page.locator('.torrent')).toHaveCount(1)

  await row.getByRole('button', { name: 'Pause' }).click()
  await expect(row.locator('.badge')).toHaveText('Paused')
  // and it STAYS stopped: a pause that quietly lifts itself is the failure this has always watched for
  await page.waitForTimeout(7_000)
  await expect(row.locator('.badge')).toHaveText('Paused')

  await row.getByRole('button', { name: 'Resume' }).click()
  await expect(row.locator('.badge')).not.toHaveText('Paused')
  await expect(row.locator('.badge')).not.toHaveText('Retrying')

  // the sample is temporary, so it is the press that answered the offer, not its row
  await removeRow(page, row)
  await page.waitForTimeout(2_000)
  await expect(offer).toHaveCount(0)

  await page.reload()
  await engineReady(page)
  await page.waitForTimeout(DECIDED)
  await expect(page.locator('main .empty h1')).toBeVisible()
  await expect(offer).toHaveCount(0)

  expect(pageErrors).toEqual([])
})

test('No thanks answers the offer for good in this browser', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.addInitScript(probeEngine)

  await page.goto('/')
  await engineReady(page)
  await page.getByRole('button', { name: 'No thanks' }).click({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Add Sintel' })).toHaveCount(0)

  await page.reload()
  await engineReady(page)
  await page.waitForTimeout(DECIDED)
  await expect(page.locator('main .empty h1')).toBeVisible()
  await expect(page.getByRole('button', { name: /Add Sintel|No thanks/ })).toHaveCount(0)
  await expect(page.locator('.torrent')).toHaveCount(0)

  expect(pageErrors).toEqual([])
})

test('a torrent of one\'s own answers the offer too, and removing it does not bring it back', async ({ page }) => {
  await page.goto('/')
  const offer = page.getByRole('button', { name: 'Add Sintel' })
  await expect(offer).toBeVisible({ timeout: 20_000 })

  await page.getByPlaceholder('Add a magnet link').fill(NOBODY)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const row = page.locator('.torrent').first()
  await expect(row.locator('.title strong')).toHaveText('Own', { timeout: 30_000 })
  await expect(offer).toHaveCount(0)
  // their own add, not the sample: a deliberate add is never temporary
  await expect(row.locator('.temp')).toHaveCount(0)
  // polled: the row draws from the engine's state, a moment before the library list that sets the flag
  await expect.poll(() => seeded(page)).toBe('1')

  await removeRow(page, row)
  await page.waitForTimeout(2_000)
  await expect(offer).toHaveCount(0)
})

test('closing the tab asks first while a torrent of one\'s own downloads, and not once it is paused', async ({ page, browserName }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await page.getByPlaceholder('Add a magnet link').fill(NOBODY)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const row = page.locator('.torrent').first()
  await expect(row.locator('.badge')).toHaveText('Downloading', { timeout: 30_000 })
  // the page's listener comes 46 to 167 ms after the state that draws the row, so a close at once can find none
  await queueStarted(page)

  const asked: string[] = []
  page.on('dialog', (dialog) => { asked.push(dialog.type()); void dialog.dismiss() })
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => asked).toEqual(['beforeunload'])
  expect(page.isClosed(), 'the prompt was turned down, so the tab stays').toBe(false)

  await row.getByRole('button', { name: 'Pause Own', exact: true }).click()
  await expect(row.locator('.badge')).toHaveText('Paused')
  if (browserName === 'webkit') {
    // Playwright WebKit leaves page.isClosed() false on a second close({ runBeforeUnload: true })
    // after a dismissed beforeunload dialog even when no listener remains; navigating proves it is gone.
    await page.goto('about:blank')
    expect(page.url()).toBe('about:blank')
  } else {
    await page.close({ runBeforeUnload: true })
    await expect.poll(() => page.isClosed()).toBe(true)
  }
  expect(asked).toEqual(['beforeunload'])
})

test('closing the tab asks from another of its pages too, which the engine goes on downloading behind', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await page.getByPlaceholder('Add a magnet link').fill(NOBODY)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.torrent .badge')).toHaveText('Downloading', { timeout: 30_000 })
  await queueStarted(page)
  await page.getByRole('link', { name: 'Privacy', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible()
  // a frame or two for the library page's effects to end, as they do once it is gone
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  const asked: string[] = []
  page.on('dialog', (dialog) => { asked.push(dialog.type()); void dialog.dismiss() })
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => asked).toEqual(['beforeunload'])
})

/** The card of the torrent named `name`. */
const card = (page: Page, name: string) => page.locator('.torrent').filter({ has: page.locator('.title strong', { hasText: new RegExp(`^${name}$`) }) })

/** The engine's last status for the torrent of `hash`, as the page last heard it. Needs `probeEngine`. */
const statusOf = (page: Page, hash: string) =>
  page.evaluate((h) => ((window as any).__state ?? []).find((t: any) => t.magnet.includes(h))?.status ?? null, hash)

/**
 * Adds a magnet named after each of `names`, nobody answering any of them. libtorrent's queue runs three downloads and
 * holds the rest for their first minute, so from the fourth on each reads Queued until then.
 */
const addHeld = async (page: Page, names: readonly string[]) => {
  const field = page.getByPlaceholder('Add a magnet link')
  for (const [i, name] of names.entries()) {
    const magnet = `magnet:?xt=urn:btih:${String(i + 1).repeat(40)}&dn=${name}`
    await field.fill(magnet)
    await expect(field).toHaveValue(magnet)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(field).toHaveValue('')
  }
  for (const name of names.slice(3)) await expect(card(page, name).locator('.badge')).toHaveText('Queued', { timeout: 30_000 })
  return (name: string) => String(names.indexOf(name) + 1).repeat(40)
}

test('a press aimed at a new torrent\'s Pause pauses it, though the queue holds it as the press lands', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  // fill libtorrent's three active download slots so the next torrent is deterministically held in Queued
  for (const [i, name] of ['One', 'Two', 'Three'].entries()) {
    await page.getByPlaceholder('Add a magnet link').fill(`magnet:?xt=urn:btih:${String(i + 1).repeat(40)}&dn=${name}`)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(card(page, name).locator('.badge')).toHaveText('Downloading', { timeout: 30_000 })
  }
  const ownHash = 'a'.repeat(40)
  await page.getByPlaceholder('Add a magnet link').fill(NOBODY)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const row = card(page, 'Own')
  // where the Pause icon first shows, before the engine has reported on the magnet
  const at = await row.getByRole('button', { name: 'Pause Own', exact: true }).boundingBox({ timeout: 30_000 })
  if (!at) throw new Error('missing Pause button boundingBox')
  await page.waitForFunction(
    (hash) => ((window as any).__state ?? []).some((t: any) => t.magnet?.includes(hash) && t.status?.paused && t.status.autoManaged),
    ownHash,
    { timeout: 30_000 },
  )
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await row.locator('.badge').textContent(), 'the press lands while the queue holds it').toBe('Queued')
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
  await expect(row.locator('.badge')).toHaveText('Paused')
  await page.waitForTimeout(3_000)
  await expect(row.locator('.badge')).toHaveText('Paused')
})

test('a torrent the queue holds offers Pause, which keeps it out of the queue across a reload until Resume hands it back', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  const hashOf = await addHeld(page, ['One', 'Two', 'Three', 'Four', 'Five'])

  // a few seconds, not the default wait: a Pause the hold left out would show once the queue starts the torrent
  await card(page, 'Four').getByRole('button', { name: 'Pause Four', exact: true }).click({ timeout: 5_000 })
  await expect(card(page, 'Four').locator('.badge')).toHaveText('Paused')
  // a slot freed, which the queue fills with the torrent it still holds and not with the one paused
  await card(page, 'One').getByRole('button', { name: 'Pause One', exact: true }).click()
  await expect(card(page, 'Five').locator('.badge')).toHaveText('Downloading', { timeout: 15_000 })
  await expect(card(page, 'Four').locator('.badge')).toHaveText('Paused')

  await page.reload()
  await engineReady(page)
  for (const name of ['Two', 'Three', 'Five']) await expect(card(page, name).locator('.badge')).toHaveText('Downloading', { timeout: 30_000 })
  await expect(card(page, 'Four').locator('.badge')).toHaveText('Paused')
  await expect.poll(() => statusOf(page, hashOf('Four'))).toMatchObject({ paused: true, autoManaged: false })

  // back under the queue, which starts it or holds it
  await card(page, 'Four').getByRole('button', { name: 'Resume Four', exact: true }).click()
  await expect(card(page, 'Four').locator('.badge')).toHaveText(/^(Queued|Downloading)$/)
  await expect(card(page, 'Four').getByRole('button', { name: 'Pause Four', exact: true })).toBeVisible()
  await expect.poll(() => statusOf(page, hashOf('Four'))).toMatchObject({ autoManaged: true })
})

test('the options and the bar pause a torrent the queue holds', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  await addHeld(page, ['One', 'Two', 'Three', 'Four', 'Five'])

  await card(page, 'Four').getByRole('button', { name: 'Options for Four' }).click()
  const options = page.getByRole('dialog')
  await expect(options.getByRole('switch', { name: 'Force start' })).toBeVisible()
  await options.getByRole('button', { name: 'Pause', exact: true }).click({ timeout: 5_000 })
  await expect(card(page, 'Four').locator('.badge')).toHaveText('Paused')

  await page.getByRole('checkbox', { name: 'Select Three' }).check()
  await page.getByRole('checkbox', { name: 'Select Five' }).check()
  expect(await card(page, 'Five').locator('.badge').textContent(), 'still held as the bar is pressed').toBe('Queued')
  await page.locator('.bulk-bar').getByRole('button', { name: 'Pause' }).click()
  for (const name of ['Three', 'Five']) await expect(card(page, name).locator('.badge')).toHaveText('Paused')
})

const TRACKER = 'https://tracker.invalid/announce'

/** A one-file .torrent named `name`, whose tracker no name resolves to. */
const torrentFile = (name: string) => ({
  name: `${name}.torrent`,
  mimeType: 'application/x-bittorrent',
  buffer: Buffer.from(`d8:announce${TRACKER.length}:${TRACKER}4:infod6:lengthi11e4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:${'p'.repeat(20)}ee`),
})

// a .torrent's row knows its files before the engine's first status, on its add and on every reload
test('a press aimed at a reloaded torrent\'s Pause pauses it, though the engine has not reported on it yet', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  await page.locator('label.file-button input[type=file]').first().setInputFiles([torrentFile('Pack')])
  const row = card(page, 'Pack')
  await expect(row.locator('.badge')).toHaveText('Downloading', { timeout: 30_000 })

  await page.reload()
  await page.waitForFunction(() => ((window as any).__state ?? []).some((t: any) => t.files && !t.status), undefined, { timeout: 30_000, polling: 'raf' })
  const at = (await row.getByRole('button', { name: /^(Pause|Resume) Pack$/ }).boundingBox())!
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await row.locator('.badge').textContent(), 'the press lands before the engine reports').toBe('Queued')
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
  await expect(row.locator('.badge')).toHaveText('Paused')
  await page.waitForTimeout(3_000)
  await expect(row.locator('.badge')).toHaveText('Paused')
})

/** Every badge the first row shows, in order, from the page's first frame. */
const badges = () => {
  const w = window as any
  w.__badges = []
  const look = () => {
    const now = document.querySelector('.torrent .badge')?.textContent
    if (now && now !== w.__badges.at(-1)) w.__badges.push(now)
    requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
}

test('a Pause the engine gets while it reads a new .torrent\'s infohash outlasts a reload, and reads Paused throughout it', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  await page.addInitScript(probeEngine)
  await page.addInitScript(badges)
  await page.goto('/')
  await engineReady(page)
  // a .torrent's handle is reported before its infohash is read, and its magnet, which needs that hash, is still empty
  await page.evaluate(() => {
    const w = window as any
    const first = (event: MessageEvent) => {
      const t = event.data?.type === 'state' && event.data.torrents.find((s: { magnet: string }) => !s.magnet)
      if (!t) return
      w.__worker.removeEventListener('message', first)
      w.__listedAtPause = (w.__list ?? []).length
      w.__worker.postMessage({ type: 'pause', handle: t.handle })
    }
    w.__worker.addEventListener('message', first)
  })
  await page.locator('label.file-button input[type=file]').first().setInputFiles([torrentFile('Early')])
  await expect(card(page, 'Early').locator('.badge')).toHaveText('Paused', { timeout: 30_000 })
  expect(await page.evaluate(() => (window as any).__listedAtPause), 'paused before the engine listed it').toBe(0)

  await page.reload()
  await expect(card(page, 'Early').locator('.badge')).toHaveText('Paused', { timeout: 30_000 })
  await page.waitForTimeout(3_000)
  await expect(card(page, 'Early').locator('.badge')).toHaveText('Paused')
  // not Downloading or Queued before the engine's first status, whose row would offer the wrong control
  expect((await page.evaluate(() => (window as any).__badges as string[])).filter((badge) => badge !== 'Starting')).toEqual(['Paused'])
})

// the page's worker, whose update another tab takes when the test calls updateTaken; the new one never answers, so the
// page reloads once its wait for it runs out
const updateStandIn = () => {
  const heard = new Set<EventListener>()
  const registration = { waiting: null as object | null, addEventListener () {}, update: async () => {} }
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      controller: {},
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
      register: async () => registration,
      addEventListener: (type: string, listener: EventListener) => { if (type === 'controllerchange') heard.add(listener) },
      removeEventListener: (_: string, listener: EventListener) => { heard.delete(listener) },
    },
  })
  Object.assign(window, {
    updateTaken: () => {
      registration.waiting = { postMessage () {} }
      for (const listener of heard) listener(new Event('controllerchange'))
    },
  })
}

test('Ripple reloads itself onto an update while a torrent downloads, with nothing asked', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  await page.addInitScript(updateStandIn)
  await page.goto('/')
  await page.getByPlaceholder('Add a magnet link').fill(NOBODY)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.torrent .badge')).toHaveText('Downloading', { timeout: 30_000 })

  const asked: string[] = []
  page.on('dialog', (dialog) => { asked.push(dialog.type()); void dialog.dismiss() })
  // the add holds the update for ENGINE_STORE_MS (12 s), and the gate then waits 5 s on the new worker
  const reloaded = page.waitForEvent('load', { timeout: 45_000 })
  await page.evaluate(() => (window as unknown as { updateTaken: () => void }).updateTaken())
  await expect(page.getByRole('status').filter({ hasText: 'Updating Ripple' })).toBeVisible({ timeout: 30_000 })
  await reloaded
  expect(asked).toEqual([])
})

test('a link turned down leaves the offer standing', async ({ page }) => {
  await page.goto(`/add?magnet=${encodeURIComponent(NOBODY)}`)
  // listed as temporary while its dialog asks, which is not an answer to the offer
  await expect(page.locator('.torrent .temp')).toHaveCount(1, { timeout: 30_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)

  await expect(page.getByRole('button', { name: 'Add Sintel' })).toBeVisible({ timeout: 20_000 })
  expect(await seeded(page)).toBeNull()
})

test('a link\'s name for a magnet with none is what its dialog and its row show', async ({ page }) => {
  await page.goto(`/add?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${'c'.repeat(40)}`)}&name=${encodeURIComponent('Given by the link')}`)
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Given by the link', { timeout: 30_000 })
  await expect(page.locator('.torrent .title strong')).toHaveText('Given by the link', { timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)
})

/** A paste, or a drag carrying `magnet` and then its drop, handed to the page the way the browser hands them over. */
const handOver = (page: Page, gesture: 'paste' | 'drag' | 'drop', magnet: string) => page.evaluate(([gesture, magnet]) => {
  const data = new DataTransfer()
  data.setData('text/plain', magnet)
  data.setData('text/uri-list', magnet)
  document.body.dispatchEvent(gesture === 'paste'
    ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true })
    : new DragEvent(gesture === 'drag' ? 'dragenter' : 'drop', { dataTransfer: data, bubbles: true, cancelable: true }))
}, [gesture, magnet] as const)

test('a paste or a drop while the add dialog asks leaves the torrent it asks about', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  const dialog = page.getByRole('dialog')
  const OTHER = `magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=Other`

  await handOver(page, 'paste', NOBODY)
  await expect(dialog.locator('h2')).toHaveText('Own')
  await expect(page.locator('.torrent')).toHaveCount(1, { timeout: 30_000 })

  await handOver(page, 'paste', OTHER)
  await handOver(page, 'drag', OTHER)
  await expect(page.locator('[data-drag]')).toHaveCount(0)
  await handOver(page, 'drop', OTHER)
  await expect(dialog.locator('h2')).toHaveText('Own')
  await expect(page.locator('.torrent')).toHaveCount(1)

  // the control: the same drag and drop with no dialog open is an add
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)
  await handOver(page, 'drag', OTHER)
  await expect(page.locator('[data-drag]')).toHaveCount(1)
  await handOver(page, 'drop', OTHER)
  await expect(dialog.locator('h2')).toHaveText('Other')
})

test('Cancel takes back the torrent the add dialog asked about from the moment it is listed', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)

  await handOver(page, 'paste', NOBODY)
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Own')
  // at once: the library lists an add up to one engine state (500 ms) before the engine's state carries it
  await page.waitForFunction(() => document.querySelectorAll('.torrent').length === 1, null, { polling: 'raf' })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.torrent')).toHaveCount(0)
})

test('Cancel leaves a torrent of their own that a link asked about', async ({ page }) => {
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  // their own torrent with its files on another device, the one kind of theirs a link still asks about
  const mine = 'e'.repeat(40)
  const magnet = `magnet:?xt=urn:btih:${mine}&dn=Mine`
  await tell(page, { type: 'import-list', list: [{ infoHash: mine, magnet, savePath: `/dl/${mine}`, addedAt: 1_000 }], removed: [] })
  await expect(page.locator('.torrent')).toHaveCount(1)
  await page.evaluate((magnet) => {
    history.pushState(null, '', '/?add=' + encodeURIComponent(magnet))
    dispatchEvent(new PopStateEvent('popstate'))
  }, magnet)
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Mine')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await tell(page, { type: 'add-magnet', magnet: NOBODY })
  expect(await listedWith(page, 'a'.repeat(40))).toContain(mine)
})

test('Cancel on a .torrent leaves that torrent when something else opened it meanwhile', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  await page.locator('label.file-button input[type=file]').first().setInputFiles(join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent'))
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Sintel')
  // a stream, say: Temporary, and not the dialog's, which sends a .torrent to the engine only on Add
  const sintel = '08ada5a7a6183aae1e09d831df6748d566095a10'
  await tell(page, { type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${sintel}`, ephemeral: true })
  await expect(page.locator('.torrent .temp')).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await tell(page, { type: 'add-magnet', magnet: NOBODY })
  expect(await listedWith(page, 'a'.repeat(40))).toContain(sintel)
})

test('a magnet that names two torrents is refused rather than listed as one of them', async ({ page }) => {
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)

  await page.getByPlaceholder('Add a magnet link').fill(`magnet:?xt=urn:btih:${'1a'.repeat(20)}&xt.1=urn:btih:${'2b'.repeat(20)}&dn=Two`)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'That is not a valid magnet link' }).first()).toBeVisible()
  await expect(page.locator('.torrent')).toHaveCount(0)
})

test('a torrent in the list is known by its hash in base32 too, typed or sent by a link', async ({ page }) => {
  await page.goto('/')
  const field = page.getByPlaceholder('Add a magnet link')
  await field.fill(NOBODY)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.torrent .title strong')).toHaveText('Own', { timeout: 30_000 })

  // NOBODY's hash, in base32
  const again = `magnet:?xt=urn:btih:${'VK'.repeat(16)}&dn=Again`
  const known = page.getByRole('status').filter({ hasText: 'Already in your list' }).first()
  await field.fill(again)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(known).toBeVisible()
  await expect(known).toHaveCount(0)

  // the same link from another site, with the list already on screen
  await page.evaluate((magnet) => {
    history.pushState(null, '', '/?add=' + encodeURIComponent(magnet))
    dispatchEvent(new PopStateEvent('popstate'))
  }, again)
  await expect(known).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.torrent')).toHaveCount(1)

  // and a player's link back to it, which names the hash as the player's own link spells it
  await page.evaluate((hash) => {
    history.pushState(null, '', '/?torrent=' + hash)
    dispatchEvent(new PopStateEvent('popstate'))
  }, 'vk'.repeat(16))
  await expect(page.locator('.torrent.selected')).toHaveCount(1)
})

test('a link naming the sample by its base32 hash asks about the sample, with its files', async ({ page }) => {
  await page.goto('/')
  await addSample(page, { pause: true })
  await page.evaluate((magnet) => {
    history.pushState(null, '', '/?add=' + encodeURIComponent(magnet))
    dispatchEvent(new PopStateEvent('popstate'))
  }, 'magnet:?xt=urn:btih:BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ&dn=Sintel')
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add torrent' })).toBeEnabled({ timeout: 30_000 })
  await expect(page.locator('.torrent')).toHaveCount(1)
})

test('a .torrent already in the list is said to be there', async ({ page }) => {
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  const open = page.locator('label.file-button input[type=file]').first()
  const sintel = join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent')
  await open.setInputFiles(sintel)
  const row = page.locator('.torrent').first()
  await expect(row.locator('.title strong')).toHaveText('Sintel', { timeout: 30_000 })

  await open.setInputFiles(sintel)
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' }).first()).toBeVisible()
  await expect(page.locator('.torrent')).toHaveCount(1)
})

test('the same .torrent picked twice at once is listed once and said to be there', async ({ page }) => {
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  const buffer = await readFile(join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent'))
  // the page sends the copy before the engine has named the first, so only the engine can say they are one torrent
  await page.locator('label.file-button input[type=file]').first().setInputFiles([
    { name: 'sintel.torrent', mimeType: 'application/x-bittorrent', buffer },
    { name: 'sintel (1).torrent', mimeType: 'application/x-bittorrent', buffer },
  ])
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' }).first()).toBeVisible()
  await expect(page.locator('.torrent .title strong').first()).toHaveText('Sintel', { timeout: 30_000 })
  await expect(page.locator('.torrent')).toHaveCount(1)
})

test('a .torrent for a torrent listed by its base32 hash is said to be there', async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Add a magnet link').fill('magnet:?xt=urn:btih:BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ&dn=Sintel')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.torrent .title strong')).toHaveText('Sintel', { timeout: 30_000 })

  await page.locator('label.file-button input[type=file]').first().setInputFiles(join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent'))
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' }).first()).toBeVisible()
})

test('with Ask on, a .torrent added unstarted from the dialog is listed paused', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto('/')
  await page.locator('label.file-button input[type=file]').first().setInputFiles(join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent'))
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Sintel')
  await dialog.getByRole('checkbox', { name: 'Start downloading' }).uncheck()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  const row = page.locator('.torrent').first()
  await expect(row.locator('.title strong')).toHaveText('Sintel', { timeout: 30_000 })
  await expect(row.locator('.badge')).toHaveText('Paused')
})

test('a .torrent for a film the player holds promotes it into the library', async ({ page }) => {
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  const sintelHash = '08ada5a7a6183aae1e09d831df6748d566095a10'
  await tell(page, { type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${sintelHash}&dn=Sintel`, ephemeral: true })
  const row = page.locator('.torrent').first()
  await expect(row.locator('.temp')).toBeVisible({ timeout: 30_000 })

  const open = page.locator('label.file-button input[type=file]').first()
  const sintel = join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent')
  await open.setInputFiles(sintel)
  await expect(row.locator('.temp')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' })).toHaveCount(0)
  await expect(page.locator('.torrent')).toHaveCount(1)

  // once kept, adding the same .torrent again says it is already there
  await open.setInputFiles(sintel)
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' }).first()).toBeVisible()
})

test('with Ask on, a .torrent for a held film opens the dialog and honours the choices', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.addInitScript(probeEngine)
  await page.goto('/')
  await engineReady(page)
  const sintelHash = '08ada5a7a6183aae1e09d831df6748d566095a10'
  await tell(page, { type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${sintelHash}&dn=Sintel`, ephemeral: true })
  const row = page.locator('.torrent').first()
  await expect(row.locator('.temp')).toBeVisible({ timeout: 30_000 })

  const open = page.locator('label.file-button input[type=file]').first()
  await open.setInputFiles(join(import.meta.dirname, '..', 'src', 'assets', 'sintel.torrent'))
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Sintel')
  await dialog.getByRole('checkbox', { name: 'Start downloading' }).uncheck()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await expect(row.locator('.temp')).toHaveCount(0, { timeout: 15_000 })
  await expect(row.locator('.badge')).toHaveText('Paused')
  await expect(page.getByRole('status').filter({ hasText: 'Already in your list' })).toHaveCount(0)
})

// Cloudflare Pages serves the app for any path, so what an unknown one shows is the router's choice
test('an address the app does not know ends on the library', async ({ page }) => {
  // first, while no service worker is installed, so the server answers the expired save address like any other
  for (const path of ['/__ripple-stream/expired/film.mkv', '/no-such-page', '/download/film.mkv?files=all']) {
    await page.goto(path)
    await expect(page.getByRole('button', { name: 'Create a torrent' }), path).toBeVisible()
    expect(new URL(page.url()).pathname, path).toBe('/')
  }
})

test('the pages the app knows still render where they are', async ({ page }) => {
  const magnet = Buffer.from(NOBODY).toString('base64')
  const pages = [
    ['/', page.getByRole('button', { name: 'Create a torrent' })],
    ['/legal', page.getByRole('heading', { name: 'Legal & Terms' })],
    ['/privacy', page.getByRole('heading', { name: 'Privacy', exact: true })],
    [`/download?magnet=${magnet}`, page.locator('.card')],
    [`/watch?magnet=${magnet}`, page.getByTestId('open-in-ripple')],
  ] as const
  for (const [path, marker] of pages) {
    await page.goto(path)
    await expect(marker, path).toBeVisible({ timeout: 30_000 })
    expect(new URL(page.url()).pathname, path).toBe(path.split('?')[0])
  }
})

/**
 * A visit through a server in front of the app that keeps each request's line and Referer: what the host (Cloudflare) is
 * sent of it. A server and a context of its own for each visit: a cold one, with no service worker to answer for the
 * server, and no request of another visit arriving late.
 */
const recorded = async (browser: Browser, app: string, path: string, shows: (page: Page) => Locator) => {
  const seen: { url: string, referer?: string }[] = []
  const upstream = new URL(app)
  const server = createServer((asked, answer) => {
    seen.push({ url: asked.url!, referer: asked.headers.referer })
    const forward = request(new URL(asked.url!, upstream), { method: asked.method, headers: { ...asked.headers, host: upstream.host } }, (served) => {
      answer.writeHead(served.statusCode!, served.headers)
      served.pipe(answer)
    })
    forward.on('error', () => answer.destroy())
    asked.pipe(forward)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(origin + path)
    await expect(shows(page), path).toBeVisible({ timeout: 30_000 })
  } finally {
    await context.close()
    server.closeAllConnections()
    server.close()
  }
  return { origin, seen: [...seen] }
}

test('a link written now keeps its torrent from the server, and one written before still opens', async ({ browser, baseURL }) => {
  test.skip(!/^http:/.test(baseURL!), 'a deployed origin is reached as it is, with nothing in front of it')
  test.setTimeout(120_000)
  const value = encodeMagnetParam(NOBODY)!.value
  const named = (page: Page) => page.locator('.card').getByText('Own', { exact: true })
  const player = (page: Page) => page.getByTestId('open-in-ripple')
  const written = [
    [embedPath({ magnet: NOBODY, mode: 'download', indices: [0], fileCount: 2 })!, named],
    [embedPath({ magnet: NOBODY, mode: 'watch', fileIndex: 0 })!, player],
  ] as const
  for (const [path, shows] of written) {
    const { seen } = await recorded(browser, baseURL!, path, shows)
    expect(seen[0]?.url, path).toBe(path.split('#')[0])
    expect(seen.filter(({ url, referer }) => `${url} ${referer}`.includes(value)), path).toEqual([])
    expect(seen.filter(({ url }) => url.includes('files=') || url.includes('fileIndex=')), path).toEqual([])
  }

  // THE CONTROL: the server is told the query of a link written before, so it would be told a torrent written there
  const before = `/download?magnet=${encodeURIComponent(Buffer.from(NOBODY).toString('base64'))}`
  const { origin, seen } = await recorded(browser, baseURL!, before, named)
  expect(seen[0]?.url).toBe(before)
  // and nothing after it repeats it: a Referer names this origin alone
  expect(seen.slice(1).filter(({ referer }) => referer?.includes('magnet=')), 'a Referer repeats the link').toEqual([])
  expect(seen.filter(({ referer }) => referer === `${origin}/`), 'no Referer that names the origin alone').not.toEqual([])
})

test('a framed download page opens itself in Ripple with its torrent after the #, from a link written either way', async ({ page }) => {
  await page.goto('/legal')
  const here = new URL(page.url())
  test.skip(!/^(127\.0\.0\.1|localhost)$/.test(here.hostname), 'needs the loopback pair, so it is local only')
  // localhost and 127.0.0.1 are two origins on one server, so the page is framed by another site
  const framed = `http://localhost:${here.port}`
  const magnet = Buffer.from(NOBODY).toString('base64')
  for (const link of [`/download#magnet=${encodeURIComponent(magnet)}`, `/download?magnet=${encodeURIComponent(magnet)}`]) {
    await page.goto('/legal')
    await page.evaluate((src) => { document.body.append(Object.assign(document.createElement('iframe'), { id: 'ripple', src })) }, framed + link)
    const open = page.frameLocator('#ripple').getByRole('link', { name: 'Open this page in Ripple' })
    const href = new URL((await open.getAttribute('href', { timeout: 30_000 }))!)
    expect(`${href.origin}${href.pathname}${href.search}`, link).toBe(`${framed}/download`)
    expect(decodeMagnetParam(linkParams(href)), link).toBe(NOBODY)
  }
})
