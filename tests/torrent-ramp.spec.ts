import type { Page, TestInfo } from '@playwright/test'

import { expect, test } from '@playwright/test'

import { DEMO_SEEDED_KEY } from '../src/torrent/constants'
import { createRecentRateTracker } from '../src/torrent/recent-rate'

const MIB = 1_048_576
const DEFAULT_MAGNET = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969&tr=udp%3A%2F%2Fexodus.desync.com%3A6969'
const MAGNET = process.env.RIPPLE_BENCH_MAGNET ?? DEFAULT_MAGNET
const BENCH_SECONDS = Number(process.env.RIPPLE_BENCH_SECONDS ?? 45)
const WARM_BYTES = Number(process.env.RIPPLE_BENCH_WARM_BYTES ?? 16 * MIB)
const WARM_TIMEOUT_MS = Number(process.env.RIPPLE_BENCH_WARM_TIMEOUT_MS ?? 90_000)
const REQUIRE_BYTES = process.env.RIPPLE_BENCH_REQUIRE_BYTES === '1'

const tracedIncoming = new Set([
  'ready',
  'state',
  'read-result',
  'read-error',
  'storage-unavailable',
  'error',
  'worker-error',
])

const tracedOutgoing = new Set(['add-magnet', 'read'])

type TraceTorrent = {
  handle: number
  magnet: string
  hasMetadata: boolean
  totalDone: number | null
  progress: number | null
  downloadRate: number | null
  peers: number | null
  state: number | null
  paused: boolean | null
}

type TraceEvent = {
  at: number
  workerId: number
  direction: 'in' | 'out' | 'lifecycle'
  type: string
  torrents?: TraceTorrent[]
  magnet?: string
  id?: number
  bytes?: number
  error?: string
}

type RatePoint = TraceTorrent & {
  at: number
  workerId: number
}

const installTrace = async (page: Page) => {
  await page.addInitScript(({ incoming, outgoing }) => {
    const root = window as typeof window & { __rippleRamp?: { events: unknown[] } }
    const events: unknown[] = []
    let nextWorkerId = 0
    root.__rippleRamp = { events }

    const record = (event: Record<string, unknown>) => events.push({ at: performance.now(), ...event })
    const incomingTypes = new Set(incoming)
    const outgoingTypes = new Set(outgoing)
    const NativeWorker = window.Worker

    const WrappedWorker = function (scriptURL: string | URL, options?: WorkerOptions) {
      const worker = new NativeWorker(scriptURL, options)
      const workerId = ++nextWorkerId

      worker.addEventListener('message', (event) => {
        const message = event.data
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') return
        if (message.type === 'state') {
          const torrents = Array.isArray(message.torrents)
            ? message.torrents.map((torrent: any) => ({
                handle: torrent.handle,
                magnet: torrent.magnet,
                hasMetadata: Boolean(torrent.files),
                totalDone: torrent.status?.totalDone ?? null,
                progress: torrent.status?.progress ?? null,
                downloadRate: torrent.status?.downloadRate ?? null,
                peers: torrent.status?.numPeers ?? null,
                state: torrent.status?.state ?? null,
                paused: torrent.status?.paused ?? null,
              }))
            : []
          record({ workerId, direction: 'in', type: 'state', torrents })
        } else if (incomingTypes.has(message.type)) {
          record({
            workerId,
            direction: 'in',
            type: message.type,
            id: message.id,
            bytes: message.data?.byteLength,
            error: message.error ?? message.message,
          })
        }
      })

      const postMessage = worker.postMessage.bind(worker)
      worker.postMessage = ((message: any, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
        if (message && typeof message === 'object' && outgoingTypes.has(message.type)) {
          record({
            workerId,
            direction: 'out',
            type: message.type,
            magnet: message.magnet,
            id: message.id,
          })
        }
        if (transferOrOptions === undefined) postMessage(message)
        else if (Array.isArray(transferOrOptions)) postMessage(message, transferOrOptions)
        else postMessage(message, transferOrOptions)
      }) as typeof worker.postMessage

      const terminate = worker.terminate.bind(worker)
      worker.terminate = () => {
        record({ workerId, direction: 'lifecycle', type: 'terminated' })
        terminate()
      }
      return worker
    } as unknown as typeof Worker

    Object.setPrototypeOf(WrappedWorker, NativeWorker)
    WrappedWorker.prototype = NativeWorker.prototype
    Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: WrappedWorker })
  }, { incoming: [...tracedIncoming], outgoing: [...tracedOutgoing] })

  await page.addInitScript((key) => localStorage.setItem(key, '1'), DEMO_SEEDED_KEY)
}

const trace = (page: Page): Promise<TraceEvent[]> =>
  page.evaluate(() => ((window as any).__rippleRamp?.events ?? []) as TraceEvent[])

const failureEvents = (events: TraceEvent[]) =>
  events.filter((event) => ['storage-unavailable', 'error', 'worker-error'].includes(event.type))

const waitForReady = (page: Page, count = 1, timeout = 30_000) =>
  page.waitForFunction(
    (required) => ((window as any).__rippleRamp?.events ?? [])
      .filter((event: TraceEvent) => event.direction === 'in' && event.type === 'ready').length >= required,
    count,
    { timeout },
  )

const waitForTorrent = (
  page: Page,
  options: { minBytes?: number, metadata?: boolean, excludedWorkerId?: number },
  timeout: number,
) => page.waitForFunction(
  ({ magnet, minBytes, metadata, excludedWorkerId }) => ((window as any).__rippleRamp?.events ?? [])
    .some((event: TraceEvent) => event.type === 'state' && event.workerId !== excludedWorkerId && event.torrents?.some((torrent) =>
      torrent.magnet === magnet &&
      (minBytes === undefined || (torrent.totalDone ?? 0) >= minBytes) &&
      (metadata !== true || torrent.hasMetadata)
    )),
  { magnet: MAGNET, ...options },
  { timeout },
)

const torrentPoints = (events: TraceEvent[], workerId?: number): RatePoint[] =>
  events
    .filter((event) => event.type === 'state' && (workerId === undefined || event.workerId === workerId))
    .flatMap((event) => (event.torrents ?? [])
      .filter((torrent) => torrent.magnet === MAGNET)
      .map((torrent) => ({ ...torrent, at: event.at, workerId: event.workerId })))

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * fraction
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const weight = index - lower
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight
}

const observedRates = (points: RatePoint[]) => {
  const tracker = createRecentRateTracker()
  return points.flatMap((point) => {
    if (point.totalDone === null) return []
    if (point.paused || point.state === 4 || point.state === 5) {
      tracker.reset(point.handle)
      return [{ at: point.at, rate: 0 }]
    }
    const rate = tracker.sample(point.handle, point.totalDone, point.at)
    return rate === null ? [] : [{ at: point.at, rate }]
  })
}

const analyze = (points: RatePoint[], startAt: number, baseline = 0) => {
  const completedAt = points.findIndex((point) => point.state === 4 || point.state === 5 || point.progress === 1)
  const measuredPoints = completedAt >= 0 ? points.slice(0, completedAt + 1) : points
  const rates = observedRates(measuredPoints)
  const lastAt = measuredPoints.at(-1)?.at ?? startAt
  const firstByteAt = measuredPoints.find((point) => point.totalDone !== null && point.totalDone > baseline)?.at ?? null
  const measuredRates = firstByteAt === null ? [] : rates.filter((point) => point.at >= firstByteAt)
  const plateau = percentile(measuredRates.map((point) => point.rate), 0.75)
  const thresholdAt = (fraction: number) => {
    const threshold = plateau * fraction
    return {
      observed: threshold > 0 ? measuredRates.find((point) => point.rate >= threshold)?.at ?? null : null,
      engine: threshold > 0 ? measuredPoints.find((point) => (point.downloadRate ?? 0) >= threshold)?.at ?? null : null,
    }
  }
  const at80 = thresholdAt(0.8)
  const at95 = thresholdAt(0.95)
  const firstPeerAt = points.find((point) => (point.peers ?? 0) > 0)?.at ?? null
  const metadataAt = points.find((point) => point.hasMetadata)?.at ?? null
  const milestone = (bytes: number) => points.find((point) => point.totalDone !== null && point.totalDone - baseline >= bytes)?.at ?? null
  const first16MiBAt = milestone(16 * MIB)
  const first64MiBAt = milestone(64 * MIB)
  const first256MiBAt = milestone(256 * MIB)
  const displayGap = ({ observed, engine }: typeof at80) => observed === null
    ? null
    : engine === null
      ? lastAt - observed
      : engine - observed
  const displayGapAt80Ms = displayGap(at80)
  const displayGapAt95Ms = displayGap(at95)
  const firstByteToObserved80Ms = firstByteAt !== null && at80.observed !== null ? at80.observed - firstByteAt : null
  const trailingRates = measuredRates.filter((point) => point.at >= lastAt - 10_000)
  const positiveRateCoverage = measuredRates.length === 0
    ? 0
    : measuredRates.filter((point) => point.rate > 0).length / measuredRates.length
  const stalled = completedAt < 0 && firstByteAt !== null && lastAt - firstByteAt >= 10_000 &&
    trailingRates.length > 0 && trailingRates.every((point) => point.rate === 0)
  const startupClassification = firstByteAt === null
    ? 'no-transfer'
    : firstByteAt - startAt >= 10_000
      ? 'startup-limited'
      : 'fast'
  const rampClassification = stalled
    ? 'stalled'
    : plateau <= 0 || at80.observed === null
      ? 'inconclusive'
      : (displayGapAt80Ms ?? 0) >= 3_000 || (displayGapAt95Ms ?? 0) >= 5_000
        ? 'display-limited'
        : firstByteToObserved80Ms !== null && firstByteToObserved80Ms >= 10_000
          ? 'transport-limited'
          : 'aligned'
  const lastKnownTotal = points.findLast((point) => point.totalDone !== null)?.totalDone ?? baseline

  return {
    samples: points.length,
    finalBytes: Math.max(0, lastKnownTotal - baseline),
    completed: completedAt >= 0,
    positiveRateCoverage,
    plateauBytesPerSecond: plateau,
    peakObservedBytesPerSecond: Math.max(0, ...rates.map((point) => point.rate)),
    metadataMs: metadataAt === null ? null : metadataAt - startAt,
    firstPeerMs: firstPeerAt === null ? null : firstPeerAt - startAt,
    firstByteMs: firstByteAt === null ? null : firstByteAt - startAt,
    first16MiBMs: first16MiBAt === null ? null : first16MiBAt - startAt,
    first64MiBMs: first64MiBAt === null ? null : first64MiBAt - startAt,
    first256MiBMs: first256MiBAt === null ? null : first256MiBAt - startAt,
    observedAt80Ms: at80.observed === null ? null : at80.observed - startAt,
    engineAt80Ms: at80.engine === null ? null : at80.engine - startAt,
    displayGapAt80Ms,
    observedAt95Ms: at95.observed === null ? null : at95.observed - startAt,
    engineAt95Ms: at95.engine === null ? null : at95.engine - startAt,
    displayGapAt95Ms,
    classification: { startup: startupClassification, ramp: rampClassification },
  }
}

const attachReport = async (testInfo: TestInfo, name: string, report: unknown) => {
  const body = JSON.stringify(report, null, 2)
  console.log(`\n${name}\n${body}`)
  await testInfo.attach(`${name}.json`, { body, contentType: 'application/json' })
}

const submitMagnet = async (page: Page) => {
  await page.getByPlaceholder('Add a magnet link').fill(MAGNET)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.waitForFunction(
    (magnet) => ((window as any).__rippleRamp?.events ?? [])
      .some((event: TraceEvent) => event.direction === 'out' && event.type === 'add-magnet' && event.magnet === magnet),
    MAGNET,
  )
}

test.describe('recent rate tracker', () => {
  test('handles sampling, stalls, resets, and removal', () => {
    const steady = createRecentRateTracker()
    expect(steady.sample(1, 0, 0)).toBeNull()
    expect(steady.sample(1, 500_000, 500)).toBeNull()
    expect(steady.sample(1, 1_000_000, 1_000)).toBe(1_000_000)
    expect(steady.sample(1, 2_500_000, 2_500)).toBe(1_000_000)

    const step = createRecentRateTracker()
    expect(step.sample(1, 0, 0)).toBeNull()
    expect(step.sample(1, 1_000_000, 1_000)).toBe(1_000_000)
    expect(step.sample(1, 4_000_000, 2_000)).toBe(2_000_000)
    expect(step.sample(1, 7_000_000, 3_000)).toBe(3_000_000)

    const restored = createRecentRateTracker()
    expect(restored.sample(1, 500 * MIB, 0)).toBeNull()
    expect(restored.sample(1, 500 * MIB, 1_000)).toBe(0)

    const stalled = createRecentRateTracker()
    stalled.sample(1, 0, 0)
    stalled.sample(1, 1_000_000, 1_000)
    stalled.sample(1, 1_000_000, 2_000)
    expect(stalled.sample(1, 1_000_000, 3_000)).toBe(0)

    const gap = createRecentRateTracker()
    gap.sample(1, 0, 0)
    expect(gap.sample(1, 1_000_000, 1_000)).toBe(1_000_000)
    expect(gap.sample(1, 2_000_000, 10_000)).toBeNull()
    expect(gap.sample(1, 2_000_000, 11_000)).toBe(0)

    const reset = createRecentRateTracker()
    reset.sample(1, 100, 0)
    expect(reset.sample(1, 200, 1_000)).toBe(100)
    expect(reset.sample(1, 50, 2_000)).toBeNull()
    expect(reset.sample(1, 150, 3_000)).toBe(100)
    reset.retain(new Set())
    expect(reset.sample(1, 10_000, 4_000)).toBeNull()
  })
})

test.describe('torrent ramp', () => {
  test('measures a cold Home download', async ({ page }, testInfo) => {
    test.setTimeout((BENCH_SECONDS + 60) * 1_000)
    await installTrace(page)
    await page.goto('/')
    await waitForReady(page)
    await submitMagnet(page)
    const eventsAfterAdd = await trace(page)
    const addAt = eventsAfterAdd.find((event) => event.direction === 'out' && event.type === 'add-magnet')!.at

    await page.waitForTimeout(BENCH_SECONDS * 1_000)
    const events = await trace(page)
    const points = torrentPoints(events)
    const report = {
      browser: testInfo.project.name,
      seconds: BENCH_SECONDS,
      result: analyze(points, addAt),
      failures: failureEvents(events),
    }
    await attachReport(testInfo, 'cold-torrent-ramp', report)

    expect(report.failures).toEqual([])
    expect(points.length).toBeGreaterThan(1)
    if (REQUIRE_BYTES) expect(report.result.finalBytes).toBeGreaterThan(0)
  })

  test('measures the Home to Watch worker reset', async ({ page }, testInfo) => {
    test.setTimeout((BENCH_SECONDS + WARM_TIMEOUT_MS / 1_000 + 90) * 1_000)
    await installTrace(page)
    await page.goto('/')
    await waitForReady(page)
    await submitMagnet(page)
    const warmed = await waitForTorrent(page, { minBytes: WARM_BYTES, metadata: true }, WARM_TIMEOUT_MS)
      .then(() => true, () => false)

    const beforeWatch = await trace(page)
    const homePoints = torrentPoints(beforeWatch)
    const homeAddAt = beforeWatch.find((event) => event.direction === 'out' && event.type === 'add-magnet')!.at
    if (!warmed || homePoints.length === 0) {
      const report = {
        browser: testInfo.project.name,
          skippedWatch: `Home did not reach metadata plus ${WARM_BYTES} bytes within ${WARM_TIMEOUT_MS} ms`,
        home: analyze(homePoints, homeAddAt),
        failures: failureEvents(beforeWatch),
      }
      await attachReport(testInfo, 'home-to-watch-ramp', report)
      expect(report.failures).toEqual([])
      if (REQUIRE_BYTES) expect(warmed).toBe(true)
      return
    }

    const homeWorkerId = homePoints.at(-1)!.workerId
    await page.evaluate(() => {
      const root = window as typeof window & { __ripplePlayingAt?: number | null }
      root.__ripplePlayingAt = null
      document.addEventListener('playing', () => { root.__ripplePlayingAt ??= performance.now() }, true)
    })
    const watchAt = await page.evaluate(() => performance.now())
    await page.getByRole('link', { name: 'Watch' }).first().click()
    await waitForTorrent(page, { metadata: true, excludedWorkerId: homeWorkerId }, 60_000)
    await page.waitForTimeout(BENCH_SECONDS * 1_000)

    const events = await trace(page)
    const embedWorkerId = torrentPoints(events).find((point) => point.workerId !== homeWorkerId)?.workerId
    const embedPoints = embedWorkerId === undefined ? [] : torrentPoints(events, embedWorkerId)
    const firstKnownIndex = embedPoints.findIndex((point) => point.totalDone !== null)
    const measuredEmbedPoints = firstKnownIndex < 0 ? [] : embedPoints.slice(firstKnownIndex)
    const embedBaseline = measuredEmbedPoints[0]?.totalDone ?? 0
    const firstRead = events.find((event) => event.workerId === embedWorkerId && event.direction === 'out' && event.type === 'read')
    const firstReadResult = firstRead
      ? events.find((event) => event.workerId === embedWorkerId && event.direction === 'in' && event.type === 'read-result' && event.id === firstRead.id)
      : undefined
    const firstReadError = firstRead
      ? events.find((event) => event.workerId === embedWorkerId && event.direction === 'in' && event.type === 'read-error' && event.id === firstRead.id)
      : undefined
    const playingAt = await page.evaluate(() => (window as any).__ripplePlayingAt as number | null)
    const report = {
      browser: testInfo.project.name,
      secondsAfterWatch: BENCH_SECONDS,
      homeWorkerId,
      embedWorkerId: embedWorkerId ?? null,
      home: analyze(homePoints, homeAddAt),
      embed: analyze(measuredEmbedPoints, watchAt, embedBaseline),
      homeWorkerTerminated: events.some((event) => event.workerId === homeWorkerId && event.type === 'terminated'),
      firstReadMs: firstRead ? firstRead.at - watchAt : null,
      firstReadResultMs: firstRead && firstReadResult ? firstReadResult.at - firstRead.at : null,
      firstReadBytes: firstReadResult?.bytes ?? 0,
      firstReadError: firstReadError?.error ?? null,
      playingMs: playingAt === null ? null : playingAt - watchAt,
      failures: failureEvents(events),
    }
    await attachReport(testInfo, 'home-to-watch-ramp', report)

    expect(report.homeWorkerTerminated).toBe(true)
    expect(embedWorkerId).toBeDefined()
    expect(measuredEmbedPoints.length).toBeGreaterThan(1)
    expect(report.failures).toEqual([])
    expect(report.firstReadError).toBeNull()
    expect(report.firstReadBytes).toBeGreaterThan(0)
    if (REQUIRE_BYTES) expect(report.embed.finalBytes).toBeGreaterThan(0)
  })
})
