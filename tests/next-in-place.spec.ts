// An embedder's `open` plays the next file in the same /watch document: no new document, no second engine worker, and
// no step in the tab's history. The control replaces the frame's address the way the plugin did before, which each of
// those checks has to see. Nothing here needs bytes to arrive, so it runs headless. The embedder is a page of this
// origin that runs no engine (/legal): Chrome refuses a page Playwright fulfils a frame of a loopback address.
import { expect, test } from '@playwright/test'

const FIRST = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'
const NEXT = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny'

test('an open from the embedder keeps the document, the engine and the history', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    const engines = (window as any).__engines = [] as string[]
    const Wrapped = function (url: string | URL, options?: WorkerOptions) {
      if (!/libav|jassub/i.test(String(url))) engines.push(String(url))
      return new NativeWorker(url, options)
    } as unknown as typeof Worker
    Wrapped.prototype = NativeWorker.prototype
    Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: Wrapped })
  })
  const src = `/watch?${new URLSearchParams({ magnet: Buffer.from(FIRST).toString('base64') })}`
  await page.goto('/legal')
  await page.evaluate((src) => {
    const frame = Object.assign(document.createElement('iframe'), { id: 'ripple', src, allow: 'autoplay' })
    document.body.append(frame)
  }, src)
  const ripple = () => page.frames().find(f => f.url().includes('/watch?'))!
  await expect.poll(() => ripple()?.evaluate(() => (window as any).__engines.length).catch(() => 0)).toBe(1)
  await ripple().evaluate(() => { (window as any).__marker = 'first' })
  const history = await page.evaluate(() => history.length)

  const answered = page.evaluate(() => new Promise(resolve => {
    addEventListener('message', event => { if (event.data?.ripple === 'opened') resolve(event.source === (document.getElementById('ripple') as HTMLIFrameElement).contentWindow) })
  }))
  await page.evaluate((magnet) => (document.getElementById('ripple') as HTMLIFrameElement).contentWindow!.postMessage({ ripple: 'open', magnet, fileIndex: 2 }, '*'), NEXT)
  expect(await answered, 'answered by the frame').toBe(true)
  await expect.poll(() => new URL(ripple().url()).searchParams.get('fileIndex')).toBe('2')
  expect(await ripple().evaluate(() => (window as any).__marker), 'the same document').toBe('first')
  expect(await ripple().evaluate(() => (window as any).__engines.length), 'one engine worker').toBe(1)
  expect(await page.evaluate(() => history.length), 'no step in the history').toBe(history)

  // a message from anything but the framing window is not heard
  await ripple().evaluate((magnet) => window.postMessage({ ripple: 'open', magnet, fileIndex: 4 }, '*'), NEXT)
  await page.waitForTimeout(500)
  expect(new URL(ripple().url()).searchParams.get('fileIndex')).toBe('2')

  // the control: a new address on the frame is a new document and a step back
  await page.evaluate((src) => { (document.getElementById('ripple') as HTMLIFrameElement).src = `${src}&fileIndex=3` }, src)
  await expect.poll(() => new URL(ripple().url()).searchParams.get('fileIndex')).toBe('3')
  await expect.poll(() => ripple().evaluate(() => (window as any).__marker ?? null).catch(() => 'gone')).toBeNull()
  expect(await page.evaluate(() => history.length)).toBe(history + 1)
})
