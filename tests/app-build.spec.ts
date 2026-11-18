// What building ripple as an app, rather than as a library, gives a visitor, on the built bytes: a return visit runs the
// hash-named entry from the service worker's cache, the engine's wasm arrives as a file of its own, and the manifest,
// which the build leaves as it is, names icons that are there.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from './offline'

const MAGNET = 'input[aria-label="Add a magnet link, or search"]'

test('a return visit runs the entry from the service worker cache, with no request to the server', async ({ page, request }) => {
  const entry = /<script type="module"[^>]* src="([^"]+)"/.exec(await (await request.get('/')).text())?.[1]
  expect(entry, 'the page loads no module').toBeDefined()
  await page.goto('/')
  await expect(page.locator(MAGNET)).toBeVisible()
  // a worker is active only once its install has run the precache
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const answered = new Map<string, string>()
  cdp.on('Network.responseReceived', ({ response }) => {
    answered.set(new URL(response.url).pathname, response.fromServiceWorker ? `worker ${response.serviceWorkerResponseSource}` : 'server')
  })
  await page.reload()
  await expect(page.locator(MAGNET)).toBeVisible()
  expect(answered.get(entry!)).toBe('worker cache-storage')
  // the control: the document is never the worker's to answer
  expect(answered.get('/')).toBe('server')
})

test('the engine starts on its wasm, fetched as a file', async ({ page }) => {
  const fetched: { status: number, type?: string }[] = []
  page.context().on('response', (response) => {
    if (/^\/assets\/libtorrent-[\w-]{8}\.wasm$/.test(new URL(response.url()).pathname)) fetched.push({ status: response.status(), type: response.headers()['content-type'] })
  })
  await page.addInitScript(() => {
    const w = window as unknown as { __engine: Promise<string> }
    w.__engine = new Promise((resolve) => {
      const Native = window.Worker
      window.Worker = class extends Native {
        constructor (url: string | URL, options?: WorkerOptions) {
          super(url, options)
          this.addEventListener('message', ({ data }) => { if (data?.type === 'ready' || data?.type === 'storage-unavailable') resolve(data.type) })
        }
      }
    })
  })
  await page.goto('/')
  expect(await page.evaluate(() => (window as unknown as { __engine: Promise<string> }).__engine)).toBe('ready')
  expect(fetched.length, 'nothing fetched the engine wasm').toBeGreaterThan(0)
  for (const response of fetched) expect(response).toEqual({ status: 200, type: 'application/wasm' })
})

test('the manifest names icons that are there', async ({ request, baseURL }) => {
  const href = /<link rel="manifest" href="([^"]+)"/.exec(await (await request.get('/')).text())?.[1]
  expect(href, 'the page names no manifest').toBeDefined()
  const at = new URL(href!, baseURL)
  const manifest = await (await request.get(at.href)).json() as { icons: Icon[], file_handlers: { icons: Icon[] }[] }
  const icons = [...manifest.icons, ...manifest.file_handlers.flatMap((handler) => handler.icons)]
  expect(icons.length).toBeGreaterThan(0)
  for (const icon of icons) {
    // a path that is not there answers the app's page, with a 200
    const response = await request.get(new URL(icon.src, at).href)
    expect(response.status(), icon.src).toBe(200)
    expect(response.headers()['content-type'], icon.src).toBe(icon.type)
  }
})

type Icon = { src: string, type: string }

// unpkg answers 500 for a 0-byte file, and a device verifies every file of the package through it (0.0.76, 2026-11-19)
test('no file of the build is empty', () => {
  const files = (readdirSync('build', { recursive: true }) as string[]).filter((name) => statSync(join('build', name)).isFile())
  expect(files.length, 'the build holds no files').toBeGreaterThan(20)
  expect(files.filter((name) => statSync(join('build', name)).size === 0)).toEqual([])
})
