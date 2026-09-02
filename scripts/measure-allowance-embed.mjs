/**
 * The same measurement as `measure-allowance.mjs`, but through the DOWNLOAD PAGE.
 *
 * Why a second rig rather than a flag: the two paths ask the engine for the same bytes in very
 * different ways, and only this one drives an export. `save-file.ts` reads the file in 8 MiB chunks
 * and every chunk re-anchors the viewer, `applyViewing` calls `setStreamWindow`, and that clears
 * every piece deadline before writing the new ladder. Emptying libtorrent's time-critical set is
 * what makes the next `set_piece_deadline` post `cancel_non_critical` (torrent.cpp:5289), which
 * force-cancels outstanding requests on every peer. So a 1.4 GB export fires roughly 170 of those
 * and a 1.4 GB library download fires none.
 *
 * The library path measured 1.4% over payload end to end, so if the export path is materially worse
 * the difference lands in `wasted` and in the allowance delta, and this is what shows it.
 *
 * The allowance is read from the api directly, before and after, because it is the number under
 * dispute and the in-page poll proved unreliable to capture.
 *
 *   RIPPLE_CHROME=$(which google-chrome) \
 *     xvfb-run -s "-screen 0 1280x720x24" node scripts/measure-allowance-embed.mjs '<magnet>'
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const MAGNET = process.argv[2]
if (!MAGNET) {
  console.error('usage: node scripts/measure-allowance-embed.mjs "<magnet>"')
  process.exit(1)
}

const PORT = process.env.RIPPLE_MEASURE_PORT || '4771'
const CAP_MS = Number(process.env.RIPPLE_MEASURE_CAP_MS ?? 25 * 60_000)
const EVERY_MS = 10_000
const DEMO_SEEDED_KEY = 'ripple:demo-seeded'
const QUOTA = 'https://api.fkn.app/graphql'

const mb = (n) => (n == null ? '-' : (n / 1e6).toFixed(1).padStart(8) + ' MB')
const pct = (n) => (n == null ? '-' : (n * 100).toFixed(1).padStart(5) + '%')

const readQuota = async () => {
  const res = await fetch(QUOTA, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ quota { usedBytes remaining limitBytes overQuota } }' }),
  })
  const body = await res.json()
  return body?.data?.quota ?? null
}

const serve = spawn('npx', ['serve', '-s', '-C', '-p', PORT, 'build'], { stdio: 'ignore' })
const stopServer = () => { try { serve.kill('SIGTERM') } catch {} }
process.on('exit', stopServer)

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('static server never came up')
}

const main = async () => {
  await waitForServer()

  const before = await readQuota()
  console.log(`allowance before: ${mb(before?.usedBytes)} used, ${mb(before?.remaining)} left`)

  const downloads = mkdtempSync(join(tmpdir(), 'ripple-measure-'))
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.RIPPLE_CHROME || undefined,
    args: ['--mute-audio', '--enable-experimental-web-platform-features'],
  })
  const context = await browser.newContext({ acceptDownloads: true })

  await context.addInitScript((key) => {
    try { localStorage.setItem(key, '1') } catch {}
    // Chromium offers showSaveFilePicker, which opens a native dialog nothing here can answer.
    // Removing it forces the service worker sink, which is the arm an embedded page takes anyway.
    delete window.showSaveFilePicker
    const root = window
    root.__measure = { byMagnet: {} }
    const Native = window.Worker
    window.Worker = function (url, options) {
      const worker = new Native(url, options)
      worker.addEventListener('message', (event) => {
        const message = event.data
        if (!message || message.type !== 'state' || !Array.isArray(message.torrents)) return
        for (const t of message.torrents) {
          if (!t?.magnet || !t.status) continue
          root.__measure.byMagnet[t.magnet] = { at: Date.now(), status: t.status }
        }
      })
      return worker
    }
    window.Worker.prototype = Native.prototype
  }, DEMO_SEEDED_KEY)

  const page = await context.newPage()
  const extra = process.env.RIPPLE_MEASURE_PARAMS ? `&${process.env.RIPPLE_MEASURE_PARAMS}` : ''
  const url = `http://127.0.0.1:${PORT}/embed?magnet=${Buffer.from(MAGNET).toString('base64')}&mode=download${extra}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 60_000 })

  // a multi-file torrent labels it "Download N files as .zip", so match the prefix rather than the word
  const button = page.getByRole('button', { name: /^Download/ }).first()
  await button.waitFor({ state: 'visible', timeout: 120_000 })
  for (let i = 0; i < 120 && !(await button.isEnabled()); i++) await new Promise((r) => setTimeout(r, 1000))

  const downloadPromise = page.waitForEvent('download', { timeout: CAP_MS })
  await button.click()

  const started = Date.now()
  let last = null
  console.log('')
  console.log('   t    progress     downloaded       uploaded         wasted    down  peers')
  console.log('  ---  ---------  -------------  -------------  -------------  ------  -----')

  let done = false
  const finish = downloadPromise.then((d) => { done = true; return d }).catch(() => null)

  while (Date.now() - started < CAP_MS && !done) {
    await new Promise((r) => setTimeout(r, EVERY_MS))
    const entry = await page.evaluate(() => {
      const all = Object.values(window.__measure.byMagnet).filter((e) => e.status)
      return all.length ? all[all.length - 1] : null
    }).catch(() => null)
    if (!entry?.status) { console.log('  waiting for metadata...'); continue }
    last = entry
    const s = entry.status
    const t = Math.round((Date.now() - started) / 1000)
    console.log(
      `  ${String(t).padStart(3)}s ${pct(s.progress)}  ${mb(s.allTimeDownload)}  ${mb(s.allTimeUpload)}`
      + `  ${mb(s.wasted)}  ${(s.downloadRate / 1e6).toFixed(1).padStart(4)}M  ${String(s.numPeers ?? '-').padStart(4)}`,
    )
  }

  const download = await finish
  if (download) {
    // the bytes are not the measurement; the counters are. Delete rather than keep 1.4 GB.
    const path = await download.path().catch(() => null)
    console.log(`\n  download event fired: ${download.suggestedFilename()}`)
    if (path) { try { rmSync(path, { force: true }) } catch {} }
  } else {
    console.log('\n  no download event within the cap')
  }

  // one last sample after the export settles, so post-completion work is included
  await new Promise((r) => setTimeout(r, 5_000))
  const finalEntry = await page.evaluate(() => {
    const all = Object.values(window.__measure.byMagnet).filter((e) => e.status)
    return all.length ? all[all.length - 1] : null
  }).catch(() => null)
  if (finalEntry?.status) last = finalEntry

  await context.close()
  await browser.close()
  try { rmSync(downloads, { recursive: true, force: true }) } catch {}

  // the relay reconciles on a ticker, so give the usage row a moment to catch up
  await new Promise((r) => setTimeout(r, 20_000))
  const after = await readQuota()

  const s = last?.status
  const down = s?.allTimeDownload ?? 0
  const up = s?.allTimeUpload ?? 0
  const spent = before && after ? after.usedBytes - before.usedBytes : null

  console.log('')
  console.log('SUMMARY (download page / export path)')
  console.log(`  payload on disk       ${mb(s?.totalDone)}`)
  console.log(`  downloaded (wire)     ${mb(down)}`)
  console.log(`  uploaded (wire)       ${mb(up)}`)
  console.log(`  wasted                ${mb(s?.wasted)}`)
  console.log(`  allowance before      ${mb(before?.usedBytes)}`)
  console.log(`  allowance after       ${mb(after?.usedBytes)}`)
  console.log(`  allowance spent       ${spent == null ? '(unavailable)' : mb(spent)}`)
  if (spent != null && s?.totalDone) {
    console.log(`  charged / payload     ${(spent / s.totalDone).toFixed(3)}x`)
  }
  stopServer()
}

main().catch((err) => { console.error(err); stopServer(); process.exit(1) })
