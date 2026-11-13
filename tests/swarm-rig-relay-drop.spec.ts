// The swarm rig's relay taken away mid-download and brought back, as a relay restart does it.
// The engine worker must keep posting state, the VPN readout must leave On while the relay is gone
// and come back to it, and the file must finish with the fixture's bytes. Engine 0.3.21 fails it:
// its worker spins inside one tick from the UDP socket's error on and never posts again.
// Runs only under playwright.rig.config.ts, after the lane's own spec (`npm run e2e:rig`, see tests/swarm-rig/README.md).

import type { Page, Worker } from '@playwright/test'

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { DEMO_SEEDED_KEY } from '../src/torrent/constants'
import { ensureFixture, magnetFor, type Fixture } from './swarm-rig/fixture'
import { readFixture } from './swarm-rig/opfs'
import { SeederFleet } from './swarm-rig/seeders'

test.use({ headless: false })

const topology = JSON.parse(readFileSync(new URL('./swarm-rig/topology.json', import.meta.url), 'utf8'))
const STATE = process.env.RIPPLE_RIG_STATE ?? join(tmpdir(), 'ripple-swarm-rig')
const OUTAGE_MS = Number(process.env.RIPPLE_RIG_OUTAGE_MS ?? 20_000)
// 4 seeders at 100 kB/s move the 30 MB fixture in about 75 s, so the outage lands mid-download
const SEEDER_KBPS = Number(process.env.RIPPLE_RIG_SEEDER_KBPS ?? 100)
const OUTAGE_AT = Number(process.env.RIPPLE_RIG_OUTAGE_AT ?? 0.2)
const RECOVERY_BUDGET_MS = Number(process.env.RIPPLE_RIG_RECOVERY_MS ?? 420_000)
const RESULT_FILE = process.env.RIPPLE_RIG_RESULT
const { relay } = topology

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Listener = { transport: string, port: number | null, up: boolean, healing: boolean, attempts: number }
type Sample = {
  t: number
  /** ms since the page last received a state message from the engine worker */
  sinceState: number | null
  states: number
  /** whether the engine worker's own event loop answered an evaluate within 800 ms */
  worker: 'ok' | 'timeout' | 'pending' | 'none'
  done: number
  rate: number
  peers: number
  vpn: string | null
  vpnText: string | null
  derived: string | null
  listeners: Listener[] | null
  peerList: { endpoint: string, utp: boolean, total: number, rate: number, fail: number, rtt: number, req: number }[]
}
type Event = { t: number, what: string }

/** The torrent's numbers, its peers and the listener health, read off the engine worker's state messages. */
const instrument = (page: Page, fixture: Fixture) => page.addInitScript(({ key, infoHash }) => {
  localStorage.setItem(key, '1')
  const r = { states: 0, lastStateAt: 0, done: 0, rate: 0, peers: 0, reachable: null as unknown, changes: [] as unknown[], inspected: false, peerList: [] as unknown[], peerChanges: [] as unknown[] }
  Object.assign(window, { __r67: r })
  let lastKey = ''
  let lastPeerKey = ''
  const NativeWorker = window.Worker
  const Wrapped = function (url: string | URL, options?: WorkerOptions) {
    const worker = new NativeWorker(url, options)
    worker.addEventListener('message', (event: MessageEvent) => {
      const m = event.data
      if (m?.type !== 'state' || !Array.isArray(m.torrents)) return
      r.states++
      r.lastStateAt = Date.now()
      if (m.reachable) {
        r.reachable = m.reachable
        const { port, portOpen, listening, listeners } = m.reachable
        const k = JSON.stringify({ port, portOpen, listening, listeners })
        if (k !== lastKey) { lastKey = k; r.changes.push({ t: Date.now(), port, portOpen, listening, listeners }) }
      }
      for (const torrent of m.torrents) {
        if (!String(torrent.magnet ?? '').toLowerCase().includes(infoHash)) continue
        r.done = torrent.status?.totalDone ?? 0
        r.rate = torrent.status?.downloadRate ?? 0
        r.peers = torrent.status?.numPeers ?? 0
        if (!r.inspected && typeof torrent.handle === 'number') { r.inspected = true; worker.postMessage({ type: 'inspect', handle: torrent.handle }) }
      }
      if (Array.isArray(m.detail?.peers)) {
        r.peerList = m.detail.peers.map((p: { endpoint: string, flags: number, totalDownload: number, downloadRate: number, failCount: number, rtt: number, requestsInFlight: number }) => ({
          // the engine's DHT is on, so a peer off loopback is a stranger, and its address is not kept
          endpoint: p.endpoint.startsWith('127.') ? p.endpoint : 'dht peer', utp: (p.flags & (1 << 17)) !== 0, total: p.totalDownload, rate: p.downloadRate, fail: p.failCount, rtt: p.rtt, req: p.requestsInFlight,
        }))
        const k = JSON.stringify((r.peerList as { endpoint: string, utp: boolean }[]).map((p) => `${p.endpoint}${p.utp ? '/utp' : '/tcp'}`).sort())
        if (k !== lastPeerKey) { lastPeerKey = k; r.peerChanges.push({ t: Date.now(), peers: r.peerList }) }
      }
    })
    return worker
  } as unknown as typeof Worker
  Object.setPrototypeOf(Wrapped, NativeWorker)
  Wrapped.prototype = NativeWorker.prototype
  Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: Wrapped })
}, { key: DEMO_SEEDED_KEY, infoHash: fixture.infoHash })

const readSample = (page: Page) => page.evaluate(() => {
  const r = (window as unknown as { __r67: { states: number, lastStateAt: number, done: number, rate: number, peers: number, reachable: { port: number | null, listeners?: { up: boolean, healing: boolean }[] } | null } }).__r67
  const item = document.querySelector('.item.vpn')
  const reach = r.reachable
  const listeners = reach?.listeners ?? []
  // vpn-status.ts's rule, for a moment the overlay is not drawn
  const derived = !reach ? null : reach.port !== null && listeners.some((l) => l.up) ? 'on' : listeners.some((l) => l.healing) ? 'healing' : 'off'
  return {
    t: Date.now(),
    sinceState: r.lastStateAt ? Date.now() - r.lastStateAt : null,
    states: r.states,
    done: r.done,
    rate: r.rate,
    peers: r.peers,
    vpn: item?.getAttribute('data-state') ?? null,
    vpnText: item?.textContent?.trim() ?? null,
    derived,
    listeners: (reach?.listeners as never) ?? null,
    peerList: (r as unknown as { peerList: unknown[] }).peerList,
  }
})

const listening = (proto: 't' | 'u', port: number) => {
  const out = spawnSync('ss', [`-H${proto}lnp`, `( sport = :${port} )`], { encoding: 'utf8' }).stdout
  return { up: out.trim() !== '', pid: /pid=(\d+)/.exec(out)?.[1] }
}

/**
 * The relay the config started, captured from the running process (binary, environment, working
 * directory) so the restart is the same relay on the same certificate, as a restarted relay is. The
 * relay installs no signal handler, so SIGTERM ends it at once and its sessions are not closed.
 */
const RELAY_WATCHDOG = [
  'owner=$1; shift',
  '"$@" & d=$!',
  'while kill -0 "$owner" 2>/dev/null && kill -0 "$d" 2>/dev/null; do sleep 0.5; done',
  'kill -9 "$d" 2>/dev/null; wait "$d"',
].join('\n')

const captureRelay = () => {
  const { pid } = listening('t', relay.http)
  if (!pid) throw new Error(`nothing listens on ${relay.http}`)
  const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((entry) => {
    const at = entry.indexOf('=')
    return [entry.slice(0, at), entry.slice(at + 1)]
  }))
  return { pid: Number(pid), exe: readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''), cwd: readlinkSync(`/proc/${pid}/cwd`), env }
}

const relayDown = () => !listening('t', relay.http).up && !listening('t', relay.websocket).up && !listening('u', relay.webtransport).up

const stopRelay = async (pid: number) => {
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 5_000
  while (!relayDown() && Date.now() < deadline) await sleep(50)
  if (!relayDown()) {
    process.kill(pid, 'SIGKILL')
    await sleep(500)
    if (!relayDown()) throw new Error('the relay still listens after SIGKILL')
  }
}

let restarted: { pid: number } | null = null
const startRelay = async (captured: ReturnType<typeof captureRelay>, log: string) => {
  const fd = openSync(log, 'a')
  const child = spawn('sh', ['-c', RELAY_WATCHDOG, 'relay', String(process.pid), captured.exe], {
    cwd: captured.cwd, env: captured.env, stdio: ['ignore', fd, fd], detached: true,
  })
  closeSync(fd)
  restarted = { pid: child.pid! }
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const ok = await fetch(`http://${relay.host}:${relay.http}/health`).then((r) => r.ok, () => false)
    if (ok) return
    await sleep(100)
  }
  throw new Error(`the restarted relay never answered /health, see ${log}`)
}

/** Caps a seeder's upload over its RPC and reads the cap back. */
const throttle = async (rpcPort: number, kBps: number) => {
  let sid = ''
  const call = async (method: string, args: Record<string, unknown>) => {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${rpcPort}/transmission/rpc`, {
        method: 'POST', headers: { 'x-transmission-session-id': sid }, body: JSON.stringify({ method, arguments: args }),
      })
      if (response.status === 409) { sid = response.headers.get('x-transmission-session-id') ?? ''; continue }
      const body = await response.json() as { result: string, arguments: Record<string, unknown> }
      if (body.result !== 'success') throw new Error(`transmission ${method} on ${rpcPort}: ${body.result}`)
      return body.arguments
    }
    throw new Error(`transmission ${method} on ${rpcPort}: no session id`)
  }
  await call('session-set', { 'speed-limit-up': kBps, 'speed-limit-up-enabled': true })
  const got = await call('session-get', { fields: ['speed-limit-up', 'speed-limit-up-enabled'] })
  return { limit: got['speed-limit-up'], enabled: got['speed-limit-up-enabled'] }
}

/** Whether the engine worker's event loop answers, never stacking a probe on one still waiting. */
const workerProbe = () => {
  let pending = false
  return async (worker: Worker | undefined): Promise<Sample['worker']> => {
    if (!worker) return 'none'
    if (pending) return 'pending'
    pending = true
    const answer = worker.evaluate(() => Date.now()).then(() => { pending = false; return 'ok' as const }, () => { pending = false; return 'none' as const })
    return Promise.race([answer, sleep(800).then(() => 'timeout' as const)])
  }
}

export type Verdict = {
  maxGapMs: number
  maxGapDuring: number
  readoutLeftOn: boolean
  readoutBackOn: boolean
  completeMs: number | null
  matched: boolean
}

/** The whole claim, as one function, so a run on engine 0.3.21 can be shown to fail it. */
export const assertHeld = (v: Verdict, size: number, opfs: { matchedBytes: number, sha256: string | null }, sha256: string) => {
  expect(v.maxGapMs, 'the engine worker went silent').toBeLessThan(5_000)
  expect(v.readoutLeftOn, 'the readout never left On while the relay was gone').toBe(true)
  expect(v.readoutBackOn, 'the readout never came back to On').toBe(true)
  expect(v.completeMs, 'the download never finished after the relay came back').not.toBeNull()
  expect(opfs.matchedBytes, 'OPFS does not hold the fixture piece for piece').toBe(size)
  expect(opfs.sha256, 'the OPFS file is not the fixture').toBe(sha256)
}

test('a relay taken away mid-download leaves the engine running, and the download finishes', async ({ playwright, launchOptions, viewport, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'rig', 'needs playwright.rig.config.ts: the relay, broker and seeders')
  test.setTimeout(30_000 + 180_000 + OUTAGE_MS + RECOVERY_BUDGET_MS + 60_000)

  const fixture = ensureFixture({ root: join(STATE, 'fixture') })
  const dir = join(STATE, 'seeders', 'relay-drop')
  rmSync(dir, { recursive: true, force: true })
  const fleet = new SeederFleet({ dir, dataDir: fixture.dir, torrentFile: fixture.torrentFile, ...topology.seeders })
  const events: Event[] = []
  const samples: Sample[] = []
  const consoleLines: { t: number, from: string, type: string, text: string }[] = []
  const event = (what: string) => { events.push({ t: Date.now(), what }); console.log(`r67 ${new Date().toISOString()} ${what}`) }
  const result: Record<string, unknown> = {}
  let sampling = true
  let sampler: Promise<void> | null = null

  const context = await playwright.chromium.launchPersistentContext('', { ...launchOptions, headless: false, baseURL, viewport })
  try {
    await fleet.start()
    await fleet.waitSeeding()
    const caps: unknown[] = []
    for (let i = 0; i < fleet.peers.length; i++) caps.push(await throttle(topology.seeders.baseRpcPort + i, SEEDER_KBPS))
    event(`fleet of ${fleet.peers.length} seeding, upload caps ${JSON.stringify(caps)}`)

    const page = context.pages()[0] ?? await context.newPage()
    page.on('console', (message) => {
      const from = message.worker() ? `worker ${message.worker()!.url().replace(/^.*\//, '')}` : message.location().url.replace(/^(https?:\/\/[^/]+).*$/, '$1')
      if (consoleLines.length < 4000) consoleLines.push({ t: Date.now(), from, type: message.type(), text: message.text().slice(0, 500) })
    })
    page.on('pageerror', (error) => consoleLines.push({ t: Date.now(), from: 'pageerror', type: 'error', text: String(error).slice(0, 500) }))
    let engine: Worker | undefined
    const pick = (worker: Worker) => { if (/\/assets\/worker-[\w-]+\.js/.test(worker.url())) engine = worker }
    page.on('worker', pick)
    await instrument(page, fixture)
    await page.goto(`/watch?${new URLSearchParams({ magnet: Buffer.from(magnetFor(fixture, fleet.peers)).toString('base64'), fileIndex: '0' })}`)
    await page.bringToFront()
    event('visit')
    for (const worker of page.workers()) pick(worker)

    const probe = workerProbe()
    sampler = (async () => {
      while (sampling) {
        const started = Date.now()
        const [s, worker] = await Promise.all([
          Promise.race([readSample(page), sleep(2_000).then(() => null)]).catch(() => null),
          probe(engine),
        ])
        if (s) samples.push({ ...s, worker } as Sample)
        await sleep(Math.max(0, 1_000 - (Date.now() - started)))
      }
    })()
    const last = () => samples.at(-1)

    const armDeadline = Date.now() + 180_000
    while (Date.now() < armDeadline) {
      const s = last()
      if (s && s.done >= fixture.size * OUTAGE_AT && (s.vpn ?? s.derived) === 'on') break
      if (s && s.done >= fixture.size) break
      await sleep(250)
    }
    const before = last()
    if (!before || before.done >= fixture.size || before.done < fixture.size * OUTAGE_AT) {
      const spoiled = before && before.done >= fixture.size ? 'finished before the outage' : 'never reached the outage mark'
      result.spoiled = spoiled
      throw new Error(`spoiled: ${spoiled}`)
    }

    const captured = captureRelay()
    result.relay = { pid: captured.pid, exe: captured.exe, cwd: captured.cwd }
    event(`relay down: SIGTERM to webvpn pid ${captured.pid} (${captured.exe.replace(/^.*\//, '')}, tcp ${relay.http}/${relay.websocket}, udp ${relay.webtransport}) at ${before.done} bytes`)
    const tStop = Date.now()
    result.tStop = tStop
    await stopRelay(captured.pid)
    event(`relay gone from its ports after ${Date.now() - tStop} ms`)
    await sleep(OUTAGE_MS)
    const tStart = Date.now()
    result.tStart = tStart
    await startRelay(captured, join(STATE, 'relay-restart.log'))
    event(`relay back (pid ${listening('t', relay.http).pid}) and answering /health after ${Date.now() - tStart} ms`)

    const deadline = Date.now() + RECOVERY_BUDGET_MS
    let completeAt: number | null = null
    let silent = false
    while (Date.now() < deadline) {
      const s = last()
      if (s && s.done >= fixture.size) { completeAt = s.t; break }
      if (s && (s.sinceState ?? 0) > 90_000 && Date.now() > tStart + 30_000) { silent = true; break }
      await sleep(250)
    }
    event(completeAt ? 'complete' : silent ? 'engine silent for 90 s with the relay back, stopping early' : 'recovery budget spent')
    await sleep(5_000)
    sampling = false
    await sampler

    const after = samples.filter((s) => s.t >= tStop)
    const gaps = samples.map((s) => s.sinceState ?? 0)
    const word = (s: Sample) => s.vpn ?? s.derived
    const leftOn = after.find((s) => word(s) !== 'on')
    const backOn = leftOn ? after.find((s) => s.t > Math.max(tStart, leftOn.t) && word(s) === 'on') : undefined
    const resumed = after.find((s) => s.t > tStart && s.done > (samples.filter((x) => x.t <= tStart + 500).at(-1)?.done ?? Infinity))
    const verdict: Verdict = {
      maxGapMs: Math.max(...gaps),
      maxGapDuring: Math.max(0, ...after.map((s) => s.sinceState ?? 0)),
      readoutLeftOn: after.some((s) => s.t < tStart + 60_000 && word(s) === 'healing'),
      readoutBackOn: !!backOn && word(samples.at(-1)!) === 'on',
      completeMs: completeAt ? completeAt - tStop : null,
      matched: false,
    }
    const opfs = await Promise.race([readFixture(page, fixture), sleep(20_000).then(() => ({ found: false, size: 0, matchedBytes: 0, sha256: 'OPFS read timed out', layout: null }))])
    verdict.matched = opfs.matchedBytes === fixture.size && opfs.sha256 === fixture.sha256
    Object.assign(result, {
      verdict, opfs,
      leftOnAfterStopMs: leftOn ? leftOn.t - tStop : null,
      leftOnAs: leftOn ? word(leftOn) : null,
      backOnAfterStartMs: backOn ? backOn.t - tStart : null,
      bytesResumedAfterStartMs: resumed ? resumed.t - tStart : null,
      uploaded: await fleet.uploaded(),
    })
    console.log(`swarm-rig relay-drop ${JSON.stringify({ ...verdict, leftOnAs: result.leftOnAs, backOnAfterStartMs: result.backOnAfterStartMs, bytesResumedAfterStartMs: result.bytesResumedAfterStartMs, layout: opfs.layout })}`)
    assertHeld(verdict, fixture.size, opfs, fixture.sha256)
  } finally {
    sampling = false
    await sampler?.catch(() => {})
    const page = context.pages()[0]
    if (page) {
      result.changes = await Promise.race([
        page.evaluate(() => (window as unknown as { __r67?: { changes: unknown[] } }).__r67?.changes ?? null),
        sleep(5_000).then(() => 'timed out'),
      ]).catch((e) => String(e))
      result.peerChanges = await Promise.race([
        page.evaluate(() => (window as unknown as { __r67?: { peerChanges: unknown[] } }).__r67?.peerChanges ?? null),
        sleep(5_000).then(() => 'timed out'),
      ]).catch((e) => String(e))
    }
    if (RESULT_FILE) {
      writeFileSync(RESULT_FILE, JSON.stringify({ fixture: { size: fixture.size, sha256: fixture.sha256, infoHash: fixture.infoHash }, ...result, events, samples, consoleLines }, null, 2))
    }
    await context.close().catch(() => {})
    await fleet.stop().catch(() => {})
    if (restarted) {
      try { process.kill(-restarted.pid, 'SIGKILL') } catch {}
      restarted = null
    }
  }
})
