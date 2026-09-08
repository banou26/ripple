// The embed's player served to whoever frames it, against a REAL torrent: a page on this origin frames
// /watch with Sintel, takes a `mediaPlayer` on it, and reads and moves the video through that alone.
// @banou/media-player's own browser test proves `mediaPlayer` over a bare <video> in a frame; what
// only this can show is the embed page serving the player it actually renders, source and all.
//
// Sintel is used because it carries a webseed, so the run does not depend on a swarm being alive.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const HARNESS = 'test-results/remote-harness/remote-harness.js'

type Snapshot = { paused: boolean, time: number, rate: number, ready: boolean, duration: number }

// The embed only reaches a video once the torrent moves bytes, and a headless Chromium sits at
// "Loading metadata…" forever in every topology (measured 2026-08-05). Headful, under Xvfb when
// nobody is at the machine.
test.use({ headless: false })

test.beforeAll(() => { execFileSync('node', ['scripts/bundle-remote-harness.mjs'], { stdio: 'inherit' }) })

test('the embed serves its player to the page that frames it', async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  await page.goto('/legal')
  // Served at a same-origin url rather than injected inline: the page's CSP admits scripts from
  // 'self' only, and a module script also runs deferred, so the global is waited for.
  await page.route('**/remote-harness.js', route => route.fulfill({ body: readFileSync(HARNESS, 'utf8'), contentType: 'text/javascript' }))
  await page.addScriptTag({ url: '/remote-harness.js', type: 'module' })
  await page.waitForFunction(() => typeof window.mediaPlayer === 'function', null, { timeout: 10_000 })

  // Index 5 is the video. The embed's default is file 0, which for Sintel is a subtitle track, and a
  // player handed a subtitle reports "No playable video track" and never plays.
  const src = `${baseURL}/watch?magnet=${Buffer.from(SINTEL).toString('base64')}&fileIndex=5`
  await page.evaluate(async ({ src }) => {
    const frame = document.createElement('iframe')
    frame.id = 'embed'
    frame.src = src
    frame.allow = 'autoplay'
    Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', border: 'none' })
    document.body.append(frame)
    const w = window as unknown as { player: ReturnType<Window['mediaPlayer']>, events: string[] }
    w.player = window.mediaPlayer(frame, { origin: location.origin })
    w.events = []
    for (const name of ['play', 'pause', 'seeked']) w.player.addEventListener(name, () => w.events.push(name))
    await w.player.ready
  }, { src })

  const snapshot = () => page.evaluate((): Snapshot => {
    const { player } = window as unknown as { player: ReturnType<Window['mediaPlayer']> }
    return { paused: player.paused, time: player.currentTime, rate: player.playbackRate ?? 1, ready: player.readyState >= 3, duration: player.duration }
  })
  const events = () => page.evaluate(() => (window as unknown as { events: string[] }).events)

  // the player autoplays once the source is up; a moving clock is the mirror being fed
  await expect.poll(async () => (await snapshot()).time, { timeout: 150_000, intervals: [1_000] }).toBeGreaterThan(0.5)
  expect((await snapshot()).paused).toBe(false)
  expect((await snapshot()).duration).toBeGreaterThan(60)

  // pause it from outside and move it well ahead; the far side's own events say when it happened
  const before = (await events()).length
  const target = (await snapshot()).time + 40
  await page.evaluate(t => {
    const { player } = window as unknown as { player: ReturnType<Window['mediaPlayer']> }
    player.pause()
    player.currentTime = t
  }, target)
  await expect.poll(async () => (await events()).slice(before).includes('seeked'), { timeout: 30_000, intervals: [500] }).toBe(true)
  const paused = await snapshot()
  expect(paused.paused).toBe(true)
  expect(Math.abs(paused.time - target)).toBeLessThan(2)

  // and play again from there, which the far element has to agree to
  await page.evaluate(() => (window as unknown as { player: ReturnType<Window['mediaPlayer']> }).player.play())
  await expect.poll(async () => { const s = await snapshot(); return !s.paused && s.time > target }, { timeout: 60_000, intervals: [1_000] }).toBe(true)

  // the element itself, read from inside the frame, agrees with the mirror
  const embed = page.frames().find(frame => frame.url().includes('/watch?'))!
  const inFrame = await embed.evaluate(() => { const v = document.querySelector('video')!; return { paused: v.paused, time: v.currentTime } })
  expect(inFrame.paused).toBe(false)
  expect(inFrame.time).toBeGreaterThan(target)
})
