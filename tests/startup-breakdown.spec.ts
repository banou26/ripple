// Where do the seconds go between "add a magnet" and "a frame is on screen"?
//
// torrent-ramp measures the bulk download and stops at first byte. Startup is a
// different thing: it runs through the Watch path, it includes the player, and its
// answer is a single number the product is judged on. Production is 15-70 s to
// first frame, so this exists to say WHICH stage owns those seconds rather than
// re-measuring that they exist.
//
// Three deliberate differences from torrent-ramp:
//
//  - Headful, per the hard rule. Headless chromium sits at a flat 0 B/s in every
//    topology while its data plane is provably healthy, so a headless run here
//    measures the stall and calls it a startup time.
//  - A FRESH BrowserContext per trial. OPFS survives a reload, so a warm file
//    turns the next trial into a different experiment.
//  - It reports first RENDERED frame via requestVideoFrameCallback, not the
//    `playing` event. `playing` fires at readyState >= HAVE_FUTURE_DATA and
//    asserts nothing about a frame being presented.
//
// Nothing here asserts a threshold. The rig's own variance is 14.7 s to 73.4 s
// from byte-identical code, so a pass/fail on a duration would be noise. It
// prints a table and attaches JSON; the judgement is yours.

import type { Browser, TestInfo } from '@playwright/test'

import { expect, test } from '@playwright/test'

import { DEMO_SEEDED_KEY } from '../src/torrent/constants'

// Playwright forbids test.use({ headless }) inside a describe (it forces a new
// worker), so this must stay top-level in the file.
test.use({ headless: false })

const DEFAULT_MAGNET = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969&tr=udp%3A%2F%2Fexodus.desync.com%3A6969'
const MAGNET = process.env.RIPPLE_BENCH_MAGNET ?? DEFAULT_MAGNET
const TRIALS = Number(process.env.RIPPLE_STARTUP_TRIALS ?? 3)
const FRAME_BUDGET_MS = Number(process.env.RIPPLE_STARTUP_BUDGET_MS ?? 180_000)

type Mark = { name: string, at: number, detail?: Record<string, unknown> }

/**
 * Everything is armed in an init script so it survives the SPA navigation to
 * /embed, and so the video element can be caught even though the player creates
 * it long after load.
 */
const instrument = async (page: import('@playwright/test').Page) => {
  await page.addInitScript(() => {
    const root = window as any
    const marks: Mark[] = []
    root.__startup = { marks }
    const mark = (name: string, detail?: Record<string, unknown>) => {
      // first occurrence only: every stage here is a "when did this first happen"
      if (marks.some((m) => m.name === name)) return
      marks.push({ name, at: performance.now(), detail })
    }
    root.__mark = mark
    mark('navigationStart')

    // ---- workers: the engine, libav and jassub all arrive this way ----------
    const NativeWorker = window.Worker
    const Wrapped = function (scriptURL: string | URL, options?: WorkerOptions) {
      const url = String(scriptURL)
      const worker = new NativeWorker(scriptURL, options)
      // The URL is what identifies which worker this is; torrent-ramp's wrapper
      // discards it and then has to infer the engine from id ordering.
      const kind = /libav/i.test(url) ? 'libav' : /jassub/i.test(url) ? 'jassub' : 'engine'
      mark(`worker:${kind}:created`, { url })

      worker.addEventListener('message', (event: MessageEvent) => {
        const m = event.data
        if (!m || typeof m !== 'object' || typeof m.type !== 'string') return
        if (m.type === 'ready') mark('engine:ready')
        else if (m.type === 'read-result') mark('engine:firstReadResult', { bytes: m.data?.byteLength })
        else if (m.type === 'read-stalled') {
          marks.push({ name: 'engine:readStalled', at: performance.now(), detail: { offset: m.offset, waitedMs: m.waitedMs, missingCount: m.missing?.length, numPeers: m.numPeers, downloadRate: m.downloadRate } })
        } else if (m.type === 'state' && Array.isArray(m.torrents)) {
          for (const t of m.torrents) {
            if (t.files) mark('torrent:metadata')
            if ((t.status?.numPeers ?? 0) > 0) mark('torrent:firstPeer')
            if ((t.status?.totalDone ?? 0) > 0) mark('torrent:firstByte')
          }
        }
      })

      const post = worker.postMessage.bind(worker)
      worker.postMessage = ((message: any, transfer?: any) => {
        if (message && typeof message === 'object') {
          if (message.type === 'add-magnet') mark('torrent:addMagnet')
          else if (message.type === 'watch') mark('player:watchClaim')
          else if (message.type === 'read') mark('player:firstRead', { offset: message.offset, len: message.len })
        }
        if (transfer === undefined) post(message)
        else post(message, transfer)
      }) as typeof worker.postMessage
      return worker
    } as unknown as typeof Worker
    Object.setPrototypeOf(Wrapped, NativeWorker)
    Wrapped.prototype = NativeWorker.prototype
    Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: Wrapped })

    // ---- the <video> the player mounts, and the first PAINTED frame ---------
    // Media events do not bubble, but capture reaches them.
    for (const type of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled']) {
      document.addEventListener(type, () => mark(`video:${type}`), true)
    }

    // setInterval, never rAF: an unfocused tab throttles rAF so hard the poll
    // never runs, and the same applies to rVFC, which is why the cheap
    // cross-checks below are recorded alongside it.
    const poll = setInterval(() => {
      const video = document.querySelector('video')
      if (!video) return
      mark('video:element')
      const anyVideo = video as any
      if (typeof anyVideo.requestVideoFrameCallback === 'function') {
        anyVideo.requestVideoFrameCallback((_now: number, meta: any) => {
          mark('video:firstFrame', { presentationTime: meta?.presentationTime, mediaTime: meta?.mediaTime })
        })
      }
      const q = typeof anyVideo.getVideoPlaybackQuality === 'function' ? anyVideo.getVideoPlaybackQuality() : null
      if (q && q.totalVideoFrames > 0) mark('video:firstDecodedFrame', { totalVideoFrames: q.totalVideoFrames })
      if (video.readyState >= 2) mark('video:haveCurrentData')
      if (marks.some((m) => m.name === 'video:firstFrame')) clearInterval(poll)
    }, 100)
  })

  await page.addInitScript((key) => localStorage.setItem(key, '1'), DEMO_SEEDED_KEY)
}

/** Resource timings for the big wasm payloads, which are not free on a cold load. */
const wasmTimings = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    performance.getEntriesByType('resource')
      .filter((e) => /\.wasm$/.test(e.name) || /libtorrent-|libav/.test(e.name))
      .map((e) => ({
        name: e.name.replace(location.origin, ''),
        startTime: Math.round(e.startTime),
        duration: Math.round(e.duration),
        transferSize: (e as PerformanceResourceTiming).transferSize,
      }))
      .sort((a, b) => a.startTime - b.startTime))

const runTrial = async (browser: Browser, index: number) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await instrument(page)
    await page.goto('/')
    // Focus matters: rVFC is throttled in a background tab exactly like rAF.
    await page.bringToFront()

    await page.waitForFunction(
      () => ((window as any).__startup?.marks ?? []).some((m: Mark) => m.name === 'engine:ready'),
      undefined, { timeout: 60_000 },
    )

    // Split the pre-magnet time. Everything between engine:ready and the add is a
    // mix of the app becoming interactive and the harness typing, and lumping them
    // together hides whichever one is the real cost.
    const input = page.getByPlaceholder('Add a magnet link')
    await input.waitFor({ state: 'visible', timeout: 60_000 })
    await page.evaluate(() => (window as any).__mark('ui:inputReady'))
    await input.fill(MAGNET)
    await page.evaluate(() => (window as any).__mark('ui:filled'))
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    // Playwright's click waits for actionability (visible, stable, enabled), and a
    // CSS animation can hold it for seconds. Without this mark that wait is
    // indistinguishable from the app being slow to dispatch the add.
    await page.evaluate(() => (window as any).__mark('ui:clicked'))

    // Click Watch the moment it exists. Warming the torrent first, as torrent-ramp
    // does with 16 MiB, measures a hot engine and is a different question.
    const watch = page.getByRole('link', { name: 'Watch' }).first()
    await watch.waitFor({ state: 'visible', timeout: 120_000 })
    await page.evaluate(() => (window as any).__mark('player:watchClick'))
    await watch.click()

    await page.waitForFunction(
      () => ((window as any).__startup?.marks ?? []).some((m: Mark) => m.name === 'video:firstFrame'),
      undefined, { timeout: FRAME_BUDGET_MS },
    ).catch(() => {})

    const marks: Mark[] = await page.evaluate(() => (window as any).__startup.marks)
    return { index, marks, wasm: await wasmTimings(page) }
  } finally {
    await context.close()
  }
}

const at = (marks: Mark[], name: string) => marks.find((m) => m.name === name)?.at ?? null
const rel = (marks: Mark[], name: string, from: number | null) => {
  const t = at(marks, name)
  return t == null || from == null ? null : Math.round(t - from)
}

const STAGES = [
  'engine:ready',
  'ui:inputReady',
  'ui:filled',
  'ui:clicked',
  'torrent:addMagnet',
  'torrent:firstPeer',
  'torrent:metadata',
  'player:watchClick',
  'worker:libav:created',
  'player:watchClaim',
  'player:firstRead',
  'torrent:firstByte',
  'engine:firstReadResult',
  'video:element',
  'video:loadedmetadata',
  'video:loadeddata',
  'video:firstFrame',
]

test.describe('startup breakdown', () => {
  test('times every stage from magnet to first rendered frame', async ({ browser }, testInfo) => {
    test.setTimeout((FRAME_BUDGET_MS + 120_000) * TRIALS)

    const trials: Awaited<ReturnType<typeof runTrial>>[] = []
    for (let i = 0; i < TRIALS; i++) trials.push(await runTrial(browser, i))

    const rows: Record<string, (number | null)[]> = {}
    for (const stage of STAGES) {
      rows[stage] = trials.map((t) => rel(t.marks, stage, at(t.marks, 'navigationStart')))
    }

    const lines = [`stage${' '.repeat(24)}${trials.map((_, i) => `trial${i + 1}`.padStart(10)).join('')}`]
    for (const stage of STAGES) {
      lines.push(stage.padEnd(28) + rows[stage]!.map((v) => (v == null ? '-' : String(v)).padStart(10)).join(''))
    }
    // Stalls are the diagnostic that named the head-stall bug; a byte counter never could.
    lines.push('')
    for (const t of trials) {
      const stalls = t.marks.filter((m) => m.name === 'engine:readStalled')
      lines.push(`trial${t.index + 1}: ${stalls.length} read stalls` + (stalls.length
        ? ` -> ${stalls.map((s) => `off=${s.detail?.offset} missing=${s.detail?.missingCount} peers=${s.detail?.numPeers}`).join('; ')}`
        : ''))
    }
    lines.push('')
    for (const t of trials) {
      for (const w of t.wasm) lines.push(`trial${t.index + 1} wasm ${w.name} start=${w.startTime}ms dur=${w.duration}ms size=${w.transferSize}`)
    }
    // eslint-disable-next-line no-console
    console.log('\n' + lines.join('\n') + '\n')

    await testInfo.attach('startup-breakdown.json', {
      body: JSON.stringify({ magnet: MAGNET, trials }, null, 2),
      contentType: 'application/json',
    })

    // The only hard assertion: the run has to have produced a measurement at all.
    expect(trials.some((t) => at(t.marks, 'torrent:metadata') != null)).toBe(true)
  })
})
