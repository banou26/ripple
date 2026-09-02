/**
 * What the storage budget pass actually does when the origin is full.
 *
 * Four tests in `tests/storage-eviction.spec.ts` are `test.fixme` because two opposite explanations
 * fit the evidence equally: the budget pass THROWS somewhere and never reaches its decision, or it
 * COMPLETES and concludes there is room. Those have opposite fixes, so guessing costs a day.
 *
 * This settles it by watching the pass rather than its aftermath, and it is written so that a
 * negative result is worth something:
 *
 *  - the Worker probe is proven able to see a message BEFORE any conclusion is drawn from silence
 *    (`control.sawWorkerMessage`), because a probe that cannot see reports "no eviction" whatever
 *    the engine does, which is exactly one of the ways these tests could have been failing all along
 *  - the squeeze REPORTS what it achieved and says when it fell short, rather than returning an
 *    estimate that happens to be whatever it started at. The spec's own `squeezeTo` gives up after
 *    64 chunks of 256 MiB with no error, so on an origin needing more than 16 GiB of padding every
 *    assertion after it measures an origin under no pressure at all
 *
 * HEADFUL, because headless Chromium reaches "Loading metadata" and sits at a flat 0 B/s forever.
 * Run it under Xvfb so it costs no screen:
 *
 *   RIPPLE_CHROME=$(which google-chrome-stable) \
 *     xvfb-run -a -s "-screen 0 1280x720x24" node scripts/probe-eviction.mjs
 *
 * Muted, like every browser this repo launches.
 */

import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const PORT = process.env.RIPPLE_PROBE_PORT || '4598'
const BASE = `http://127.0.0.1:${PORT}`

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const SINTEL_HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
const SINTEL_VIDEO = 5

const mb = (n) => (n == null ? '-' : (n / 1e6).toFixed(1) + ' MB')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const serve = spawn('npx', ['serve', '-s', '-C', '-p', PORT, 'build'], { stdio: 'ignore' })
const stopServer = () => { try { serve.kill('SIGTERM') } catch {} }
process.on('exit', stopServer)

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/')).ok) return } catch {}
    await sleep(500)
  }
  throw new Error('static server never came up')
}

const estimate = (page) => page.evaluate(async () => {
  const e = await navigator.storage.estimate()
  return { used: e.usage ?? 0, quota: e.quota ?? 0 }
})

const filesUnder = (page, path) => page.evaluate(async (target) => {
  let dir = await navigator.storage.getDirectory()
  for (const segment of target.split('/').filter(Boolean)) {
    const next = await dir.getDirectoryHandle(segment).catch(() => null)
    if (!next) return { count: 0, bytes: 0 }
    dir = next
  }
  const walk = async (handle) => {
    let count = 0
    let bytes = 0
    for await (const child of handle.values()) {
      if (child.kind !== 'file') {
        const inner = await walk(child)
        count += inner.count
        bytes += inner.bytes
        continue
      }
      count += 1
      bytes += await child.getFile().then((f) => f.size).catch(() => 0)
    }
    return { count, bytes }
  }
  return walk(dir)
}, path)

/** One sparse chunk of padding, written from a worker so a sync access handle is available. */
const pad = (page, name, size) => page.evaluate(async ([n, s]) => {
  const code = `self.onmessage = async (e) => {
    const [name, size] = e.data
    try {
      const root = await navigator.storage.getDirectory()
      const file = await root.getFileHandle(name, { create: true })
      const handle = await file.createSyncAccessHandle()
      const wrote = handle.write(new Uint8Array(1), { at: size - 1 })
      handle.flush()
      const got = handle.getSize()
      handle.close()
      postMessage({ wrote, got })
    } catch (err) { postMessage({ error: String(err) }) }
  }`
  const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })))
  const result = await new Promise((resolve) => {
    worker.onmessage = (e) => resolve(e.data)
    worker.postMessage([n, s])
  })
  worker.terminate()
  return result
}, [name, size])

/**
 * Charge the origin down to `freeBytes`, and SAY whether it got there.
 *
 * The version in the spec returns silently after 64 chunks whatever it achieved. This one keeps
 * going while it is still making progress and reports the shortfall, because "the padding stopped
 * landing" and "the origin is squeezed" are the two answers and only one of them means anything
 * about the code under test.
 */
const squeezeTo = async (page, freeBytes) => {
  const CHUNK = 256 * 1024 * 1024
  let chunk = 0
  let stalled = 0
  for (; chunk < 512; chunk++) {
    const before = await estimate(page)
    const want = before.quota - before.used - freeBytes
    if (want <= 0) return { ...before, reached: true, chunks: chunk }
    const result = await pad(page, `ripple-probe-padding-${chunk}.bin`, Math.min(want, CHUNK))
    const after = await estimate(page)
    if (after.used <= before.used) {
      stalled++
      console.log(`  [squeeze] chunk ${chunk} did not land`, JSON.stringify(result), JSON.stringify({ before, after }))
      if (stalled >= 3) {
        const free = after.quota - after.used
        return { ...after, reached: free <= freeBytes, chunks: chunk, stalled: true, shortBy: free - freeBytes }
      }
      continue
    }
    stalled = 0
  }
  const final = await estimate(page)
  return { ...final, reached: false, chunks: chunk, exhausted: true, shortBy: final.quota - final.used - freeBytes }
}

const run = async () => {
  await waitForServer()
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.RIPPLE_CHROME || undefined,
    args: ['--enable-experimental-web-platform-features', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  })
  const context = await browser.newContext()

  // Everything the engine worker says, and everything it is told, with a control that proves the
  // probe is wired at all. `window.Worker` is what client.ts:254 constructs, so a leader tab sees
  // its own engine here; a follower tab constructs no Worker and would legitimately see nothing.
  const seen = []
  await context.exposeBinding('__probe', (_source, event) => { seen.push({ at: Date.now(), ...event }) })
  await context.addInitScript(() => {
    const Original = window.Worker
    class Probe extends Original {
      constructor(url, options) {
        super(url, options)
        const href = String(url)
        window.__probe({ kind: 'construct', url: href })
        this.addEventListener('message', (event) => {
          const data = event?.data
          if (!data || typeof data !== 'object') return
          const type = data.type
          if (type === 'state') { window.__probe({ kind: 'msg', type: 'state' }); return }
          window.__probe({ kind: 'msg', type, detail: JSON.stringify(data).slice(0, 800) })
        })
        this.addEventListener('error', (event) => {
          window.__probe({ kind: 'worker-onerror', detail: String(event?.message ?? event) })
        })
      }
    }
    window.Worker = Probe
  })

  const page = await context.newPage()
  const consoleLines = []
  page.on('console', (m) => {
    const text = m.text()
    consoleLines.push(`[${m.type()}] ${text}`)
    if (/budget|storage|evict|quota|sweep/i.test(text)) console.log('  [page]', text.slice(0, 400))
  })
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 400)))

  console.log('--- 1. open the player and write some bytes ---')
  await page.goto(`${BASE}/embed?magnet=${Buffer.from(SINTEL).toString('base64')}&fileIndex=${SINTEL_VIDEO}`)
  const baseline = (await estimate(page)).used
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const now = await estimate(page)
    if (now.used - baseline > 30_000_000) break
    await sleep(2_000)
  }
  const afterDownload = await estimate(page)
  console.log('  used', mb(afterDownload.used), 'of quota', mb(afterDownload.quota))

  // CHECK THE CHECKER, before any silence is read as a result
  const control = {
    sawConstruct: seen.some((e) => e.kind === 'construct'),
    sawWorkerMessage: seen.some((e) => e.kind === 'msg'),
    workersConstructed: seen.filter((e) => e.kind === 'construct').map((e) => e.url),
    messageTypes: [...new Set(seen.filter((e) => e.kind === 'msg').map((e) => e.type))],
  }
  console.log('  CONTROL', JSON.stringify(control, null, 1))
  if (!control.sawWorkerMessage) {
    console.log('\n!!! the probe never saw a single worker message, so nothing below is evidence about the engine.')
  }

  console.log('\n--- 2. leave the player, so nobody is watching ---')
  await page.goto(`${BASE}/`)
  await page.waitForSelector('.torrent', { timeout: 60_000 }).catch(() => {})
  const savePath = '/dl/' + SINTEL_HASH
  const held = await filesUnder(page, savePath)
  console.log('  torrent holds', held.count, 'files,', mb(held.bytes))

  console.log('\n--- 3. squeeze the origin ---')
  const target = 60_000_000
  const squeezed = await squeezeTo(page, target)
  console.log('  squeeze:', JSON.stringify({
    reached: squeezed.reached,
    chunks: squeezed.chunks,
    used: mb(squeezed.used),
    quota: mb(squeezed.quota),
    free: mb(squeezed.quota - squeezed.used),
    target: mb(target),
    shortBy: squeezed.shortBy == null ? undefined : mb(squeezed.shortBy),
    stalled: squeezed.stalled,
    exhausted: squeezed.exhausted,
  }))
  if (!squeezed.reached) {
    console.log('  !!! the origin is NOT squeezed. Anything below is measuring an origin under no pressure.')
  }

  console.log('\n--- 4. watch the budget pass for 60s ---')
  const mark = seen.length
  for (let i = 0; i < 12; i++) {
    await sleep(5_000)
    const now = await estimate(page)
    const files = await filesUnder(page, savePath)
    console.log(`  t+${(i + 1) * 5}s used ${mb(now.used)} free ${mb(now.quota - now.used)} files ${files.count}`)
  }

  const during = seen.slice(mark)
  const interesting = during.filter((e) => e.kind !== 'msg' || e.type !== 'state')
  console.log('\n--- 5. what the engine said while squeezed ---')
  for (const event of interesting) console.log(' ', JSON.stringify(event).slice(0, 700))
  if (!interesting.length) console.log('  (nothing but state ticks)')

  const workerErrors = consoleLines.filter((l) => /\[worker\]/.test(l))
  console.log('\n--- 6. worker console lines ---')
  for (const line of workerErrors.slice(-60)) console.log(' ', line.slice(0, 400))
  if (!workerErrors.length) console.log('  (none)')

  const finalFiles = await filesUnder(page, savePath)
  const finalSpace = await estimate(page)
  console.log('\n=== VERDICT INPUTS ===')
  console.log(JSON.stringify({
    probeWired: control.sawWorkerMessage,
    squeezeReached: squeezed.reached,
    freeAfterSqueeze: squeezed.quota - squeezed.used,
    evictionFloor: Math.min(1_000_000_000, Math.floor(finalSpace.quota * 0.1)),
    storageFullPosts: seen.filter((e) => e.type === 'storage-full').map((e) => e.detail),
    filesBefore: held.count,
    filesAfter: finalFiles.count,
    freeAtEnd: finalSpace.quota - finalSpace.used,
  }, null, 1))

  await context.close()
  await browser.close()
  stopServer()
}

run().catch((err) => { console.error(err); stopServer(); process.exit(1) })
