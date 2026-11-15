// The player's "Autoplay next episode" switch, set by the page framing /watch through the player's own channel
// (`@banou/media-player/remote`): ripple passes nothing and keeps nothing, the player shows what the embedder sets, the
// viewer's flip reaches the embedder, and the next file's player shows it without being set again. The switch needs
// no bytes, so this runs headless on a torrent nobody serves. The embedder is a page of this origin, as in
// next-in-place.spec.ts.
import type { FrameLocator, Page } from '@playwright/test'

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { expect, test } from './offline'

const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'
const SRC = `/watch?${new URLSearchParams({ magnet: Buffer.from(MAGNET).toString('base64') })}`
const HARNESS = 'test-results/remote-harness/remote-harness.js'

type Root = Page | FrameLocator
type Embedder = Window & { player: ReturnType<Window['mediaPlayer']> & { autoplayNext: boolean | null }, heard: (boolean | null)[] }

test.beforeAll(() => { execFileSync('node', ['scripts/bundle-remote-harness.mjs'], { stdio: 'inherit' }) })

const menu = (root: Root) => root.locator('.popover.menu')
const autoplaySwitch = (root: Root) => menu(root).locator('[role="switch"]', { hasText: 'Autoplay next episode' })
const openSettings = async (root: Root) => {
  if (!await menu(root).isVisible()) await root.locator('button.settings').click()
  await expect(menu(root)).toBeVisible()
}

test('the page framing /watch shows the player its autoplay switch, hears it flipped, and sets it once for every file', async ({ page }) => {
  await page.goto('/legal')
  await page.route('**/remote-harness.js', route => route.fulfill({ body: readFileSync(HARNESS, 'utf8'), contentType: 'text/javascript' }))
  await page.addScriptTag({ url: '/remote-harness.js', type: 'module' })
  await page.waitForFunction(() => typeof window.mediaPlayer === 'function', null, { timeout: 10_000 })
  await page.evaluate(async (src) => {
    const frame = Object.assign(document.createElement('iframe'), { id: 'ripple', src, allow: 'autoplay' })
    Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', border: 'none' })
    document.body.append(frame)
    const w = window as unknown as Embedder
    w.player = window.mediaPlayer(frame, { origin: location.origin }) as Embedder['player']
    w.heard = []
    w.player.addEventListener('autoplaynextchange', () => w.heard.push(w.player.autoplayNext))
    await w.player.ready
  }, SRC)
  const ripple = page.frameLocator('#ripple')
  const mirrored = () => page.evaluate(() => (window as unknown as Embedder).player.autoplayNext)

  await openSettings(ripple)
  await expect(autoplaySwitch(ripple), 'nobody set it').toHaveCount(0)
  expect(await mirrored()).toBeNull()

  await page.evaluate(() => { (window as unknown as Embedder).player.autoplayNext = false })
  await expect(autoplaySwitch(ripple)).toHaveAttribute('aria-checked', 'false')
  await expect(menu(ripple).locator(':scope > div').first(), 'the first row').toHaveText('Autoplay next episode')
  await expect.poll(mirrored).toBe(false)

  await autoplaySwitch(ripple).click()
  await expect(autoplaySwitch(ripple)).toHaveAttribute('aria-checked', 'true')
  await expect.poll(mirrored).toBe(true)
  expect(await page.evaluate(() => (window as unknown as Embedder).heard)).toEqual([false, true])

  // the next file, in a player of its own in the same document
  await page.evaluate((magnet) => (document.getElementById('ripple') as HTMLIFrameElement).contentWindow!.postMessage({ ripple: 'open', magnet, fileIndex: 1 }, '*'), MAGNET)
  await expect.poll(() => new URL(page.frames().find(f => f.url().includes('/watch?'))!.url()).searchParams.get('fileIndex')).toBe('1')
  await openSettings(ripple)
  await expect(autoplaySwitch(ripple)).toHaveAttribute('aria-checked', 'true')

  const kept = await page.frames().find(f => f.url().includes('/watch?'))!.evaluate(() => Object.keys(localStorage).filter(key => /autoplay/i.test(key)))
  expect(kept, 'ripple keeps nothing of it').toEqual([])
})

test('/watch opened on its own shows no autoplay switch', async ({ page }) => {
  await page.goto(SRC)
  await openSettings(page)
  await expect(menu(page).locator('[role="switch"]').first()).toBeAttached()
  await expect(autoplaySwitch(page)).toHaveCount(0)
})
