// Drives a real watch URL in a real browser and reports whether it downloads, plays, and lays out.
//
//   node tests/live-watch.mjs '<url>' [outPrefix]
//
// Not a playwright spec, and deliberately not named like one: it points at deployed sites rather than
// at a build, so it is a hand-run check after a deploy, not part of `test:e2e`.
//
// HEADFUL IS NOT A PREFERENCE (agent/conventions/hard-rules.md). In headless Chromium the engine
// reaches "Loading metadata…" and sits at a flat 0 B/s forever in every topology, which is also the
// exact symptom this script is usually run to diagnose, so a headless run cannot tell a fix from the
// bug. The same run headful downloads at ~10 MB/s.
//
// The install prompt is the other trap: stub asks "Add source" before mounting a package shared by
// link, and a fresh profile that never clicks it sees no tenant frames at all, which reads as a mount
// failure and is not one.

import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const URL_UNDER_TEST = process.argv[2]
const OUT = process.argv[3]
const WATCH_MS = Number(process.env.WATCH_MS ?? 150_000)
const VIEWPORT = { width: 1600, height: 900 }

if (!URL_UNDER_TEST) {
  console.error('usage: node tests/live-watch.mjs <url> [outPrefix]')
  process.exit(2)
}

const browser = await chromium.launch({
  headless: false,
  executablePath: process.env.RIPPLE_CHROME || undefined,
})
const context = await browser.newContext({ viewport: VIEWPORT })
const page = await context.newPage()

const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 240)))

await page.goto(URL_UNDER_TEST, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  .catch((e) => errors.push('goto: ' + e.message))

// "Add source" first: the longer forms are listed before "add" so the exact-match alternation cannot
// settle for a bare "Add" button elsewhere on the page.
const ACCEPT = /^(add source|add this source|add|install|accept|confirm|continue|yes|allow)$/i
const clickPrompt = async () => {
  for (const frame of page.frames()) {
    try {
      for (const button of await frame.$$('button, [role="button"], a')) {
        const text = ((await button.innerText().catch(() => '')) || '').trim()
        if (!ACCEPT.test(text)) continue
        await button.click({ timeout: 2000 }).catch(() => {})
        return text
      }
    } catch {}
  }
  return null
}

const embedFrame = () => page.frames().find((f) => f.url().includes('/embed'))

const clicked = []
for (let i = 0; i < 12; i++) {
  const hit = await clickPrompt()
  if (hit) clicked.push(hit)
  await page.waitForTimeout(2500)
  if (embedFrame()) break
}

/** what the player reports about itself, read from its own document */
const sample = async () => {
  const frame = embedFrame()
  if (!frame) return { embed: false }
  return frame.evaluate(() => {
    const video = document.querySelector('video')
    let buffered = 0
    if (video) {
      for (let i = 0; i < video.buffered.length; i++) buffered += video.buffered.end(i) - video.buffered.start(i)
    }
    return {
      embed: true,
      text: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 160) ?? '',
      currentTime: video ? Number(video.currentTime.toFixed(2)) : null,
      duration: video && Number.isFinite(video.duration) ? Number(video.duration.toFixed(1)) : null,
      readyState: video?.readyState ?? null,
      paused: video?.paused ?? null,
      bufferedSeconds: Number(buffered.toFixed(2)),
    }
  }).catch((error) => ({ embed: true, evalError: String(error).slice(0, 120) }))
}

const samples = []
const started = Date.now()
while (Date.now() - started < WATCH_MS) {
  const s = await sample()
  samples.push({ atMs: Date.now() - started, ...s })
  if ((s.currentTime ?? 0) > 1) break
  await page.waitForTimeout(5000)
}

/**
 * Where things actually sit, per frame, from the deepest player node up to <html>.
 *
 * The chain is what catches an inset the player cannot see from inside: the frame it was given can be
 * smaller than the document that holds it, and both look correct measured on their own.
 */
const describe = () => {
  const rect = (element) => {
    if (!element) return null
    const box = element.getBoundingClientRect()
    const computed = getComputedStyle(element)
    return {
      tag: element.tagName.toLowerCase(),
      cls: (element.className?.baseVal ?? element.className ?? '').toString().slice(0, 70),
      x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height),
      pad: computed.padding, margin: computed.margin, pos: computed.position,
    }
  }
  const out = { url: location.href, viewport: { w: innerWidth, h: innerHeight }, chain: [] }
  let node = document.querySelector('video') ?? document.querySelector('[class*="video"]') ?? document.body.firstElementChild
  while (node) { out.chain.push(rect(node)); node = node.parentElement }
  out.iframes = [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src.slice(0, 80), ...rect(f) }))
  // the two the player owns, so a regression in either is named rather than merely visible
  const bar = document.querySelector('.app-slot')?.parentElement
  out.topBar = bar
    ? { ...rect(bar), visibility: getComputedStyle(bar).visibility, opacity: getComputedStyle(bar).opacity }
    : null
  out.title = document.querySelector('.title')?.textContent ?? null
  return out
}

const layout = []
for (const frame of page.frames()) {
  const info = await frame.evaluate(describe).catch((e) => ({ error: String(e).slice(0, 120) }))
  layout.push({ frameUrl: frame.url().slice(0, 110), ...info })
}

const played = samples.some((s) => (s.currentTime ?? 0) > 0.5)
const report = {
  clickedPrompts: clicked,
  played,
  firstPlayAtMs: samples.find((s) => (s.currentTime ?? 0) > 0.5)?.atMs ?? null,
  last: samples[samples.length - 1] ?? {},
  timeline: samples
    .filter((_, i) => i % 3 === 0)
    .map((s) => ({ atMs: s.atMs, t: s.currentTime, buf: s.bufferedSeconds, text: (s.text ?? '').slice(0, 70) })),
  layout,
  errors: errors.slice(0, 6),
}

if (OUT) {
  writeFileSync(`${OUT}.json`, JSON.stringify(report, null, 1))
  // Wake the chrome first, and only after the layout pass above has recorded whether it had hidden
  // itself. By this point the pointer has been still for the whole watch, so an unprompted screenshot
  // catches a bare video and shows nothing about the controls, the title or the app's readout.
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
  await page.mouse.move(VIEWPORT.width / 2 + 8, VIEWPORT.height / 2 + 8)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}.png` })
}
console.log(JSON.stringify(report, null, 1))

await browser.close()
process.exit(played ? 0 : 1)
