// Opening a download page must not kill the engine before the metadata arrives.
//
// The download page registers a HELD claim the moment its handle exists, so the person sees the
// torrent's name and size and nothing downloads until they press the button. A held claim is
// deliberately not an ACTIVE viewer, which means `applyViewing` takes its no-viewers branch at
// `watch` time, which is before any metadata exists.
//
// That branch called `session.clearStreamWindow(h)` unguarded. It ends in
// `lt_torrent_clear_piece_deadlines`, which walks the piece list, so on a handle with no metadata it
// trapped the wasm:
//
//   RuntimeError: memory access out of bounds
//     at _lt_torrent_clear_piece_deadlines
//     at Session.clearStreamWindow
//     at applyViewing / watch / handleMessage
//
// Not a soft failure: the wasm instance is finished afterwards, so the whole engine is gone for the
// life of the page, on every pump.
//
// HEADLESS ON PURPOSE, against the usual rule for this repo. The bug needs a torrent whose metadata
// has NOT arrived, and headless reaching no peers is exactly that state, deterministically, in a
// couple of seconds. A headful run would race the fix by fetching metadata before the assertion.

import { expect, test } from '@playwright/test'

// same probe multi-tab.spec.ts uses: the engine is a Worker, so counting constructions is the
// cheapest proof that one actually started
const recordWorkers = () => {
  const scope = window as unknown as { __workers: string[] }
  scope.__workers = []
  const Original = window.Worker
  class Probe extends Original {
    constructor (url: string | URL, options?: WorkerOptions) {
      super(url, options)
      scope.__workers.push(String(url))
    }
  }
  window.Worker = Probe as unknown as typeof Worker
}

// Real infohash, no trackers and no web seeds on purpose: nothing must ever answer, so the torrent
// stays in the pre-metadata state this test is about.
const NO_PEERS = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Nothing%20Answers'

const downloadUrl = () => `/embed?magnet=${Buffer.from(NO_PEERS).toString('base64')}&mode=download`

test('a download page for a torrent with no metadata yet does not trap the engine', async ({ page }) => {
  const engineErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (/memory access out of bounds|RuntimeError|torrent engine/i.test(text)) engineErrors.push(text)
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await page.addInitScript(recordWorkers)
  await page.goto(downloadUrl())

  // the card renders from the magnet alone, so this is up long before any metadata could arrive.
  // The button itself is not the anchor: it is deliberately disabled until the layout lands, which
  // in this test is never.
  await page.waitForSelector('.card', { timeout: 30_000 })

  // The engine pumps every 500ms and the crash fired from the pump as well as from `watch`, so the
  // window has to cover several passes. Before the fix the first one was enough.
  await page.waitForTimeout(6_000)

  expect(engineErrors, `the engine reported:\n${engineErrors.join('\n')}`).toEqual([])
  expect(pageErrors, `the page threw:\n${pageErrors.join('\n')}`).toEqual([])

  // The control, and the reason the two empty arrays above mean anything: an engine has to have
  // STARTED. A page that never built one also reports no engine errors, and would pass every
  // assertion above while testing nothing at all.
  const workers = await page.evaluate(() =>
    (window as unknown as { __workers: string[] }).__workers.filter((url) => !/libav|jassub/.test(url)))
  expect(workers.length, 'no engine worker was ever constructed, so this test proved nothing').toBeGreaterThan(0)
})
