// Does the watched file actually fill IN ORDER from its start?
//
// Every other download assertion in this suite is a byte count, and a byte count is exactly the
// signal that stayed green while playback could not start: pieces were arriving the whole time,
// just scattered across the file, so the header never completed. What this measures instead is
// contiguity: of the pieces we hold inside the watched file, what fraction form an unbroken run
// from the file's first piece. Scattered picking reads as a low number even at a high byte count.

import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test'

import { expect, test } from '@playwright/test'

import { DEMO_SEEDED_KEY } from '../src/torrent/constants'

// MUST be headful, and this is not a preference. In headless Chromium the engine reaches
// "Loading metadata" and sits at a flat 0 B/s forever, in every topology, while its data plane is
// provably healthy; the identical run headful downloads at ~10 MB/s. A headless rig stalls in every
// arm, which makes the axis under test unmeasurable and turns the whole run into noise.
test.use({ headless: false })

const DEFAULT_MAGNET = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969&tr=udp%3A%2F%2Fexodus.desync.com%3A6969'
const MAGNET = process.env.RIPPLE_STREAM_MAGNET ?? process.env.RIPPLE_BENCH_MAGNET ?? DEFAULT_MAGNET

// Even headful the result is flaky run to run, so a single run proves nothing either way. Repeat
// and count a rate.
const ATTEMPTS = Number(process.env.RIPPLE_STREAM_ATTEMPTS ?? 3)
const WATCH_SECONDS = Number(process.env.RIPPLE_STREAM_SECONDS ?? 60)
// Below this the metric is dominated by the in-flight frontier rather than by picking order. Pieces
// are requested in order but complete out of order across peers, so a handful sit past the first
// hole at any moment. That count is roughly constant, so it matters less the more pieces are held:
// at 29 held a healthy run measured 0.86, which says nothing bad about the picking.
const MIN_HAVES = Number(process.env.RIPPLE_STREAM_MIN_PIECES ?? 64)
// The upper end of the contiguity diagnostic, as a fraction of the file. Past this the ratio stops
// being about picking order and becomes about which piece happened to arrive LAST: hold 1047 of
// 1054 pieces with one straggler at piece 109 and it reads 0.10, from a download that finished
// perfectly in order. Measured on every attempt of a healthy run.
const JUDGE_UNTIL_FRACTION = Number(process.env.RIPPLE_STREAM_JUDGE_UNTIL ?? 0.25)

/**
 * Reported, NOT asserted. Read the note below before adding a threshold here.
 *
 * Four framings were tried against this swarm and none of them discriminates:
 *
 *   contiguity at the first sample holding MIN_HAVES pieces
 *     two runs of IDENTICAL code measured 0.39, 0.45, 0.73 and 0.03, 0.08, 0.75
 *   worst contiguity while the file is incomplete
 *     dominated by the endgame: 1047 of 1054 pieces with one straggler at piece 109 reads 0.10,
 *     out of a download that finished as a single unbroken run
 *   worst contiguity inside the first quarter of the file
 *     0.15 to 0.39 healthy, against 0.03 to 0.07 broken; under 5x, and speed dependent
 *   prefix lag, time to hold N contiguously over time to hold N at all
 *     two runs of IDENTICAL code measured 3.00, 4.06, 3.79 and 1.25, 2.00, 1.07
 *
 * The common cause is that all of them are functions of pipeline depth, and this engine sets
 * max_out_request_queue to 5000 deliberately, so hundreds of pieces are in flight and the depth
 * tracks swarm speed rather than picking order. On a 276 MB file that finishes inside the watch
 * window, run-to-run variance is larger than any effect being measured.
 *
 * So this spec reports and does not gate. To actually decide a picking-order question, the arms have
 * to ALTERNATE inside one run against the same swarm, which needs the window size switchable at
 * runtime. Comparing two sequential runs, which is how these numbers were gathered, is confounded.
 */
const REPORT_ONLY_NOTE = 'contiguity metrics are reported, not asserted: see the note in this file'
const POLL_MS = 500
const REQUIRE_BYTES = process.env.RIPPLE_BENCH_REQUIRE_BYTES === '1'

type Sample = {
  atMs: number
  fileIndex: number
  filePieces: number
  haves: number
  /** pieces held in an unbroken run from the file's first piece */
  prefix: number
  /** prefix / haves; 1 means everything we hold is one run from the start */
  contiguity: number | null
  totalDone: number
  peers: number
  sequential: boolean | null
}

const installProbe = async (page: Page) => {
  await page.addInitScript(() => {
    const root = window as any
    root.__rippleStream = {
      latest: null, watching: null, ready: false,
      failures: [] as string[], stalls: [] as unknown[],
    }
    const NativeWorker = window.Worker

    const WrappedWorker = function (scriptURL: string | URL, options?: WorkerOptions) {
      const worker = new NativeWorker(scriptURL, options)
      worker.addEventListener('message', (event: MessageEvent) => {
        const message = event.data
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') return
        // only the newest snapshot is kept: the bitfield is the payload here, and a full history of
        // them would be megabytes for a torrent with many pieces
        if (message.type === 'state') root.__rippleStream.latest = message.torrents
        else if (message.type === 'ready') root.__rippleStream.ready = true
        else if (message.type === 'read-stalled') {
          // the engine saying which pieces a parked read is waiting on, and what it was doing
          // meanwhile. This is what separates "engine has not delivered" from "player is stuck".
          root.__rippleStream.stalls.push({
            at: Math.round(performance.now()),
            offset: message.offset,
            waitedMs: message.waitedMs,
            missing: (message.missing ?? []).slice(0, 8),
            missingCount: (message.missing ?? []).length,
            downloadRate: message.downloadRate,
            numPeers: message.numPeers,
          })
        }
        else if (['storage-unavailable', 'error', 'worker-error'].includes(message.type)) {
          root.__rippleStream.failures.push(String(message.error ?? message.message ?? message.type))
        }
      })

      const postMessage = worker.postMessage.bind(worker)
      worker.postMessage = ((message: any, transfer?: any) => {
        // the file under test is whatever the player told the engine to watch, not a guess
        if (message && typeof message === 'object' && message.type === 'watch') {
          root.__rippleStream.watching = { handle: message.handle, fileIndex: message.fileIndex }
        }
        if (transfer === undefined) postMessage(message)
        else if (Array.isArray(transfer)) postMessage(message, transfer)
        else postMessage(message, transfer)
      }) as typeof worker.postMessage

      return worker
    } as unknown as typeof Worker

    Object.setPrototypeOf(WrappedWorker, NativeWorker)
    WrappedWorker.prototype = NativeWorker.prototype
    Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: WrappedWorker })
  })
  await page.addInitScript((key) => localStorage.setItem(key, '1'), DEMO_SEEDED_KEY)
}

const readSample = (page: Page): Promise<Omit<Sample, 'atMs'> | null> => page.evaluate((magnet) => {
  const probe = (window as any).__rippleStream
  const watching = probe?.watching
  const torrents = probe?.latest
  if (!watching || !Array.isArray(torrents)) return null
  const torrent = torrents.find((t: any) => t.handle === watching.handle && t.magnet === magnet)
    ?? torrents.find((t: any) => t.magnet === magnet)
  if (!torrent?.bitfield || !torrent?.files) return null
  const file = torrent.files.files[watching.fileIndex]
  if (!file || file.size <= 0) return null

  const pieceLength = torrent.files.pieceLength
  const bits = torrent.bitfield.pieces as Uint8Array
  const p0 = Math.floor(file.offset / pieceLength)
  const p1 = Math.floor((file.offset + file.size - 1) / pieceLength)
  let haves = 0
  let firstHole = -1
  for (let p = p0; p <= p1; p++) {
    // MSB-first within each byte, matching the engine's bitfield writer
    if ((bits[p >> 3]! & (0x80 >> (p & 7))) !== 0) haves++
    else if (firstHole < 0) firstHole = p
  }

  return {
    fileIndex: watching.fileIndex,
    filePieces: p1 - p0 + 1,
    haves,
    prefix: (firstHole < 0 ? p1 + 1 : firstHole) - p0,
    contiguity: haves > 0 ? ((firstHole < 0 ? p1 + 1 : firstHole) - p0) / haves : null,
    totalDone: torrent.status?.totalDone ?? 0,
    peers: torrent.status?.numPeers ?? 0,
    sequential: torrent.status?.sequential ?? null,
  }
}, MAGNET)

const failures = (page: Page): Promise<string[]> =>
  page.evaluate(() => ((window as any).__rippleStream?.failures ?? []) as string[])

const stalls = (page: Page): Promise<unknown[]> =>
  page.evaluate(() => ((window as any).__rippleStream?.stalls ?? []) as unknown[])

/**
 * What the owner actually cares about: is the video advancing, and how much contiguous playable
 * runway sits ahead of the playhead.
 *
 * A run from the START of the file says nothing about this. If the playhead is at 5s, a hole at 6s
 * and data at 20s is a stall, and prefix-from-zero scores that the same as data simply not having
 * arrived. It also goes blind entirely after a seek.
 *
 * currentTime plus video.buffered is measured at the only place that decides the outcome, the media
 * element, so it is immune to the request-pipeline depth that defeated every piece-level metric.
 */
const readPlayback = (page: Page) => page.evaluate(() => {
  const video = document.querySelector('video')
  if (!video) return null
  const ct = video.currentTime
  let runway = 0
  for (let i = 0; i < video.buffered.length; i++) {
    // the range holding the playhead, with slack for audio priming at the very start
    if (video.buffered.start(i) <= ct + 0.25 && ct < video.buffered.end(i)) {
      runway = video.buffered.end(i) - ct
      break
    }
  }
  return {
    currentTime: ct,
    runwaySeconds: runway,
    paused: video.paused,
    readyState: video.readyState,
    bufferedRanges: video.buffered.length,
  }
})

type Attempt = {
  index: number
  reachedWatch: boolean
  /** the first sample with enough pieces to judge */
  judged: Sample | null
  /** worst contiguity inside the early band. Diagnostic only, see MAX_PREFIX_LAG. */
  worst: Sample | null
  last: Sample | null
  /** ms from the first sample until the file held MIN_HAVES pieces at all */
  havesAtMs: number | null
  /** ms until it held MIN_HAVES pieces as one run from the file's start */
  prefixAtMs: number | null
  /** prefixAtMs / havesAtMs. 1.0 is perfectly in order. null when never reached. */
  lag: number | null
  /**
   * The verdict, measured at the media element rather than at the piece map.
   *
   * `longestFreezeMs` is the reported failure stated directly: how long currentTime sat still while
   * the element believed it was playing. `minRunwayWhilePlaying` says whose fault a freeze was:
   * roughly zero means the engine never delivered the bytes, comfortably positive with a frozen
   * clock means the player or MSE had the data and did not use it.
   */
  playback: {
    played: number
    firstPlayAtMs: number | null
    longestFreezeMs: number
    pausedWhileFrozen: boolean
    wallClockPlayingMs: number
    /** media seconds advanced per wall-clock second after the first frame; 1.0 is real-time */
    playbackRatio: number | null
    minRunwayWhilePlaying: number | null
  }
  /** read-stalled reports from the engine: which pieces a parked read was waiting on */
  stalls: unknown[]
  failures: string[]
}

const measureOnce = async (context: BrowserContext, index: number): Promise<Attempt> => {
  const page = await context.newPage()
  try {
    await installProbe(page)
    await page.goto('/')
    await page.waitForFunction(() => (window as any).__rippleStream?.ready === true, undefined, { timeout: 60_000 })

    await page.getByPlaceholder('Add a magnet link').fill(MAGNET)
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    const watchLink = page.getByRole('link', { name: 'Watch' }).first()
    await watchLink.waitFor({ state: 'visible', timeout: 90_000 })
    await watchLink.click()

    // the player only claims a file once metadata has landed, so this is also the metadata gate
    const reachedWatch = await page
      .waitForFunction(() => (window as any).__rippleStream?.watching != null, undefined, { timeout: 90_000 })
      .then(() => true, () => false)
    const blank = {
      judged: null, worst: null, last: null, havesAtMs: null, prefixAtMs: null, lag: null,
      playback: { played: 0, firstPlayAtMs: null, longestFreezeMs: 0, pausedWhileFrozen: false, wallClockPlayingMs: 0, playbackRatio: null, minRunwayWhilePlaying: null },
      stalls: [] as unknown[],
    }
    if (!reachedWatch) {
      return { index, reachedWatch: false, ...blank, failures: await failures(page) }
    }

    const startedAt = Date.now()
    let judged: Sample | null = null
    let worst: Sample | null = null
    let last: Sample | null = null
    let havesAtMs: number | null = null
    let prefixAtMs: number | null = null
    // playhead tracking: the verdict
    let maxCurrentTime = 0
    let firstPlayAtMs: number | null = null
    let frozenSinceMs: number | null = null
    let longestFreezeMs = 0
    let minRunwayWhilePlaying = Number.POSITIVE_INFINITY
    let pausedWhileFrozen = false
    let wallClockPlayingMs = 0
    let lastCt = -1
    while (Date.now() - startedAt < WATCH_SECONDS * 1_000) {
      const pb = await readPlayback(page)
      if (pb) {
        const atMs = Date.now() - startedAt
        if (pb.currentTime > 0 && firstPlayAtMs === null) firstPlayAtMs = atMs
        maxCurrentTime = Math.max(maxCurrentTime, pb.currentTime)
        if (pb.currentTime > lastCt + 0.02) {
          lastCt = pb.currentTime
          frozenSinceMs = null
        } else if (pb.currentTime > 0) {
          // Not advancing, whatever the element says about paused. Gating this on !paused was a
          // blind spot: a run that advanced 4 seconds in 94 reported a longest freeze of ZERO,
          // because whatever stops the clock also reports paused.
          frozenSinceMs ??= atMs
          longestFreezeMs = Math.max(longestFreezeMs, atMs - frozenSinceMs)
          minRunwayWhilePlaying = Math.min(minRunwayWhilePlaying, pb.runwaySeconds)
          if (pb.paused) pausedWhileFrozen = true
        }
        if (firstPlayAtMs !== null) wallClockPlayingMs = atMs - firstPlayAtMs
      }
      const raw = await readSample(page)
      if (raw) {
        const sample: Sample = { atMs: Date.now() - startedAt, ...raw }
        last = sample
        // the two halves of the verdict, measured through the same pipeline at the same speed
        if (havesAtMs === null && sample.haves >= MIN_HAVES) havesAtMs = sample.atMs
        if (prefixAtMs === null && sample.prefix >= MIN_HAVES) prefixAtMs = sample.atMs
        const judgeable = sample.haves >= MIN_HAVES
          && sample.haves <= sample.filePieces * JUDGE_UNTIL_FRACTION
        if (judgeable) {
          judged ??= sample
          if (!worst || (sample.contiguity ?? 1) < (worst.contiguity ?? 1)) worst = sample
        }
      }
      // both reached: nothing later can change the verdict
      if (havesAtMs !== null && prefixAtMs !== null && last && last.haves >= last.filePieces) break
      await page.waitForTimeout(POLL_MS)
    }
    const lag = havesAtMs !== null && havesAtMs > 0 && prefixAtMs !== null ? prefixAtMs / havesAtMs : null
    return {
      index, reachedWatch: true, judged, worst, last, havesAtMs, prefixAtMs, lag,
      playback: {
        played: Number(maxCurrentTime.toFixed(2)),
        firstPlayAtMs,
        longestFreezeMs,
        pausedWhileFrozen,
        wallClockPlayingMs,
        // the single number that says whether playback kept up: media seconds advanced per second
        // of wall clock after the first frame. 1.0 is real-time, 0 is frozen.
        playbackRatio: wallClockPlayingMs > 0
          ? Number((maxCurrentTime / (wallClockPlayingMs / 1000)).toFixed(3))
          : null,
        minRunwayWhilePlaying: Number.isFinite(minRunwayWhilePlaying)
          ? Number(minRunwayWhilePlaying.toFixed(2))
          : null,
      },
      stalls: await stalls(page),
      failures: await failures(page),
    }
  } finally {
    await page.close()
  }
}

const attach = async (testInfo: TestInfo, name: string, report: unknown) => {
  const body = JSON.stringify(report, null, 2)
  console.log(`\n${name}\n${body}`)
  await testInfo.attach(`${name}.json`, { body, contentType: 'application/json' })
}

test.describe('stream contiguity', () => {
  test('the watched file fills as one run from its start', async ({ browser }: { browser: Browser }, testInfo) => {
    test.setTimeout(ATTEMPTS * (WATCH_SECONDS + 120) * 1_000)

    const attempts: Attempt[] = []
    for (let i = 0; i < ATTEMPTS; i++) {
      // a fresh context per attempt: OPFS survives a reload, and a warm cache would hand the next
      // attempt a file that is already contiguous
      const context = await browser.newContext()
      try {
        attempts.push(await measureOnce(context, i))
      } finally {
        await context.close()
      }
    }

    // an attempt counts only once the file held MIN_HAVES pieces; below that the swarm, not the
    // code, decided the outcome
    const measured = attempts.filter((a) => a.judged !== null)
    const allFailures = attempts.flatMap((a) => a.failures)

    const report = {
      browser: testInfo.project.name,
      magnet: MAGNET,
      attempts: ATTEMPTS,
      watchSeconds: WATCH_SECONDS,
      minHaves: MIN_HAVES,
      judgeUntilFraction: JUDGE_UNTIL_FRACTION,
      note: REPORT_ONLY_NOTE,
      measuredAttempts: measured.length,
      contiguities: measured.map((a) => Number((a.judged?.contiguity ?? 0).toFixed(3))),
      worstInBand: measured.map((a) => Number((a.worst?.contiguity ?? 0).toFixed(3))),
      lags: measured.map((a) => (a.lag === null ? 'never' : Number(a.lag.toFixed(2)))),
      havesAtMs: measured.map((a) => a.havesAtMs),
      prefixAtMs: measured.map((a) => a.prefixAtMs),
      completedContiguous: attempts.map((a) => (a.last ? a.last.prefix === a.last.filePieces : null)),
      // the verdict, measured at the media element
      played: attempts.map((a) => a.playback.played),
      longestFreezeMs: attempts.map((a) => a.playback.longestFreezeMs),
      playbackRatio: attempts.map((a) => a.playback.playbackRatio),
      pausedWhileFrozen: attempts.map((a) => a.playback.pausedWhileFrozen),
      minRunwayWhilePlaying: attempts.map((a) => a.playback.minRunwayWhilePlaying),
      stallReports: attempts.map((a) => a.stalls.length),
      sequentialSeen: attempts.some((a) => a.last?.sequential === true || a.judged?.sequential === true),
      detail: attempts,
      failures: allFailures,
    }
    await attach(testInfo, 'stream-contiguity', report)

    expect(allFailures).toEqual([])

    if (measured.length === 0) {
      // no swarm, no verdict. Failing here would only report on the network, so this is loud but
      // green unless the caller demanded real bytes.
      console.warn(`stream-contiguity: no attempt reached ${MIN_HAVES} pieces in the watched file; nothing measured`)
      expect(REQUIRE_BYTES, `no attempt reached ${MIN_HAVES} pieces of the watched file`).toBe(false)
      return
    }

    // What IS asserted: the plan reached the engine, and the player actually got its file open.
    // Those are binary and swarm-independent. The contiguity numbers above are for a human to read
    // next to a change, not for CI to rule on.
    //
    // the engine reports the flag back as of libtorrent-wasm 0.3.5, so this proves the streaming
    // plan landed rather than inferring it from the download shape
    expect(report.sequentialSeen).toBe(true)
    // the skip mask is in force: the engine is fetching the watched file, not the whole torrent
    expect(measured.every((a) => (a.judged?.fileIndex ?? -1) >= 0)).toBe(true)
  })
})
