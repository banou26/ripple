/**
 * Is the storage headroom an origin reports ELASTIC?
 *
 * `scripts/probe-eviction.mjs` found that on Chromium `quota - usage` did not move by a single byte
 * while 3.5 GB of padding was written: the quota rose by exactly what was written. If that holds,
 * the pressure half of the eviction budget can never fire there, and neither can the "Out of storage
 * space" notice, because both are `limit - used < floor` against a difference that is a constant.
 *
 * This measures it on both engines, three writes each, so the answer is a slope rather than a pair.
 * storage-relief.ts records "the browser's budget is a flat cap ... exactly 10 GiB", measured at low
 * usage where a flat QUOTA and a flat HEADROOM look identical. This tells them apart.
 *
 * THE OBVIOUS WAY ROUND IT DOES NOT WORK, and was measured rather than assumed. CDP's
 * `Storage.overrideQuotaForOrigin` is accepted, `Storage.getUsageAndQuota` then answers
 * `overrideActive: true` with the overridden 419,430,400, and writes past that limit really are
 * refused with `QuotaExceededError`. But `navigator.storage.estimate()` in the page goes on
 * reporting the elastic figure, and estimate() is what the product reads. Enforcement the page
 * cannot observe is no use to a test whose subject reads the observable.
 *
 * Firefox needs its own binary here, and Playwright's own download does not work on NixOS. Point
 * RIPPLE_FIREFOX at the store copy, the way RIPPLE_CHROME already works:
 *
 *   RIPPLE_FIREFOX=$PLAYWRIGHT_BROWSERS_PATH/firefox-1532/firefox/firefox \
 *     RIPPLE_CHROME=$(which google-chrome-stable) node scripts/probe-headroom.mjs
 */
import { spawn } from 'node:child_process'
import { chromium, firefox } from 'playwright'

const PORT = process.env.RIPPLE_PROBE_PORT || '4595'
const BASE = `http://127.0.0.1:${PORT}`
const gb = (n) => (n / 1e9).toFixed(3) + ' GB'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const serve = spawn('npx', ['serve', '-s', '-C', '-p', PORT, 'build'], { stdio: 'ignore' })
process.on('exit', () => { try { serve.kill('SIGTERM') } catch {} })
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break } catch {} await sleep(500) }

const est = (p) => p.evaluate(async () => { const e = await navigator.storage.estimate(); return { used: e.usage ?? 0, quota: e.quota ?? 0 } })

/** One sparse chunk. Firefox has no createSyncAccessHandle in a page, so this uses createWritable. */
const pad = (p, name, size) => p.evaluate(async ([n, s]) => {
  try {
    const root = await navigator.storage.getDirectory()
    const file = await root.getFileHandle(n, { create: true })
    const w = await file.createWritable()
    await w.write({ type: 'write', position: s - 1, data: new Uint8Array(1) })
    await w.close()
    return { ok: true, size: (await file.getFile()).size }
  } catch (err) { return { error: String(err) } }
}, [name, size])

const measure = async (name, launcher, opts) => {
  console.log(`\n=== ${name} ===`)
  let browser
  try { browser = await launcher.launch(opts) } catch (e) { console.log('  could not launch:', String(e).split('\n')[0]); return null }
  const page = await browser.newPage()
  await page.goto(`${BASE}/embed`)
  const rows = []
  let prev = await est(page)
  rows.push({ step: 'start', ...prev, free: prev.quota - prev.used })
  console.log(`  start        used ${gb(prev.used)} quota ${gb(prev.quota)} free ${gb(prev.quota - prev.used)}`)
  for (let i = 0; i < 3; i++) {
    const wrote = await pad(page, `headroom-${i}.bin`, 512 * 1024 * 1024)
    await sleep(1500)
    const now = await est(page)
    const dFree = (now.quota - now.used) - (prev.quota - prev.used)
    rows.push({ step: `+512MiB #${i}`, ...now, free: now.quota - now.used, dFree })
    console.log(`  +512MiB #${i}  used ${gb(now.used)} quota ${gb(now.quota)} free ${gb(now.quota - now.used)}  dFree ${dFree} ${wrote.error ? '(' + wrote.error.slice(0, 60) + ')' : ''}`)
    prev = now
  }
  const first = rows[0], last = rows[rows.length - 1]
  const usedDelta = last.used - first.used
  const freeDelta = last.free - first.free
  // elastic = the headroom did not follow the bytes down
  const elastic = usedDelta > 100_000_000 && Math.abs(freeDelta) < usedDelta * 0.25
  console.log(`  => wrote ${gb(usedDelta)}, headroom moved ${freeDelta} bytes => ${elastic ? 'ELASTIC (a squeeze cannot work)' : 'FIXED (a squeeze works)'}`)
  await browser.close()
  return { engine: name, usedDelta, freeDelta, elastic, quotaStart: first.quota, freeStart: first.free }
}

const out = []
out.push(await measure('chromium', chromium, { headless: true, executablePath: process.env.RIPPLE_CHROME || undefined, args: ['--mute-audio'] }))
out.push(await measure('firefox', firefox, { headless: true, executablePath: process.env.RIPPLE_FIREFOX || undefined, firefoxUserPrefs: { 'media.volume_scale': '0.0' } }))
console.log('\n=== VERDICT ===')
console.log(JSON.stringify(out.filter(Boolean), null, 1))
process.exit(0)
