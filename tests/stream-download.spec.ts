// The real service worker in a real browser, where tests/sw.test.ts only drives sw.js against a
// stand-in global.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const TOTAL = 3 * 1024 * 1024
const CHUNK = 512 * 1024

const expected = () => {
  const bytes = Buffer.alloc(TOTAL)
  for (let i = 0; i < TOTAL; i++) bytes[i] = i % 251
  return bytes
}

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

  // hand-rolled copy of the wire protocol in src/torrent/stream-download.ts
  await page.evaluate(async ({ total, chunkSize }) => {
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
    worker.postMessage({ type: 'stream-open', id, name: 'probe.bin', size: total }, [channel.port2])
    /*
     * The frame's fetch and this message reach the worker by separate routes, and a fetch that gets
     * there first is answered 404 "Unknown download": 3 of 10 runs under one busy loop per core,
     * 2026-10-09. So the frame waits for the worker to say the stream is registered.
     */
    await ready.promise

    // MUST be a navigation: an <a download> click runs outside the service worker
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('sandbox', 'allow-downloads allow-same-origin')
    frame.src = `/__ripple-stream/${id}/probe.bin`
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
  }, { total: TOTAL, chunkSize: CHUNK })

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
 * The same download through the app's own path: a torrent in the library and its Save button, so
 * src/torrent/stream-download.ts is what talks to the worker. The torrent is made from a file picked
 * through an input, which copies its bytes into browser storage, so it is complete the moment it
 * exists: no network and no transfer.
 */
const FILE = { name: 'E01.mkv', bytes: 300_000, fill: 0x11 }

const libraryFile = async (page: Page) => {
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

  const path = test.info().outputPath(FILE.name)
  writeFileSync(path, Buffer.alloc(FILE.bytes, FILE.fill))

  await page.goto('/')
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  const dialog = page.getByRole('dialog')
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Choose a file', exact: true }).click()
  await (await chooser).setFiles(path)
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.getByText('Ripple kept its own copy')).toBeVisible({ timeout: 120_000 })
  await dialog.getByRole('button', { name: 'Close' }).click()

  const save = page.getByRole('button', { name: `Save ${FILE.name} to disk` })
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
