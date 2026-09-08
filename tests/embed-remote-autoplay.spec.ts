// `autoplay()` against the real embed: the call an app makes when it needs a player to start in a
// document nobody has clicked.
//
// WHAT THIS CANNOT SHOW, and the reason it is worth writing down. The failure this API exists for is
// an autoplay REFUSAL, and this rig cannot produce one: measured 2026-09-07, the embed document
// reports `navigator.userActivation.hasBeenActive === true` under automation without anything being
// clicked, so an unmuted video autoplays here and would not for a person. playwright.config.ts also
// sets `--autoplay-policy=no-user-gesture-required` for the torrent ramp, which switches the rule off
// outright for every other spec. Two independent reasons the refusal is invisible here.
//
// So the refusal itself is pinned in @banou/media-player's unit tests, where the far side can be made
// to refuse on demand (src/lib/remote/remote.test.ts, "autoplay, for a document nobody has clicked"
// and "a player whose play() resolves without playing"). What THIS proves is the other half: that the
// call crosses to a real embed over a real frame boundary, starts the player it actually renders, and
// answers honestly about the sound.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const HARNESS = 'test-results/remote-harness/remote-harness.js'

// Headful for the torrent, as the other remote spec is.
test.use({ headless: false })

test.beforeAll(() => { execFileSync('node', ['scripts/bundle-remote-harness.mjs'], { stdio: 'inherit' }) })

test('autoplay starts the embed and reports whether it had to mute', async ({ page, baseURL }) => {
  test.setTimeout(240_000)
  await page.goto('/legal')
  await page.route('**/remote-harness.js', route => route.fulfill({ body: readFileSync(HARNESS, 'utf8'), contentType: 'text/javascript' }))
  await page.addScriptTag({ url: '/remote-harness.js', type: 'module' })
  await page.waitForFunction(() => typeof window.mediaPlayer === 'function', null, { timeout: 10_000 })

  // Index 5 is the video; the default file 0 is a subtitle track and never plays.
  const src = `${baseURL}/watch?magnet=${Buffer.from(SINTEL).toString('base64')}&fileIndex=5`
  await page.evaluate(async ({ src }) => {
    const frame = document.createElement('iframe')
    frame.src = src
    frame.allow = 'autoplay'
    Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', border: 'none' })
    document.body.append(frame)
    const w = window as unknown as { player: ReturnType<Window['mediaPlayer']> }
    w.player = window.mediaPlayer(frame, { origin: location.origin })
    await w.player.ready
  }, { src })

  const player = () => page.evaluate(() => {
    const { player } = window as unknown as { player: ReturnType<Window['mediaPlayer']> }
    return { paused: player.paused, time: player.currentTime, muted: player.muted, ready: player.readyState }
  })

  await expect.poll(async () => (await player()).ready, { timeout: 210_000, intervals: [1_000] }).toBeGreaterThanOrEqual(2)

  // paused first, so autoplay has something to do rather than reporting a player that was already up
  await page.evaluate(() => (window as unknown as { player: ReturnType<Window['mediaPlayer']> }).player.pause())
  await expect.poll(async () => (await player()).paused, { timeout: 10_000, intervals: [250] }).toBe(true)

  const result = await page.evaluate(() => (window as unknown as { player: ReturnType<Window['mediaPlayer']> }).player.autoplay())
  expect(result, 'it must say whether sound survived, whichever way it went').toHaveProperty('muted')
  expect((await player()).paused, 'and the far player must actually be running').toBe(false)
  expect((await player()).muted).toBe(result.muted)

  // the clock moves, which is the only proof that "playing" means playing
  const before = (await player()).time
  await expect.poll(async () => (await player()).time, { timeout: 30_000, intervals: [500] }).toBeGreaterThan(before + 0.5)
})
