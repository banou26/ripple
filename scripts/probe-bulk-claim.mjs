/**
 * Does the DEPLOYED download page actually claim its torrent as bulk?
 *
 * The byte-level proof that this is worth 61% needs a full download and an unthrottled allowance.
 * This is the other half, and it costs about 2 kB: it drives the real deployment, taps the messages
 * the page posts TO the engine worker, and reads the claim off the wire.
 *
 * What a pass establishes, and what it does not. It establishes that production's page code takes
 * the bulk path at runtime rather than merely containing it, which is the thing a bundle grep cannot
 * tell you. It does NOT measure any bytes; the engine's side of the bargain is established
 * separately by the `deadlines!==!1` guard being present in the deployed worker chunk.
 *
 * A Sintel subtitle is the subject because it is roughly 1.5 kB, so this is affordable even against
 * an exhausted allowance.
 *
 *   RIPPLE_CHROME=$(which google-chrome) \
 *     xvfb-run -s "-screen 0 1280x720x24" node scripts/probe-bulk-claim.mjs
 */

import { chromium } from 'playwright'

const ORIGIN = process.env.RIPPLE_PROBE_ORIGIN || 'https://torrent.fkn.app'
const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const SUBTITLE = 0

const main = async () => {
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.RIPPLE_CHROME || undefined,
    args: ['--mute-audio', '--enable-experimental-web-platform-features'],
  })
  const context = await browser.newContext({ acceptDownloads: true })

  await context.addInitScript(() => {
    delete window.showSaveFilePicker
    const root = window
    root.__sent = []
    const Native = window.Worker
    window.Worker = function (url, options) {
      const worker = new Native(url, options)
      const post = worker.postMessage.bind(worker)
      worker.postMessage = (message, transfer) => {
        // record the shape only: `bytes` on an add is a whole .torrent and reads carry payload
        if (message && typeof message === 'object' && typeof message.type === 'string') {
          const { bytes, data, ...rest } = message
          root.__sent.push(rest)
        }
        return transfer === undefined ? post(message) : post(message, transfer)
      }
      return worker
    }
    window.Worker.prototype = Native.prototype
  })

  const page = await context.newPage()
  const url = `${ORIGIN}/embed?magnet=${Buffer.from(SINTEL).toString('base64')}&mode=download&files=${SUBTITLE}`
  console.log(`target: ${url.slice(0, 60)}...`)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 60_000 })

  const button = page.getByRole('button', { name: /^Download/ }).first()
  await button.waitFor({ state: 'visible', timeout: 120_000 })
  for (let i = 0; i < 120 && !(await button.isEnabled()); i++) await new Promise((r) => setTimeout(r, 1000))

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    button.click(),
  ])
  console.log(`downloaded: ${download.suggestedFilename()}`)
  await download.cancel().catch(() => {})

  const sent = await page.evaluate(() => window.__sent)
  const watches = sent.filter((m) => m.type === 'watch')
  const claims = watches.filter((m) => m.held !== true)
  const reads = sent.filter((m) => m.type === 'read')

  console.log('')
  console.log(`watch messages   : ${watches.length}`)
  console.log(`  held (the page's resting claim) : ${watches.filter((m) => m.held === true).length}`)
  console.log(`  active claims                   : ${claims.length}`)
  console.log(`reads            : ${reads.length}`)
  console.log('')
  for (const c of claims) console.log(`  claim -> fileIndex=${c.fileIndex} held=${c.held} bulk=${c.bulk}`)
  /*
   * The control, and it rides in the same run rather than needing a second one.
   *
   * The page's resting HOLDS travel through the identical `client.watch` call and must come back
   * with bulk NOT true. If they did not, the tap would be reporting a constant rather than reading
   * the wire, and the pass above would be free.
   */
  for (const h of watches.filter((m) => m.held === true)) console.log(`  hold  -> fileIndex=${h.fileIndex} held=${h.held} bulk=${h.bulk}`)
  const controlHolds = watches.filter((m) => m.held === true)
  const controlOk = controlHolds.length > 0 && controlHolds.every((h) => h.bulk !== true)

  const bulky = claims.length > 0 && claims.every((c) => c.bulk === true)
  console.log('')
  console.log(controlOk
    ? 'CONTROL OK: the holds came back not-bulk, so the probe is reading the wire and not a constant'
    : 'CONTROL FAILED: the probe cannot tell the two apart, so its verdict means nothing')
  console.log(bulky && controlOk
    ? 'PASS: every active claim the deployed page made is bulk, so the export takes no piece deadlines'
    : 'FAIL: the deployed page made an active claim that was not bulk')

  await context.close()
  await browser.close()
  process.exit(bulky && controlOk ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
