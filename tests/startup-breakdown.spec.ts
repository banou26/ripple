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

import type { Browser } from '@playwright/test'

import { expect, test } from '@playwright/test'

import { DEMO_SEEDED_KEY } from '../src/torrent/constants'

// Playwright forbids test.use({ headless }) inside a describe (it forces a new
// worker), so this must stay top-level in the file.
test.use({ headless: false })

const DEFAULT_MAGNET = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969&tr=udp%3A%2F%2Fexodus.desync.com%3A6969'
const MAGNET = process.env.RIPPLE_BENCH_MAGNET ?? DEFAULT_MAGNET
const FILE_INDEX = process.env.RIPPLE_BENCH_FILE_INDEX ?? '0'
const TRIALS = Number(process.env.RIPPLE_STARTUP_TRIALS ?? 3)
const FRAME_BUDGET_MS = Number(process.env.RIPPLE_STARTUP_BUDGET_MS ?? 180_000)

type Mark = { name: string, at: number, detail?: Record<string, unknown> }
type ReadSample = { id: number, offset: number, len: number, at: number, end?: number, error?: string }

/**
 * Armed before navigation so the first engine message and video frame are both observed.
 */
const instrument = async (page: import('@playwright/test').Page) => {
  await page.addInitScript(() => {
    const root = window as any
    const marks: Mark[] = []
    const reads: ReadSample[] = []
    let downloaded = 0
    root.__startup = { marks, reads }
    const mark = (name: string, detail?: Record<string, unknown>) => {
      // first occurrence only: every stage here is a "when did this first happen"
      if (marks.some((m) => m.name === name)) return
      marks.push({ name, at: performance.now(), detail })
    }
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
          root.__startup.torrents = m.torrents
          for (const t of m.torrents) {
            downloaded = t.status?.totalDone ?? 0
            if (t.files) mark('torrent:metadata')
            if ((t.status?.numPeers ?? 0) > 0) mark('torrent:firstPeer')
            if ((t.status?.totalDone ?? 0) > 0) mark('torrent:firstByte')
          }
        }
        if (m.type === 'read-result' || m.type === 'read-error') {
          const read = reads.find((r) => r.id === m.id)
          if (read) { read.end = performance.now(); read.error = m.error }
        }
      })

      const post = worker.postMessage.bind(worker)
      worker.postMessage = ((message: any, transfer?: any) => {
        if (message && typeof message === 'object') {
          if (message.type === 'add-magnet') mark('torrent:addMagnet')
          else if (message.type === 'watch') mark('player:watchClaim')
          else if (message.type === 'read' && message.prioritize !== false) {
            mark('player:firstRead', { offset: message.offset, len: message.len })
            reads.push({ id: message.id, at: performance.now(), offset: message.offset, len: message.len })
          }
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
          mark('video:firstFrame', { presentationTime: meta?.presentationTime, mediaTime: meta?.mediaTime, downloaded })
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
      .filter((e) => e.name.endsWith('.wasm') || /libtorrent-|libav/.test(e.name))
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
    await page.goto(`/watch?${new URLSearchParams({ magnet: Buffer.from(MAGNET).toString('base64'), fileIndex: FILE_INDEX })}`)
    // Focus matters: rVFC is throttled in a background tab exactly like rAF.
    await page.bringToFront()

    await page.waitForFunction(
      () => ((window as any).__startup?.marks ?? []).some((m: Mark) => m.name === 'video:firstFrame'),
      undefined, { timeout: FRAME_BUDGET_MS },
    ).catch(() => {})

    const { marks, reads }: { marks: Mark[], reads: ReadSample[] } = await page.evaluate(() => (window as any).__startup)
    return { index, marks, reads, wasm: await wasmTimings(page) }
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
  'torrent:addMagnet',
  'torrent:firstPeer',
  'torrent:metadata',
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
  test('times a cold watch URL through its first rendered frame', async ({ browser }, testInfo) => {
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
      const frame = t.marks.find((m) => m.name === 'video:firstFrame')
      const downloaded = frame?.detail?.downloaded
      lines.push(`trial${t.index + 1} downloaded at first frame: ${typeof downloaded === 'number' ? downloaded : '-'} bytes`)
      for (const r of t.reads.filter((r) => r.at < (frame?.at ?? Infinity))) {
        lines.push(`trial${t.index + 1} read offset=${r.offset} len=${r.len} wait=${r.end == null ? 'pending' : Math.round(r.end - r.at)}ms`)
      }
    }
    // eslint-disable-next-line no-console
    console.log('\n' + lines.join('\n') + '\n')

    await testInfo.attach('startup-breakdown.json', {
      body: JSON.stringify({ magnet: MAGNET, trials }, null, 2),
      contentType: 'application/json',
    })

    expect(trials.every((t) => at(t.marks, 'video:firstFrame') != null), 'every trial must render a frame').toBe(true)
  })
})

// ---- the next file, opened in place -------------------------------------------------------------
//
// From the embedder's `open` to the next file's first rendered frame, with the file playing held to
// its end first (the gate a `prepare` waits on). Three arms, alternated round by round, each in a
// fresh context so the next file is cold in every one:
//
//   cold     `open` with nothing asked ahead
//   button   `prepare` at the moment Next appears, then a press 3 s later
//   80       `prepare` at 80% of an episode: its two bands are waited for, up to the 150 s an episode
//            of 24 minutes leaves between 80% and its ending, then `open`
//
// The embedder is a page of this origin that runs no engine (/legal): Chrome refuses a page
// Playwright fulfils a frame of a loopback address. Nothing asserts a duration; the table and the
// JSON carry the result.

const PLAYING = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const NEXT = process.env.RIPPLE_NEXT_MAGNET ?? DEFAULT_MAGNET
const ARMS = (process.env.RIPPLE_NEXT_ARMS ?? 'cold,button,80').split(',')
const ROUNDS = Number(process.env.RIPPLE_NEXT_ROUNDS ?? 3)
const BUTTON_LEAD_MS = 3_000
const LONG_LEAD_MS = 150_000
const HOLD_BUDGET_MS = Number(process.env.RIPPLE_HOLD_BUDGET_MS ?? 300_000)
const READ = 2_500_000

const hashOf = (magnet: string) => /btih:([0-9a-f]{40})/i.exec(magnet)![1]!.toLowerCase()

/** Whether the frame's last state holds the largest file of `hash` over [from, to), by its bitfield. */
const holds = (frame: import('@playwright/test').Frame, hash: string, band: 'all' | 'bands') => frame.evaluate(({ hash, band, read }) => {
  const t = ((window as any).__startup?.torrents ?? []).find((t: any) => String(t.magnet).toLowerCase().includes(hash))
  const files = t?.files?.files as { offset: number, size: number }[] | undefined
  const bf = t?.bitfield
  if (!files?.length || !bf) return false
  const file = files.reduce((a, b) => (b.size > a.size ? b : a))
  const has = (from: number, to: number) => {
    for (let p = Math.floor((file.offset + from) / bf.pieceLength); p <= Math.floor((file.offset + to - 1) / bf.pieceLength); p++) {
      if (!((bf.pieces[p >> 3] ?? 0) & (0x80 >> (p & 7)))) return false
    }
    return true
  }
  return band === 'all' ? has(0, file.size) : has(0, Math.min(read, file.size)) && has(Math.max(0, file.size - read), file.size)
}, { hash, band, read: READ })

const runSwitch = async (browser: Browser, arm: string, index: number) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await instrument(page)
    const src = `/watch?${new URLSearchParams({ magnet: Buffer.from(PLAYING).toString('base64'), fileIndex: '5' })}`
    await page.goto('/legal')
    await page.bringToFront()
    await page.evaluate((src) => {
      const frame = Object.assign(document.createElement('iframe'), { id: 'ripple', src, allow: 'autoplay; fullscreen' })
      Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', border: 'none' })
      document.body.append(frame)
    }, src)
    const rippleFrame = () => page.frames().find(f => f.url().includes('/watch?'))
    await expect.poll(() => Boolean(rippleFrame())).toBe(true)
    const frame = rippleFrame()!
    const started = Date.now()
    await expect.poll(() => holds(frame, hashOf(PLAYING), 'all'), { timeout: HOLD_BUDGET_MS, intervals: [1_000] }).toBe(true)
    const heldAfterMs = Date.now() - started
    const history = await page.evaluate(() => history.length)
    const post = (message: unknown) => page.evaluate((message) => (document.getElementById('ripple') as HTMLIFrameElement).contentWindow!.postMessage(message, '*'), message)

    let preparedMs: number | null = null
    if (arm !== 'cold') {
      const asked = Date.now()
      await post({ ripple: 'prepare', magnet: NEXT })
      if (arm === 'button') await page.waitForTimeout(BUTTON_LEAD_MS)
      else {
        await expect.poll(() => holds(frame, hashOf(NEXT), 'bands'), { timeout: LONG_LEAD_MS, intervals: [500] }).toBe(true).catch(() => {})
      }
      if (await holds(frame, hashOf(NEXT), 'bands')) preparedMs = Date.now() - asked
    }
    const bandsAtOpen = await holds(frame, hashOf(NEXT), 'bands')

    // the next file's <video> is a new element (a player per file), so its first frame is that element's first
    await frame.evaluate(() => {
      const old = document.querySelector('video')
      const s = (window as any).__switch = { at: performance.now(), frameAt: null as number | null, marker: (window as any).__marker ??= Math.random() }
      const poll = setInterval(() => {
        const video = document.querySelector('video') as any
        if (!video || video === old || typeof video.requestVideoFrameCallback !== 'function') return
        video.requestVideoFrameCallback(() => { s.frameAt ??= performance.now() })
        if (s.frameAt != null) clearInterval(poll)
      }, 100)
    })
    const marker = await frame.evaluate(() => (window as any).__marker)
    await post({ ripple: 'open', magnet: NEXT })
    await frame.waitForFunction(() => (window as any).__switch?.frameAt != null, undefined, { timeout: FRAME_BUDGET_MS }).catch(() => {})
    const result = await frame.evaluate(() => (window as any).__switch)
    const engines = await frame.evaluate(() => ((window as any).__startup.marks as Mark[]).filter(m => m.name === 'worker:engine:created').length)
    return {
      index,
      arm,
      heldAfterMs,
      preparedMs,
      bandsAtOpen,
      openToFrameMs: result.frameAt == null ? null : Math.round(result.frameAt - result.at),
      sameDocument: (await frame.evaluate(() => (window as any).__marker)) === marker,
      engines,
      historySteps: (await page.evaluate(() => history.length)) - history,
    }
  } finally {
    await context.close()
  }
}

test.describe('next file in place', () => {
  test('times an in-place open of the next file, cold and prepared', async ({ browser }, testInfo) => {
    test.setTimeout((HOLD_BUDGET_MS + LONG_LEAD_MS + FRAME_BUDGET_MS + 60_000) * ROUNDS * ARMS.length)
    const runs: Awaited<ReturnType<typeof runSwitch>>[] = []
    for (let round = 0; round < ROUNDS; round++) {
      // rotated per round, so no arm always runs first on a warm swarm
      for (const arm of [...ARMS.slice(round % ARMS.length), ...ARMS.slice(0, round % ARMS.length)]) {
        const run = await runSwitch(browser, arm, runs.length)
        runs.push(run)
        // eslint-disable-next-line no-console
        console.log(`run ${run.index + 1} ${arm}: open to frame ${run.openToFrameMs ?? '-'} ms, bands ${run.bandsAtOpen ? 'held' : 'not held'} at open${run.preparedMs != null ? ` (after ${run.preparedMs} ms)` : ''}, first file held after ${run.heldAfterMs} ms, same document ${run.sameDocument}, engines ${run.engines}, history +${run.historySteps}`)
      }
    }
    await testInfo.attach('next-in-place.json', { body: JSON.stringify({ playing: PLAYING, next: NEXT, runs }, null, 2), contentType: 'application/json' })
    expect(runs.every(run => run.sameDocument && run.engines === 1 && run.historySteps === 0)).toBe(true)
  })
})
