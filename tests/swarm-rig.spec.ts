// Ripple downloading a torrent that exists only on this machine, from seeders on loopback, through a
// local relay and broker, into OPFS. The whole chain, with no public peer able to serve a byte.
//
// Every other swarm spec rides the public swarm, where byte-identical code measured 14.7 s to 73.4 s
// to first frame. Here the only source is the fleet the magnet names, so a number can move for a
// reason. The engine's DHT is still on and announces the infohash through the relay, which is why
// the seeders' own upload count is part of the claim. Runs only under playwright.rig.config.ts
// (`npm run test:e2e:rig`, see the README).

import type { BrowserType, LaunchOptions, Page, ViewportSize } from '@playwright/test'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test } from '@playwright/test'

import { DEMO_SEEDED_KEY } from '../src/torrent/constants'
import { ensureFixture, magnetFor, type Fixture } from './swarm-rig/fixture'
import { SeederFleet } from './swarm-rig/seeders'

// headful by project rule: headless Chromium parks every transfer at a flat 0 B/s
test.use({ headless: false })
test.describe.configure({ mode: 'serial' })

const topology = JSON.parse(readFileSync(new URL('./swarm-rig/topology.json', import.meta.url), 'utf8'))
const STATE = process.env.RIPPLE_RIG_STATE ?? join(tmpdir(), 'ripple-swarm-rig')
const SWARM_BUDGET_MS = Number(process.env.RIPPLE_RIG_BUDGET_MS ?? 120_000)
const CONTROL_WINDOW_MS = Number(process.env.RIPPLE_RIG_CONTROL_MS ?? 30_000)
const SEEDERS = Number(process.env.RIPPLE_RIG_SEEDERS ?? topology.seeders.count)

type Marks = Partial<Record<'addMagnet' | 'firstPeer' | 'metadata' | 'firstByte' | 'complete' | 'video' | 'firstFrame', number>>

type Arm = {
  marks: Marks
  /** The most the engine ever reported holding, in bytes. */
  bytes: number
  peers: number
  /** What OPFS holds for the fixture, counted in pieces that hash to the fixture's own. */
  opfs: { found: boolean, size: number, matchedBytes: number, sha256: string | null, locked: boolean }
  brokers: string[]
  uploaded: number[]
  errors: string[]
}

/**
 * Every claim the swarm arm makes, as one function so the control can prove it FAILS.
 *
 * A check that cannot fail reports success unconditionally, so the control runs this same function
 * against a run whose seeders are gone and requires it to throw.
 */
const assertDelivered = (arm: Arm, fixture: Fixture) => {
  expect(arm.marks.firstByte, 'no byte ever arrived').toBeDefined()
  expect(arm.bytes, 'the engine never held the whole file').toBe(fixture.size)
  expect(arm.opfs.matchedBytes, 'OPFS does not hold the fixture piece for piece').toBe(fixture.size)
  expect(arm.opfs.sha256, 'the OPFS file is not the fixture').toBe(fixture.sha256)
  expect(arm.marks.firstFrame, 'no frame was rendered').toBeDefined()
  // the swarm's own account: nobody but the fleet can have served a payload that exists only here
  expect(arm.uploaded.reduce((a, b) => a + b, 0), 'the seeders uploaded less than the file').toBeGreaterThanOrEqual(fixture.size)
}

const pieceHashes = (fixture: Fixture) => {
  const bytes = readFileSync(fixture.file)
  const out: string[] = []
  for (let at = 0; at < bytes.length; at += fixture.pieceLength) {
    out.push(createHash('sha1').update(bytes.subarray(at, at + fixture.pieceLength)).digest('hex'))
  }
  return out
}

/** Armed before navigation, so the add, the first byte and the first painted frame are all seen. */
const instrument = (page: Page, fixture: Fixture) => page.addInitScript(({ key, infoHash, size }) => {
  // the first-run demo is a public torrent; with it suppressed, the fixture is the only one
  localStorage.setItem(key, '1')
  const marks: Record<string, number> = {}
  const rig = { marks, bytes: 0, peers: 0 }
  Object.assign(window, { __rig: rig })
  const mark = (name: string) => { if (!(name in marks)) marks[name] = performance.now() }

  const NativeWorker = window.Worker
  const Wrapped = function (url: string | URL, options?: WorkerOptions) {
    const worker = new NativeWorker(url, options)
    worker.addEventListener('message', (event: MessageEvent) => {
      const message = event.data
      if (message?.type !== 'state' || !Array.isArray(message.torrents)) return
      for (const torrent of message.torrents) {
        if (!String(torrent.magnet ?? '').toLowerCase().includes(infoHash)) continue
        const done = torrent.status?.totalDone ?? 0
        const peers = torrent.status?.numPeers ?? 0
        rig.bytes = Math.max(rig.bytes, done)
        rig.peers = Math.max(rig.peers, peers)
        if (torrent.files) mark('metadata')
        if (peers > 0) mark('firstPeer')
        if (done > 0) mark('firstByte')
        if (done >= size) mark('complete')
      }
    })
    const post = worker.postMessage.bind(worker)
    worker.postMessage = ((message: { type?: string }, transfer?: Transferable[]) => {
      if (message?.type === 'add-magnet') mark('addMagnet')
      return transfer === undefined ? post(message) : post(message, transfer)
    }) as typeof worker.postMessage
    return worker
  } as unknown as typeof Worker
  Object.setPrototypeOf(Wrapped, NativeWorker)
  Wrapped.prototype = NativeWorker.prototype
  Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: Wrapped })

  // setInterval rather than rAF, which an unfocused page throttles until the poll never runs
  const poll = setInterval(() => {
    const video = document.querySelector('video')
    if (!video) return
    mark('video')
    video.requestVideoFrameCallback(() => mark('firstFrame'))
    if ('firstFrame' in marks) clearInterval(poll)
  }, 100)
}, { key: DEMO_SEEDED_KEY, infoHash: fixture.infoHash, size: fixture.size })

/**
 * The fixture's bytes as OPFS holds them, verified piece by piece against the torrent.
 *
 * Matching pieces rather than reading a size, because a size says nothing about content and the
 * control needs a number that is 0 exactly when nothing real arrived.
 */
const readOpfs = (page: Page, fixture: Fixture) => page.evaluate(async ({ infoHash, name, pieceLength, hashes }) => {
  const empty = { found: false, size: 0, matchedBytes: 0, sha256: null as string | null, locked: false }
  let dir = await navigator.storage.getDirectory()
  for (const segment of ['dl', infoHash]) {
    const next = await dir.getDirectoryHandle(segment).catch(() => null)
    if (!next) return empty
    dir = next
  }
  const find = async (at: FileSystemDirectoryHandle): Promise<FileSystemFileHandle | null> => {
    for await (const child of (at as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()) {
      if (child.kind === 'file' && child.name === name) return child as FileSystemFileHandle
      if (child.kind === 'directory') {
        const found = await find(child as FileSystemDirectoryHandle)
        if (found) return found
      }
    }
    return null
  }
  const handle = await find(dir)
  if (!handle) return empty
  let file: File
  try {
    file = await handle.getFile()
  } catch {
    return { ...empty, found: true, locked: true }
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
  let matchedBytes = 0
  for (const [i, expected] of hashes.entries()) {
    const piece = bytes.subarray(i * pieceLength, (i + 1) * pieceLength)
    if (piece.length && hex(await crypto.subtle.digest('SHA-1', piece)) === expected) matchedBytes += piece.length
  }
  return { found: true, size: file.size, matchedBytes, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)), locked: false }
}, { infoHash: fixture.infoHash, name: fixture.name, pieceLength: fixture.pieceLength, hashes: pieceHashes(fixture) })

type Browser = { type: BrowserType, launchOptions: LaunchOptions, viewport: ViewportSize | null, baseURL: string | undefined }

/**
 * One cold visit to `/watch` for the magnet, in a fresh REGULAR profile.
 *
 * Not Playwright's stock context: that is off the record, and Chrome 153 crashes the whole browser
 * reading a FileSystemHandle back out of IndexedDB in such a profile (ripple.md, 2026-09-27).
 */
const visit = async (browser: Browser, fixture: Fixture, magnet: string, until: 'delivered' | 'window', ms: number) => {
  // an empty path is a temporary profile Playwright deletes on close
  const context = await browser.type.launchPersistentContext('', {
    ...browser.launchOptions,
    headless: false,
    baseURL: browser.baseURL,
    viewport: browser.viewport,
  })
  try {
    const page = context.pages()[0] ?? await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await instrument(page, fixture)
    await page.goto(`/watch?${new URLSearchParams({ magnet: Buffer.from(magnet).toString('base64'), fileIndex: '0' })}`)
    // rVFC is throttled in a background page exactly like rAF
    await page.bringToFront()

    if (until === 'delivered') {
      await page.waitForFunction(() => {
        const marks = (window as unknown as { __rig: { marks: Marks } }).__rig.marks
        return marks.complete !== undefined && marks.firstFrame !== undefined
      }, undefined, { timeout: ms, polling: 250 }).catch(() => {})
    } else {
      await page.waitForTimeout(ms)
    }

    const rig = await page.evaluate(() => (window as unknown as { __rig: { marks: Marks, bytes: number, peers: number } }).__rig)
    const brokers = await page.locator('iframe').evaluateAll((frames) => frames.map((frame) => (frame as HTMLIFrameElement).src))
    return { ...rig, brokers, errors, opfs: await readOpfs(page, fixture) }
  } finally {
    await context.close()
  }
}

const fleetFor = (fixture: Fixture, arm: string) => {
  const dir = join(STATE, 'seeders', arm)
  rmSync(dir, { recursive: true, force: true })
  return new SeederFleet({ dir, dataDir: fixture.dir, torrentFile: fixture.torrentFile, ...topology.seeders, count: SEEDERS })
}

const since = (marks: Marks, from: keyof Marks, to: keyof Marks) => {
  const start = marks[from]
  const end = marks[to]
  return start === undefined || end === undefined ? null : Math.round(end - start)
}

let fixture: Fixture

test.beforeAll(({}, testInfo) => {
  if (testInfo.project.name === 'rig') fixture = ensureFixture({ root: join(STATE, 'fixture') })
})

test.describe('the swarm rig', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'rig', 'needs the relay, broker and seeders playwright.rig.config.ts starts: npm run test:e2e:rig')
  })

  test('answers as configured: relay, broker and the build that names them', async ({ request }) => {
    const { relay, broker } = topology

    expect((await request.get(`http://${relay.host}:${relay.http}/health`)).ok(), 'the relay is not answering').toBe(true)
    expect((await (await request.get(`http://${relay.host}:${relay.http}/cert-hash`)).text()).trim(), 'the relay serves no certificate hash to pin').not.toBe('')

    // the settings that make this a swarm rig are read off the RUNNING relay, not the config that meant to set them
    const listener = spawnSync('ss', ['-Htlnp', `( sport = :${relay.http} )`], { encoding: 'utf8' }).stdout
    const pid = /pid=(\d+)/.exec(listener)?.[1]
    expect(pid, `nothing of ours listens on ${relay.http}`).toBeDefined()
    const environ = new Map(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map((entry) => {
      const at = entry.indexOf('=')
      return [entry.slice(0, at), entry.slice(at + 1)] as const
    }))
    expect(environ.get('WEBVPN_BLOCK_PRIVATE_TARGETS'), 'the relay refuses 127.0.0.x, where every seeder is').toBe('false')
    expect(environ.get('FREE_RATE_BYTES_PER_SEC'), 'the relay keeps its 10 MiB/s per-IP default, which one tab shares').toBe(String(topology.freeRateBytesPerSec))

    // /api must be the broker's own document: the SPA fallback answers 200 with index.html for it too
    const api = readFileSync(resolve(process.env.RIPPLE_RIG_FKN_CLIENT ?? '', 'web/build/api.html'), 'utf8')
    expect(await (await request.get(`${broker.origin}/api`)).text(), `${broker.origin}/api is not the broker`).toBe(api)

    expect(fixture.private, 'a private fixture never serves metadata to a magnet').toBe(false)
  })

  test('delivers the fixture from local seeders into OPFS and plays it', async ({ playwright, launchOptions, viewport, baseURL }, testInfo) => {
    const fleet = fleetFor(fixture, 'swarm')
    try {
      await fleet.start()
      await fleet.waitSeeding()
      const magnet = magnetFor(fixture, fleet.peers)
      const run = await visit({ type: playwright.chromium, launchOptions, viewport, baseURL }, fixture, magnet, 'delivered', SWARM_BUDGET_MS)
      // transmission accounts uploads on its own tick, so give the last blocks a moment to be counted
      let uploaded = await fleet.uploaded()
      for (let i = 0; i < 20 && uploaded.reduce((a, b) => a + b, 0) < fixture.size; i++) {
        await new Promise((r) => setTimeout(r, 250))
        uploaded = await fleet.uploaded()
      }
      const arm: Arm = { ...run, uploaded }

      const report = {
        infoHash: fixture.infoHash,
        size: fixture.size,
        seeders: fleet.peers.length,
        firstByteMs: since(arm.marks, 'addMagnet', 'firstByte'),
        firstFrameMs: since(arm.marks, 'addMagnet', 'firstFrame'),
        completeMs: since(arm.marks, 'addMagnet', 'complete'),
        metadataMs: since(arm.marks, 'addMagnet', 'metadata'),
        peers: arm.peers,
        uploaded,
        opfs: arm.opfs,
        brokers: arm.brokers,
        errors: arm.errors,
      }
      // eslint-disable-next-line no-console
      console.log(`swarm-rig ${JSON.stringify(report)}`)
      await testInfo.attach('swarm-rig.json', { body: JSON.stringify({ report, marks: arm.marks }, null, 2), contentType: 'application/json' })

      expect(arm.brokers.some((src) => src.startsWith(`${topology.broker.origin}/api`)), `no broker frame at ${topology.broker.origin}, so this build is not the rig's`).toBe(true)
      expect(arm.brokers.filter((src) => /fkn\.app/.test(src)), 'a broker frame points at production').toEqual([])
      assertDelivered(arm, fixture)
    } finally {
      await fleet.stop()
    }
  })

  test('control: with the seeders stopped nothing arrives, and the same check fails', async ({ playwright, launchOptions, viewport, baseURL }) => {
    // the fleet comes up and goes down, so the magnet names real addresses with nothing behind them
    const fleet = fleetFor(fixture, 'control')
    await fleet.start()
    await fleet.waitSeeding()
    await fleet.stop()

    const run = await visit({ type: playwright.chromium, launchOptions, viewport, baseURL }, fixture, magnetFor(fixture, fleet.peers), 'window', CONTROL_WINDOW_MS)
    const arm: Arm = { ...run, uploaded: [] }
    // eslint-disable-next-line no-console
    console.log(`swarm-rig control ${JSON.stringify({ bytes: arm.bytes, peers: arm.peers, marks: arm.marks, opfs: arm.opfs })}`)

    expect(arm.brokers.some((src) => src.startsWith(`${topology.broker.origin}/api`)), 'the control never reached the broker, so its zero proves nothing').toBe(true)
    expect(arm.marks.addMagnet, 'the control never added the magnet, so its zero proves nothing').toBeDefined()
    expect(arm.bytes).toBe(0)
    expect(arm.opfs.matchedBytes).toBe(0)
    expect(() => assertDelivered(arm, fixture), 'the delivery check passed on a run with no seeders').toThrow()
  })
})
