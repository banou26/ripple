// The real service worker in a real browser, where tests/sw.test.ts only drives sw.js against a
// stand-in global.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import type { Frame, Page } from '@playwright/test'
import { expect, test } from './offline'

const TOTAL = 3 * 1024 * 1024
const CHUNK = 512 * 1024

const expected = () => {
  const bytes = Buffer.alloc(TOTAL)
  for (let i = 0; i < TOTAL; i++) bytes[i] = i % 251
  return bytes
}

/** Opens a download named `name` and starts feeding it, through a hand-rolled copy of the wire protocol in src/torrent/stream-download.ts. */
const startStream = (page: Page, name: string) =>
  page.evaluate(async ({ total, chunkSize, name }) => {
    const registration = await navigator.serviceWorker.ready
    const worker = registration.active!
    const id = crypto.randomUUID()
    const channel = new MessageChannel()
    const port = channel.port1

    let credits = 0
    let wake: (() => void) | null = null
    const notify = () => { const w = wake; wake = null; w?.() }
    let peakOutstanding = 0
    const ready = Promise.withResolvers<void>()

    port.onmessage = (event) => {
      if (event.data?.type === 'stream-ready') { ready.resolve(); return }
      if (event.data?.type !== 'pull') return
      credits++
      notify()
    }
    worker.postMessage({ type: 'stream-open', id, name, size: total }, [channel.port2])
    /*
     * The frame's fetch and this message reach the worker by separate routes, and a fetch that gets
     * there first is answered 404 "Unknown download": 3 of 10 runs under one busy loop per core,
     * 2026-10-09. So the frame waits for the worker to say the stream is registered.
     */
    await ready.promise

    // MUST be a navigation: an <a download> click runs outside the service worker
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('sandbox', 'allow-downloads allow-same-origin allow-scripts')
    frame.src = `/__ripple-stream/${id}/${encodeURIComponent(name)}`
    document.body.appendChild(frame)

    ;(window as any).__feed = (async () => {
      for (let offset = 0; offset < total; offset += chunkSize) {
        while (credits <= 0) await new Promise<void>((resolve) => { wake = resolve })
        peakOutstanding = Math.max(peakOutstanding, credits)
        credits--
        const len = Math.min(chunkSize, total - offset)
        const data = new Uint8Array(len)
        for (let i = 0; i < len; i++) data[i] = (offset + i) % 251
        port.postMessage({ type: 'chunk', data }, [data.buffer])
      }
      while (credits <= 0) await new Promise<void>((resolve) => { wake = resolve })
      port.postMessage({ type: 'end' })
      return peakOutstanding
    })()
  }, { total: TOTAL, chunkSize: CHUNK, name })

test('the service worker turns posted chunks into a real download', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await page.goto('/')
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller != null,
    undefined,
    { timeout: 30_000 },
  )

  // armed before the frame exists, because the download can begin before the evaluate that opens it returns
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
  await startStream(page, 'probe.bin')

  // fed and drained at once on purpose: awaiting either one first waits on the other forever
  const feeding = page.evaluate(() => (window as any).__feed as Promise<number>)

  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('probe.bin')
  const [peak, path] = await Promise.all([feeding, download.path()])
  const got = readFileSync(path)

  expect(got.length).toBe(TOTAL)
  expect(createHash('sha256').update(got).digest('hex'))
    .toBe(createHash('sha256').update(expected()).digest('hex'))
  expect(peak).toBe(1)
  expect(pageErrors).toEqual([])
})

/*
 * A header holds no character above U+00FF. Written raw into Content-Disposition, such a name made the
 * worker's answer throw, the frame got the app's page instead, and the save waited forever for its
 * second pull with no error.
 */
test('a file named beyond Latin-1 is saved whole under its own name', async ({ page }) => {
  test.setTimeout(150_000)
  await page.goto('/')
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 })

  const names = [
    '\u65e5\u672c\u8a9e\u306e\u6620\u753b \u7b2c1\u8a71.mkv',
    'clip \u{1f3ac}.mkv',
    'Somebody\u2019s Home Video (2011).mkv',
    'plain name.mkv',
  ]
  const want = expected()
  const saved: string[] = []
  for (const name of names) {
    const downloading = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null)
    await startStream(page, name)
    const download = await downloading
    if (!download) { saved.push(`${name}: no download within 15 s`); continue }
    const [, path] = await Promise.all([page.evaluate(() => (window as any).__feed as Promise<number>), download.path()])
    const got = readFileSync(path)
    saved.push(`${download.suggestedFilename()}: ${got.length} bytes, ${got.equals(want) ? 'exact' : 'wrong'}`)
  }
  expect(saved).toEqual(names.map((name) => `${name}: ${TOTAL} bytes, exact`))
})

test('an unclaimed download URL does not serve the app itself', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 })
  const status = await page.evaluate(async () => {
    const res = await fetch('/__ripple-stream/does-not-exist/file.mkv')
    return res.status
  })
  expect(status).toBe(404)
})

/*
 * The save frame runs scripts, so a save address the worker does not claim gets the app from the server, and a
 * second Ripple in that frame would fight the page's for the storage locks. With no worker the server answers, as it
 * does for such a frame. smoke.spec.ts has the same address opened as a page, which goes on to the library.
 */
test('the app refuses to start in a save frame', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.addInitScript(() => window.addEventListener('error', (event) => { (window as any).__error = event.message }))
  const page = await context.newPage()
  await page.goto('/assets/logo.png')
  await page.evaluate(() => {
    for (const src of ['/__ripple-stream/abc/file.bin', '/no-such-page']) {
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', 'allow-downloads allow-same-origin allow-scripts')
      frame.src = src
      document.body.append(frame)
    }
  })
  // the control: the same frame anywhere else starts the app
  await expect(page.frameLocator('iframe[src="/no-such-page"]').locator('.mount')).toHaveCount(1, { timeout: 30_000 })
  const save = page.frames().find((frame) => frame.url().includes('/__ripple-stream/'))!
  await expect.poll(() => save.evaluate(() => (window as any).__error)).toContain('Ripple does not start under /__ripple-stream/')
  await expect(page.frameLocator('iframe[src^="/__ripple-stream/"]').locator('.mount')).toHaveCount(0)
  await context.close()
})

/*
 * The same download through the app's own path: a torrent in the library and its Save button, so
 * src/torrent/stream-download.ts is what talks to the worker. The torrent is made from a file picked
 * through an input, which copies its bytes into browser storage, so it is complete the moment it
 * exists: no network and no transfer.
 */
const FILE = { name: 'E01.mkv', bytes: 300_000, fill: 0x11 }

const libraryFile = async (page: Page, file = FILE) => {
  await page.addInitScript(() => {
    const w = window as any
    try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
    // no handle pickers, so the pick goes through an input and its bytes are kept
    delete w.showDirectoryPicker
    delete w.showOpenFilePicker
    // a fallback reached after the stream was refused, and whether the click still counted by then
    w.__pickerCalls = []
    w.showSaveFilePicker = async () => {
      w.__pickerCalls.push(navigator.userActivation.isActive)
      throw new DOMException('no picker in this test', 'NotAllowedError')
    }
  })

  const path = test.info().outputPath(file.name)
  writeFileSync(path, Buffer.alloc(file.bytes, file.fill))

  await page.goto('/')
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  const dialog = page.getByRole('dialog')
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Choose a file', exact: true }).click()
  await (await chooser).setFiles(path)
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.locator('[data-outcome="copied"]')).toBeVisible({ timeout: 120_000 })
  await dialog.getByRole('button', { name: 'Close' }).click()

  const save = page.getByRole('button', { name: `Save ${file.name} to disk` })
  await expect(save, 'the torrent never completed').toBeVisible({ timeout: 150_000 })
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 })
  return {
    save,
    pickerCalls: () => page.evaluate(() => (window as any).__pickerCalls as boolean[]),
  }
}

test('a library save is delivered by the service worker, not by the fallback', async ({ page }) => {
  test.setTimeout(300_000)
  const { save, pickerCalls } = await libraryFile(page)

  const downloading = page.waitForEvent('download', { timeout: 60_000 })
  await save.click()
  const download = await downloading

  // a stream URL answered "Unknown download" makes the app give up on it and save through a blob
  expect(download.url(), 'the worker refused the stream, so the save fell back').toContain('/__ripple-stream/')
  expect(readFileSync(await download.path()).equals(Buffer.alloc(FILE.bytes, FILE.fill))).toBe(true)
  expect(await pickerCalls()).toEqual([])
})

test('a worker that never registers the stream falls back while the click still counts', async ({ page }) => {
  test.setTimeout(300_000)
  await page.addInitScript(() => {
    // oxlint-disable-next-line typescript/unbound-method
    ServiceWorker.prototype.postMessage = new Proxy(ServiceWorker.prototype.postMessage, {
      apply: (post, worker, args) => (args[0]?.type === 'stream-open' ? undefined : Reflect.apply(post, worker, args)),
    })
  })
  const { save, pickerCalls } = await libraryFile(page)

  const downloading = page.waitForEvent('download', { timeout: 60_000 })
  await save.click()
  const download = await downloading

  expect(download.url()).toMatch(/^blob:/)
  expect(readFileSync(await download.path()).equals(Buffer.alloc(FILE.bytes, FILE.fill))).toBe(true)
  // the picker needs the click's activation, which lapses about five seconds after it
  expect(await pickerCalls(), 'the fallback was reached after the click stopped counting').toEqual([true])
})

/** Counts the saves a page asks the worker for, and drops them when `__dropOpen` is set. */
const watchSaves = () => {
  const w = window as any
  w.__opened = 0
  // oxlint-disable-next-line typescript/unbound-method
  ServiceWorker.prototype.postMessage = new Proxy(ServiceWorker.prototype.postMessage, {
    apply: (post, worker, args) => {
      if (args[0]?.type === 'stream-open' && ++w.__opened && w.__dropOpen) return
      return Reflect.apply(post, worker, args)
    },
  })
}

const opened = (target: Page | Frame) => target.evaluate(() => (window as any).__opened as number)

/*
 * A download link opened as its own page starts the save by itself, 2 s after its files are in, when the service
 * worker can hand it to the browser's downloads, so with no worker in control it waits for one. Framed, or with a
 * worker that does not take the save, the page waits for the button as before, and a press before the 2 s is its
 * only save.
 */
test('a download link opened as its own page starts saving by itself', async ({ page, context }) => {
  test.setTimeout(300_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await context.addInitScript(watchSaves)
  await libraryFile(page)
  await page.locator('.torrent', { hasText: FILE.name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy magnet' }).click()
  const magnet = await page.evaluate(() => navigator.clipboard.readText())
  const link = `${new URL(page.url()).origin}/download?magnet=${encodeURIComponent(Buffer.from(magnet).toString('base64'))}`
  const want = Buffer.alloc(FILE.bytes, FILE.fill)
  const cta = (target: Page) => target.locator('button.cta')

  await test.step('framed, it waits for the button', async () => {
    // a page of the same origin, whose storage the frame shares: a frame under another site gets a partition of its own
    const top = await context.newPage()
    await top.goto('/assets/logo.png')
    await top.evaluate((src) => {
      const frame = document.createElement('iframe')
      frame.src = src
      frame.style.cssText = 'width: 900px; height: 700px'
      document.body.append(frame)
    }, link)
    await expect(top.frameLocator('iframe[src*="/download"]').locator('button.cta')).toBeEnabled({ timeout: 60_000 })
    const frame = top.frames().find((f) => f.url().includes('/download'))!
    expect(await frame.evaluate(() => navigator.serviceWorker.controller !== null), 'no worker in the frame, so this proves nothing').toBe(true)
    await top.waitForTimeout(6_000)
    expect(await opened(frame)).toBe(0)
    await top.close()
  })

  // as on a first visit, where the worker takes control once it has installed
  await test.step('with no worker in control yet, it waits for one', async () => {
    const own = await context.newPage()
    await own.addInitScript(() => {
      const w = window as any
      w.__hidden = true
      // oxlint-disable-next-line typescript/unbound-method
      const controller = Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, 'controller')!.get!
      Object.defineProperty(ServiceWorkerContainer.prototype, 'controller', {
        configurable: true,
        get () { return w.__hidden ? null : controller.call(this) },
      })
    })
    let downloads = 0
    own.on('download', () => downloads++)
    await own.goto(link)
    await expect(cta(own)).toBeEnabled({ timeout: 60_000 })
    await own.waitForTimeout(6_000)
    expect(downloads).toBe(0)
    expect(await opened(own)).toBe(0)

    const downloading = own.waitForEvent('download', { timeout: 30_000 })
    await own.evaluate(() => {
      (window as any).__hidden = false
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))
    })
    expect(readFileSync(await (await downloading).path()).equals(want)).toBe(true)
    await own.close()
  })

  await test.step('with a worker that does not take the save, it goes back to the button', async () => {
    const own = await context.newPage()
    await own.addInitScript(() => {
      const w = window as any
      w.__dropOpen = true
      w.showSaveFilePicker = async () => { throw new DOMException('no picker in this test', 'NotAllowedError') }
    })
    let downloads = 0
    own.on('download', () => downloads++)
    await own.goto(link)
    await expect(cta(own)).toBeEnabled({ timeout: 60_000 })
    await expect.poll(() => opened(own), { timeout: 10_000 }).toBe(1)
    // the worker's 3 s to answer, then the button again
    await expect(cta(own)).toHaveText('Download', { timeout: 15_000 })
    await expect(cta(own)).toBeEnabled()
    await own.waitForTimeout(3_000)
    expect(downloads, 'it fell back to an arm that needs a click').toBe(0)
    await expect(own.getByText(/The download stopped/)).toHaveCount(0)
    await own.close()
  })

  await test.step('as its own page with the worker in control, it starts by itself', async () => {
    const own = await context.newPage()
    let startedAt = 0
    own.on('download', () => { startedAt ||= Date.now() })
    const downloading = own.waitForEvent('download', { timeout: 60_000 })
    await own.goto(link)
    await expect(cta(own)).toBeEnabled({ timeout: 60_000 })
    const readyAt = Date.now()
    const download = await downloading
    expect(startedAt - readyAt, 'it started without waiting').toBeGreaterThan(1_000)
    expect(download.url()).toContain('/__ripple-stream/')
    expect(readFileSync(await download.path()).equals(want)).toBe(true)
    await own.close()
  })

  await test.step('pressed before it starts, the press is the only save', async () => {
    const own = await context.newPage()
    await own.goto(link)
    await expect(cta(own)).toBeEnabled({ timeout: 60_000 })
    const [download] = await Promise.all([own.waitForEvent('download', { timeout: 60_000 }), cta(own).click()])
    expect(readFileSync(await download.path()).equals(want)).toBe(true)
    await expect(cta(own)).toBeEnabled({ timeout: 30_000 })
    await own.waitForTimeout(4_000)
    expect(await opened(own)).toBe(1)
    await own.close()
  })
})

/*
 * With the page gone mid-save, Chrome showed the download in progress forever and Firefox kept a short
 * file it listed as finished. The page tells the worker on pagehide, and both show the download failed.
 */
test('closing the page mid-save fails the browser\'s download', async ({ page, browserName }) => {
  /*
   * Playwright's Firefox takes a download through its own handler, which reports it finished the moment
   * its page closes, whatever the worker does. Firefox with nothing attached lists this one as failed,
   * and as finished but short without the abort (measured).
   */
  test.skip(browserName === 'firefox', 'Playwright\'s Firefox download handler cannot show this')
  test.setTimeout(300_000)
  // nothing reaches the worker past the first chunk, so the save is still running when the page closes
  await page.addInitScript(() => {
    const w = window as any
    w.__fed = false
    // oxlint-disable-next-line typescript/unbound-method
    MessagePort.prototype.postMessage = new Proxy(MessagePort.prototype.postMessage, {
      apply: (post, port, args) => {
        const type = args[0]?.type
        if (w.__fed && (type === 'chunk' || type === 'end')) return
        if (type === 'chunk') w.__fed = true
        return Reflect.apply(post, port, args)
      },
    })
  })
  const { save } = await libraryFile(page, { name: 'E02.mkv', bytes: 9_000_000, fill: 0x22 })

  const downloading = page.waitForEvent('download', { timeout: 60_000 })
  await save.click()
  const download = await downloading
  await page.waitForFunction(() => (window as any).__fed)
  await page.close()
  const outcome = await Promise.race([
    download.failure().then((failure) => failure ?? 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('still in progress 30 s after the page closed'), 30_000)),
  ])
  expect(outcome).toBe('canceled')
})
