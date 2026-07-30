// The streamed export in a real browser. src/sw.test.ts drives sw.js in isolation with a
// stand-in global, which proves the protocol but not that a browser actually intercepts the
// synthetic URL, honours the headers, and writes a file. This runs the real service worker,
// registered by the real app, and checks the bytes that land on disk.
//
// Runs on both projects on purpose: Chromium takes the showSaveFilePicker path in the app,
// so Firefox is the browser this feature exists for.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

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
  // The app registers the worker on load; interception needs it to be controlling too.
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller != null,
    undefined,
    { timeout: 30_000 },
  )

  // Drives the same wire protocol as src/torrent/stream-download.ts. Kept as raw messages
  // rather than importing the module, because the built app exposes no entry point for it.
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

    port.onmessage = (event) => {
      if (event.data?.type !== 'pull') return
      credits++
      notify()
    }
    worker.postMessage({ type: 'stream-open', id, name: 'probe.bin', size: total }, [channel.port2])

    // A navigation, not an <a download> click: a download started by the download
    // attribute runs outside the service worker, so the click would be answered by the
    // network with the app's own index.html rather than by the stream.
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('sandbox', 'allow-downloads allow-same-origin')
    frame.src = `/__ripple-stream/${id}/probe.bin`
    document.body.appendChild(frame)

    ;(window as any).__feed = (async () => {
      for (let offset = 0; offset < total; offset += chunkSize) {
        while (credits <= 0) await new Promise<void>((resolve) => { wake = resolve })
        // A credit only ever arrives after the browser has taken the previous chunk, so
        // the count of unspent credits is how much the writer is allowed to run ahead.
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

  // Fed and drained at the same time on purpose. The browser only asks for the next chunk
  // once it has written the last one, and the file is only complete once the last chunk has
  // been sent, so awaiting either one first would wait on the other forever.
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
  const feeding = page.evaluate(() => (window as any).__feed as Promise<number>)

  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('probe.bin')
  const [peak, path] = await Promise.all([feeding, download.path()])
  const got = readFileSync(path!)

  expect(got.length).toBe(TOTAL)
  expect(createHash('sha256').update(got).digest('hex'))
    .toBe(createHash('sha256').update(expected()).digest('hex'))
  // Backpressure: never more than one chunk waiting to be written.
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
  // Falling through would hand back index.html, which the browser would then save under
  // the file's name.
  expect(status).toBe(404)
})
