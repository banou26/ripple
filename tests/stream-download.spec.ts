// The real service worker in a real browser, where src/sw.test.ts only drives sw.js against
// a stand-in global. Firefox is the browser this path exists for: Chromium takes showSaveFilePicker.

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
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller != null,
    undefined,
    { timeout: 30_000 },
  )

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

    port.onmessage = (event) => {
      if (event.data?.type !== 'pull') return
      credits++
      notify()
    }
    worker.postMessage({ type: 'stream-open', id, name: 'probe.bin', size: total }, [channel.port2])

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
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
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
