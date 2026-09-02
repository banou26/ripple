/**
 * What a real download actually spends, split by direction.
 *
 * The question this answers: a 1.78 GB torrent charged 2.6 GB of anonymous FKN allowance, and the
 * code says the relay meters BOTH directions into one counter (webvpn tcp_socket.rs:289 and :317).
 * That is a hypothesis until something measures it, so this drives a real torrent through a real
 * relay and reads three numbers the engine already keeps:
 *
 *   downloaded  libtorrent's all_time_download, wire bytes in
 *   uploaded    all_time_upload, wire bytes out, the term under test
 *   wasted      total_failed_bytes + total_redundant_bytes, bytes paid for and thrown away
 *
 * and, separately, the allowance readout itself, captured off the quota response so it is exact
 * rather than the humanized figure on screen.
 *
 * HEADFUL on purpose: in headless Chromium the engine reaches "Loading metadata" and sits at a flat
 * 0 B/s forever while its data plane is provably healthy, so a headless run measures nothing at all.
 * Run it under xvfb so it costs no screen:
 *
 *   RIPPLE_CHROME=$(which google-chrome) \
 *     xvfb-run -s "-screen 0 1280x720x24" node scripts/measure-allowance.mjs '<magnet>'
 *
 * Muted, like every browser this repo launches.
 *
 * The demo torrent is suppressed before the app boots. A first run auto-adds 129 MB of Sintel, and
 * leaving that in would land in the allowance delta as if it were this torrent's.
 */

import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const MAGNET = process.argv[2]
if (!MAGNET) {
  console.error('usage: node scripts/measure-allowance.mjs "<magnet>"')
  process.exit(1)
}

const PORT = process.env.RIPPLE_MEASURE_PORT || '4599'
const CAP_MS = Number(process.env.RIPPLE_MEASURE_CAP_MS ?? 25 * 60_000)
const EVERY_MS = 10_000
const DEMO_SEEDED_KEY = 'ripple:demo-seeded'

const mb = (n) => (n == null ? '-' : (n / 1e6).toFixed(1).padStart(8) + ' MB')
const mbNode = (n) => (n == null ? '-' : (n / 1e6).toFixed(1) + ' MB')
const pct = (n) => (n == null ? '-' : (n * 100).toFixed(1).padStart(5) + '%')

const serve = spawn('npx', ['serve', '-s', '-C', '-p', PORT, 'build'], { stdio: 'ignore' })
const stopServer = () => { try { serve.kill('SIGTERM') } catch {} }
process.on('exit', stopServer)

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('static server never came up')
}

const main = async () => {
  await waitForServer()

  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.RIPPLE_CHROME || undefined,
    args: ['--mute-audio', '--enable-experimental-web-platform-features'],
  })
  const context = await browser.newContext()

  // Suppress the first-run demo add, and install the worker tap before any app code runs.
  await context.addInitScript((key) => {
    try { localStorage.setItem(key, '1') } catch {}
    const root = window
    root.__measure = { byMagnet: {}, quota: null }
    const Native = window.Worker
    window.Worker = function (url, options) {
      const worker = new Native(url, options)
      worker.addEventListener('message', (event) => {
        const message = event.data
        if (!message || message.type !== 'state' || !Array.isArray(message.torrents)) return
        for (const t of message.torrents) {
          if (!t?.magnet) continue
          root.__measure.byMagnet[t.magnet] = {
            at: Date.now(),
            status: t.status ?? null,
            totals: t.totals ?? null,
            files: t.files ? { total: t.files.length ?? null } : null,
          }
        }
      })
      return worker
    }
    window.Worker.prototype = Native.prototype
  }, DEMO_SEEDED_KEY)

  const page = await context.newPage()

  /*
   * The allowance, exact.
   *
   * The readout on screen is humanized to one decimal, so a 2.6 GB reading there is worth plus or
   * minus 50 MB, which is the same order as several of the terms being weighed. The quota response
   * carries the byte counts, so it is read off the wire instead. Any frame's response counts: the
   * query is issued by the broker document, not by ripple itself.
   */
  page.on('response', async (res) => {
    try {
      const type = res.headers()['content-type'] || ''
      if (!type.includes('json')) return
      const body = await res.json().catch(() => null)
      const q = body?.data?.quota ?? body?.data?.sessionQuota
      if (!q || typeof q.usedBytes !== 'number') return
      await page.evaluate((quota) => { window.__measure.quota = quota }, q)
    } catch {}
  })

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' })
  await page.getByPlaceholder('Add a magnet link').waitFor({ timeout: 60_000 })

  const first = await page.evaluate(() => window.__measure.quota)
  console.log('quota at start:', first ? `${mbNode(first.usedBytes)} used, ${mbNode(first.remaining)} left` : '(not seen yet)')

  await page.getByPlaceholder('Add a magnet link').fill(MAGNET)
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  const started = Date.now()
  let baseline = first ? first.usedBytes : null
  let last = null

  console.log('')
  console.log('   t    progress     downloaded       uploaded         wasted    down    up  peers  allowance used')
  console.log('  ---  ---------  -------------  -------------  -------------  ------  ----  -----  --------------')

  while (Date.now() - started < CAP_MS) {
    await new Promise((r) => setTimeout(r, EVERY_MS))
    const sample = await page.evaluate((magnet) => {
      const entry = window.__measure.byMagnet[magnet]
        ?? Object.values(window.__measure.byMagnet).find((e) => e.status)
      return { entry: entry ?? null, quota: window.__measure.quota }
    }, MAGNET)

    if (sample.quota && baseline == null) baseline = sample.quota.usedBytes
    const s = sample.entry?.status
    if (!s) { console.log('  waiting for metadata...'); continue }
    last = sample

    const t = Math.round((Date.now() - started) / 1000)
    const spent = sample.quota && baseline != null ? sample.quota.usedBytes - baseline : null
    console.log(
      `  ${String(t).padStart(3)}s ${pct(s.progress)}  ${mb(s.allTimeDownload)}  ${mb(s.allTimeUpload)}`
      + `  ${mb(s.wasted)}  ${(s.downloadRate / 1e6).toFixed(1).padStart(4)}M ${(s.uploadRate / 1e6).toFixed(1).padStart(4)}M`
      + `  ${String(s.numPeers ?? '-').padStart(4)}  ${spent == null ? '(none)' : mb(spent)}`,
    )

    if (s.progress >= 1) { console.log('\n  complete'); break }
  }

  if (last?.entry?.status) {
    const s = last.entry.status
    const down = s.allTimeDownload ?? 0
    const up = s.allTimeUpload ?? 0
    const spent = last.quota && baseline != null ? last.quota.usedBytes - baseline : null
    console.log('')
    console.log('SUMMARY')
    console.log(`  payload on disk       ${mb(s.totalDone)}`)
    console.log(`  downloaded (wire)     ${mb(down)}`)
    console.log(`  uploaded (wire)       ${mb(up)}`)
    console.log(`  wasted                ${mb(s.wasted)}`)
    console.log(`  down + up             ${mb(down + up)}`)
    console.log(`  allowance spent       ${spent == null ? '(quota never seen)' : mb(spent)}`)
    console.log(`  share ratio           ${down > 0 ? (up / down).toFixed(3) : '-'}`)
    console.log(`  full status keys      ${Object.keys(s).join(', ')}`)
  } else {
    console.log('\nno status was ever sampled')
  }

  await context.close()
  await browser.close()
  stopServer()
}

main().catch((err) => { console.error(err); stopServer(); process.exit(1) })
