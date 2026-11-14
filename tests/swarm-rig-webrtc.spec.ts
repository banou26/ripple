// WebRTC peers on the swarm rig, with the VPN on and off, and the switch between the two on every surface.
// The relay, the broker, the proxy, the tracker and the name resolver are all this machine's, inside the
// network tests/swarm-rig/netns.sh makes, so nothing here reaches another machine.
//
// One library page stays through the file: it takes the fixture from the seeders with the VPN on, turns the
// VPN off after its warning, and from then on holds the fixture as a WebRTC peer that is not behind the relay.
// Runs only under playwright.rig.config.ts (`npm run e2e:rig`, see tests/swarm-rig/README.md).

import type { FrameLocator, Page } from '@playwright/test'

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { ensureFixture, magnetFor, type Fixture } from './swarm-rig/fixture'
import { readFixture } from './swarm-rig/opfs'
import { SeederFleet } from './swarm-rig/seeders'
import { add, announced, post, told, until, visitor, vpnOf, type Browser, type Surface, type Visitor } from './swarm-rig/visitor'

test.use({ headless: false })
test.describe.configure({ mode: 'serial' })

const topology = JSON.parse(readFileSync(new URL('./swarm-rig/topology.json', import.meta.url), 'utf8'))
const STATE = process.env.RIPPLE_RIG_STATE ?? join(tmpdir(), 'ripple-swarm-rig')
const RESULT_FILE = process.env.RIPPLE_RIG_RESULT
const { relay, proxy, resolver, tracker, broker, app } = topology
const TRACKER_URL = `ws://${tracker.name}:${tracker.port}`
const SENTENCE = 'Peers and trackers of every running torrent will see your IP address.'
// what a WebRTC seeder may send in a second, so a download lasts long enough for every kind of peer to give
const SEEDER_UP = 1_000_000
const SEEDER_KBPS = 150

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Seen = { names: Record<string, number>, tracker: { announces: number, offers: number, answers: number, sockets: number, connections: Record<string, number>, peers: number, candidates: string[] } }
const seen = async (): Promise<Seen> => (await fetch(`http://${relay.host}:${resolver.port}/seen`)).json() as Promise<Seen>

/** The proxy's own count of what it was asked: every request, whatever became of it, and those that reached their target. */
const proxied = async () => {
  const text = await (await fetch(`http://${relay.host}:${proxy.metrics}/metrics`)).text()
  const outcomes = [...text.matchAll(/^proxy_requests_total\{outcome="(\w+)"\} (\d+)/gm)].map(([, outcome, count]) => [outcome!, Number(count)] as const)
  return {
    requests: outcomes.reduce((sum, [, count]) => sum + count, 0),
    opened: outcomes.find(([outcome]) => outcome === 'success')?.[1] ?? 0,
  }
}

/**
 * The relay's own counts: the sessions it admitted and the bytes it carried since it started, which are what
 * it meters a person by, and the sockets it holds for its sessions right now. Nothing reaches a peer through
 * the relay without moving the first two, and nobody reaches a page through it without the third.
 */
const relayed = async () => {
  const text = await (await fetch(`http://${relay.host}:${relay.http}/metrics`)).text()
  const sum = (name: string) => [...text.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\d+)$`, 'gm'))].reduce((total, [, count]) => total + Number(count), 0)
  return { sessions: sum('webvpn_handshakes_total'), bytes: sum('webvpn_bandwidth_bytes_total'), sockets: sum('webvpn_active_sockets') }
}

/**
 * Every host a visitor's pages, frames and their workers ask from here on, with how often: requests and
 * WebSockets. FKN's frame talks to the relay and the proxy from a shared worker, which this does not see: the
 * relay's and the proxy's own counts are what say whether they were asked.
 */
const hostsOf = ({ context, page }: Visitor) => {
  const hosts: Record<string, number> = {}
  const count = (url: string) => {
    const { protocol, host } = new URL(url)
    if (host) hosts[`${protocol}//${host}`] = (hosts[`${protocol}//${host}`] ?? 0) + 1
  }
  context.on('request', (request) => count(request.url()))
  page.on('websocket', (socket) => count(socket.url()))
  return hosts
}

const pidOn = (port: number) => /pid=(\d+)/.exec(spawnSync('ss', ['-Htlnp', `( sport = :${port} )`], { encoding: 'utf8' }).stdout)?.[1]
/** Every UDP port a process of this machine holds, by its pid. */
const udpPorts = (pid: string) => new Set(
  spawnSync('ss', ['-Hulnp'], { encoding: 'utf8' }).stdout.split('\n')
    .filter((line) => line.includes(`pid=${pid},`))
    .map((line) => Number(/:(\d+)\s/.exec(line)?.[1])),
)

const logs = () => Object.fromEntries(['relay.log', 'proxy.log'].map((name) => [name, readFileSync(join(STATE, 'logs', name), 'utf8')]))

const wordOf = (scope: Page | FrameLocator) => vpnOf(scope).evaluate((element) => element.getAttribute('data-state') ?? element.querySelector('strong')?.textContent ?? '')

/** Each word the switch showed until `until`, with how long after the press it first did. */
const wordsUntil = async (scope: Page | FrameLocator, until: string, ms: number) => {
  const words: { word: string, ms: number }[] = []
  const started = Date.now()
  for (;;) {
    const word = (await wordOf(scope).catch(() => '')).toLowerCase()
    if (word && words.at(-1)?.word !== word) words.push({ word, ms: Date.now() - started })
    if (word === until) return words
    if (Date.now() - started > ms) throw new Error(`the switch never said ${until}: ${JSON.stringify(words)}`)
    await sleep(100)
  }
}

const watchPath = (magnet: string) => `/watch?${new URLSearchParams({ magnet: Buffer.from(magnet).toString('base64'), fileIndex: '0' })}`

let fixture: Fixture
let fleet: SeederFleet
let browser: Browser
/** The library page that holds the fixture with the VPN off from the second test on. */
let library: Visitor
const record: Record<string, unknown> = {}
const opened: Visitor[] = []

const open = async (vpn: 'on' | 'off' = 'on') => {
  const one = await visitor(browser, fixture.infoHash, vpn)
  opened.push(one)
  return one
}
const close = async (one: Visitor) => {
  opened.splice(opened.indexOf(one), 1)
  await one.context.close()
}

test.beforeAll(async ({}, testInfo) => {
  if (testInfo.project.name !== 'rig') return
  fixture = ensureFixture({ root: join(STATE, 'fixture') })
  const dir = join(STATE, 'seeders', 'webrtc')
  rmSync(dir, { recursive: true, force: true })
  fleet = new SeederFleet({ dir, dataDir: fixture.dir, torrentFile: fixture.torrentFile, ...topology.seeders })
  await fleet.start()
  await fleet.waitSeeding()
})

test.afterAll(async () => {
  if (RESULT_FILE) writeFileSync(RESULT_FILE, JSON.stringify(record, null, 2))
  for (const one of opened.splice(0)) await one.context.close().catch(() => {})
  await fleet?.stop().catch(() => {})
})

test.beforeEach(({ playwright, launchOptions, viewport, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'rig', 'needs the relay, broker, proxy and seeders playwright.rig.config.ts starts: npm run test:e2e:rig')
  browser = { type: playwright.chromium, launchOptions, viewport, baseURL }
})

test('the lane has a proxy, a tracker and a resolver of its own, and the build names them', async ({ request }) => {
  expect((await request.get(`http://${relay.host}:${proxy.metrics}/metrics`)).ok(), 'the proxy is not answering').toBe(true)
  expect((await request.get(`http://${relay.host}:${resolver.port}/seen`)).ok(), 'the tracker and the resolver are not answering').toBe(true)

  // read off the RUNNING processes, not the config that meant to set them
  const environ = (pid: string | undefined) => new Map(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map((entry) => {
    const at = entry.indexOf('=')
    return [entry.slice(0, at), entry.slice(at + 1)] as const
  }))
  expect(environ(pidOn(relay.http)).get('WEBVPN_DNS_UPSTREAM'), 'the relay asks a public resolver for names').toBe(`http://${relay.host}:${resolver.port}/dns-query`)
  const proxyEnv = environ(pidOn(proxy.port))
  expect(proxyEnv.get('BLOCK_PRIVATE_TARGETS'), 'the proxy refuses loopback, where the tracker is').toBe('false')
  expect(proxyEnv.get('CORS_DOMAINS'), 'the proxy admits another origin than the broker').toBe(broker.origin)

  // the tracker's name is this machine and no other name is anything, for the proxy as for the browser
  const resolved = (name: string) => spawnSync('getent', ['hosts', name], { encoding: 'utf8' }).stdout.trim()
  expect(resolved(tracker.name).split(/\s+/)[0]).toBe(tracker.address)
  expect(resolved('tracker.openwebtorrent.com'), 'a public name resolves on this lane').toBe('')

  // the engine worker of the served build knows the rig's tracker and neither public one
  const workers = readdirSync('build/assets').filter((name) => /^worker-.*\.js$/.test(name))
  expect(workers.length).toBeGreaterThan(0)
  for (const name of workers) {
    const worker = await (await request.get(`${app.origin}/assets/${name}`)).text()
    expect(worker.includes(TRACKER_URL), `${name} does not name the rig's tracker: build with RIPPLE_RIG_FKN_CLIENT set`).toBe(true)
    expect(worker.includes('wss://tracker.'), `${name} names a public tracker`).toBe(false)
  }
})

test('on the library the film arrives through the relay, the switch asks first, and with the VPN off the page is a WebRTC peer', async () => {
  test.setTimeout(300_000)
  const relayPid = pidOn(relay.http)!
  const idle = { sockets: (await relayed()).sockets, udp: [...udpPorts(relayPid)].sort() }
  library = await open()
  const { page } = library
  await page.goto('/')
  const vpn = vpnOf(page)
  await expect(vpn).toHaveAttribute('aria-checked', 'true')
  await add(page, magnetFor(fixture, fleet.peers))
  const whole = await until('the film from the seeders', page, (now) => now.done === fixture.size, 120_000)
  // THE CONTROL of what the relay holds after Off: with the VPN on it holds this page's listener and UDP sockets
  const held = { sockets: (await relayed()).sockets, udp: udpPorts(relayPid).size }
  expect(held.sockets, 'the relay holds no socket for a page behind it').toBeGreaterThan(idle.sockets)
  expect(held.udp, 'the relay holds no UDP port for a page behind it').toBeGreaterThan(idle.udp.length)
  expect(whole.transports).toEqual(['relay'])
  expect(whole.webrtc.peers, 'a WebRTC peer gave the library the film, and none holds it yet').toBe(0)
  // transmission counts what it sent on its own tick
  await expect.poll(async () => (await fleet.uploaded()).reduce((a, b) => a + b, 0), { timeout: 10_000, message: 'the film did not come from the seeders' }).toBeGreaterThanOrEqual(fixture.size)
  await expect(vpn.locator('strong')).toHaveText('On')

  await vpn.click()
  const warning = page.getByRole('dialog')
  // this machine's own time zone decides whether the country sentence follows
  await expect(warning.locator('p').first()).toHaveText(SENTENCE)
  await warning.getByRole('button', { name: 'Turn off' }).click()
  await expect(warning).toHaveCount(0)
  await expect(vpn).toHaveAttribute('aria-checked', 'false')
  record.libraryOff = await wordsUntil(page, 'off', 90_000)

  const off = await until('the engine with no relay', page, (now) => now.transports.at(-1) === 'direct' && now.done === fixture.size, 60_000)
  expect(off.transports).toEqual(['relay', 'direct'])
  expect(off.fatal).toEqual([])
  // The engine behind the relay closed all it held there before it was ended: no listener the seeders still know
  // of, no UDP port, no connection. And 10 s on the relay holds none and has counted nothing more for the page.
  await expect.poll(async () => (await relayed()).sockets, { timeout: 15_000, message: 'the relay still holds sockets of the engine that was ended' }).toBe(idle.sockets)
  expect([...udpPorts(relayPid)].sort(), 'the relay still holds UDP ports of the engine that was ended').toEqual(idle.udp)
  const carried = (await relayed()).bytes
  await sleep(10_000)
  const later = await relayed()
  record.afterOff = { idle, held, sockets: later.sockets, udp: udpPorts(relayPid).size, bytes: later.bytes - carried }
  expect(later.sockets, 'a peer was taken on a socket of the engine that was ended').toBe(idle.sockets)
  expect(later.bytes - carried, 'the relay counted bytes for a page with the VPN off').toBe(0)
  // it tells the tracker itself now, from the browser, and holds the film still
  await until('the tracker to answer the library', page, announced, 60_000)
  await post(page, { type: 'set-session-limits', up: SEEDER_UP })
  expect(library.errors).toEqual([])
})

test('with the VPN on, a download takes pieces from the seeders, from a ripple behind the same relay and from one with the VPN off', async () => {
  test.setTimeout(420_000)
  // a second ripple behind the relay, which holds the film before the download starts
  const behind = await open()
  await behind.page.goto('/')
  await add(behind.page, magnetFor(fixture, fleet.peers))
  await until('the film at the ripple behind the relay', behind.page, (now) => now.done === fixture.size, 120_000)
  await until('the tracker to answer the ripple behind the relay', behind.page, announced, 90_000)
  await post(behind.page, { type: 'set-session-limits', up: SEEDER_UP })
  const caps = await fleet.limitUpload(SEEDER_KBPS)
  expect(caps.every((cap) => cap.enabled && cap.limit === SEEDER_KBPS), `the seeders are not capped: ${JSON.stringify(caps)}`).toBe(true)
  const uploadedBefore = await fleet.uploaded()
  const before = { seen: await seen(), proxied: await proxied(), relayed: await relayed(), library: await told(library.page) }

  const taker = await open()
  const hosts = hostsOf(taker)
  await taker.page.goto('/')
  await add(taker.page, magnetFor(fixture, fleet.peers))
  const done = await until('the download', taker.page, (now) => now.done === fixture.size, 240_000)
  // the last blocks are counted on the next beat of each engine
  await sleep(3_000)
  const [took, gaveOff, gaveBehind, uploaded, after] = [await told(taker.page), await told(library.page), await told(behind.page), await fleet.uploaded(), { seen: await seen(), proxied: await proxied(), relayed: await relayed() }]
  const fromSeeders = uploaded.map((bytes, i) => bytes - uploadedBefore[i]!)

  // the candidates each ripple named, against who holds those ports on this machine
  const relayPid = pidOn(relay.http)!
  const relayUdp = udpPorts(relayPid)
  const named = after.seen.tracker.candidates.filter((candidate) => /^[\d.]+:\d+$/.test(candidate) && !before.seen.tracker.candidates.includes(candidate))
  const behindRelay = named.filter((candidate) => relayUdp.has(Number(candidate.split(':')[1])))
  const text = logs()

  record.hybrid = {
    transports: took.transports,
    ordinary: took.ordinary,
    webrtc: took.webrtc,
    connections: Object.values(took.connections),
    fromSeeders,
    fromTheLibrary: gaveOff.upload - before.library.upload,
    fromBehindTheRelay: { webrtc: gaveBehind.webrtc.up, ordinary: gaveBehind.ordinary.up },
    candidates: named.map((candidate) => candidate.replace(/:\d+$/, (port) => `${port} ${relayUdp.has(Number(port.slice(1))) ? '(a UDP port of the relay)' : ''}`)),
    tracker: { sockets: after.seen.tracker.sockets - before.seen.tracker.sockets, offers: after.seen.tracker.offers - before.seen.tracker.offers, answers: after.seen.tracker.answers - before.seen.tracker.answers, connections: after.seen.tracker.connections },
    proxied: { opened: after.proxied.opened - before.proxied.opened, requests: after.proxied.requests - before.proxied.requests },
    relayed: { sessions: after.relayed.sessions - before.relayed.sessions, bytes: after.relayed.bytes - before.relayed.bytes },
    hosts,
    names: after.seen.names,
    logs: Object.fromEntries(Object.entries(text).map(([name, log]) => [name, { lines: log.split('\n').length, addresses: [...new Set(log.match(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g) ?? [])] }])),
  }
  console.log(`swarm-rig webrtc hybrid ${JSON.stringify(record.hybrid)}`)

  expect(done.transports).toEqual(['relay'])
  expect(took.ordinary.down, 'no piece came from a seeder').toBeGreaterThanOrEqual(fixture.pieceLength)
  expect(fromSeeders.reduce((a, b) => a + b, 0), 'the seeders say they sent no piece').toBeGreaterThanOrEqual(fixture.pieceLength)
  expect(took.webrtc.down, 'no piece came over WebRTC').toBeGreaterThanOrEqual(fixture.pieceLength)
  // an engine with no relay has WebRTC peers alone, so all it sent went over WebRTC
  expect(gaveOff.upload - before.library.upload, 'no piece came from the ripple with the VPN off').toBeGreaterThanOrEqual(fixture.pieceLength)
  expect(gaveBehind.webrtc.up, 'no piece came over WebRTC from the ripple behind the same relay').toBeGreaterThanOrEqual(fixture.pieceLength)

  // each ripple behind the relay said it is reached at a UDP port the relay holds, at the address the relay's
  // own connection to the tracker left from, and no ripple named another address
  expect(behindRelay.length, 'the download named no port of the relay as where it is reached').toBeGreaterThanOrEqual(1)
  expect(named.map((candidate) => candidate.split(':')[0]), 'a ripple named another address than the relay\'s').toEqual(named.map(() => tracker.address))
  // the tracker took two connections for it: the relay's, made to read its own address, and the proxy's socket.
  // On one machine both come from the address the tracker listens on, so only their number says anything.
  expect(after.seen.tracker.connections[tracker.address]! - before.seen.tracker.connections[tracker.address]!, 'the relay made no connection to the tracker to read its own address').toBe(2)
  // the download's tracker socket went through the proxy, and its browser opened none to the tracker itself
  expect(after.proxied.opened - before.proxied.opened, 'the proxy carried no tracker socket').toBe(1)
  expect(after.seen.tracker.sockets - before.seen.tracker.sockets, 'the tracker saw another socket than the proxy\'s').toBe(1)
  expect(Object.keys(hosts)).not.toContain(TRACKER_URL)
  // THE CONTROL of the next test: a download behind the relay does move the relay's own counts
  expect(after.relayed.sessions - before.relayed.sessions, 'the relay admitted no session for a download behind it').toBeGreaterThanOrEqual(1)
  expect(after.relayed.bytes - before.relayed.bytes, 'the relay counted less than the film for a download behind it').toBeGreaterThanOrEqual(fixture.size)
  // neither the relay nor the proxy wrote a torrent or the tracker's name down
  for (const [name, log] of Object.entries(text)) {
    expect(log.includes(fixture.infoHash), `${name} holds the info hash`).toBe(false)
    expect(log.includes(tracker.name), `${name} holds the tracker's name`).toBe(false)
  }
  for (const one of [taker, behind, library]) {
    expect(one.errors).toEqual([])
    expect((await told(one.page)).fatal).toEqual([])
  }
  const opfs = await readFixture(taker.page, fixture)
  expect(opfs.sha256, 'the file the download left is not the fixture').toBe(fixture.sha256)
  await close(taker)
  await close(behind)
  await fleet.limitUpload(100_000)
  await post(library.page, { type: 'set-session-limits', up: 0 })
})

test('with the VPN off a film plays from a WebRTC peer, and nothing is asked of the relay, the proxy or the api', async () => {
  test.setTimeout(240_000)
  const before = { at: Date.now(), proxied: await proxied(), relayed: await relayed(), library: await told(library.page), relayLog: logs()['relay.log']!.length, sockets: (await seen()).tracker.sockets }
  const viewer = await open('off')
  const hosts = hostsOf(viewer)

  await viewer.page.goto(watchPath(magnetFor(fixture, [])))
  await viewer.page.bringToFront()
  const played = await until('the film over WebRTC', viewer.page, (now) => now.done === fixture.size && now.firstFrameAt !== null, 180_000)
  await sleep(3_000)
  const [gave, after] = [await told(library.page), { at: Date.now(), proxied: await proxied(), relayed: await relayed(), relayLog: logs()['relay.log']!.length, sockets: (await seen()).tracker.sockets }]
  const opfs = await readFixture(viewer.page, fixture)
  record.vpnOff = {
    from: before.at, to: after.at, hosts, transports: played.transports, webrtc: played.webrtc, ordinary: played.ordinary, fromTheLibrary: gave.upload - before.library.upload,
    proxied: { before: before.proxied, after: after.proxied }, relayed: { before: before.relayed, after: after.relayed }, relayLogGrew: after.relayLog - before.relayLog, opfs,
  }
  console.log(`swarm-rig webrtc vpn-off ${JSON.stringify(record.vpnOff)}`)

  expect(played.transports).toEqual(['direct'])
  expect(played.ordinary.peers, 'a peer that is no WebRTC peer connected').toBe(0)
  expect(gave.upload - before.library.upload, 'the film did not come from the library page').toBeGreaterThanOrEqual(fixture.size)
  expect(opfs.sha256, 'the file is not the fixture').toBe(fixture.sha256)
  // the page, its frames and their workers asked the page's own server, FKN's frame and the tracker, which the
  // engine opened itself, and nothing else
  expect(Object.keys(hosts).sort()).toEqual([broker.origin, app.origin, TRACKER_URL].sort())
  expect(after.sockets - before.sockets, 'the tracker saw another socket than the browser\'s own').toBe(1)
  // the relay admitted no session and carried no byte meanwhile, so nothing was metered, and the proxy was asked nothing
  expect(after.relayed, 'the relay was used while the VPN was off').toEqual(before.relayed)
  expect(after.relayLog - before.relayLog, 'the relay wrote to its log while the VPN was off').toBe(0)
  expect(after.proxied.requests, 'the proxy was asked something while the VPN was off').toBe(before.proxied.requests)
  await expect(vpnOf(viewer.page)).toHaveAttribute('aria-checked', 'false')
  expect(viewer.errors).toEqual([])
  await close(viewer)
})

/**
 * What a person does in a player: the VPN on and nobody found (the magnet names no peer, and behind the relay a
 * magnet is announced to no tracker of the app's until its metadata says it may be), the switch pressed and the
 * warning answered inside the player, the film arriving over WebRTC and playing, and the VPN switched back on
 * while it plays.
 */
const throughThePlayer = async (name: string, scope: Page | FrameLocator, surface: () => Surface, viewer: Visitor) => {
  const before = await told(library.page)
  const vpn = vpnOf(scope)
  await expect(vpn).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 })
  const on = await until(`${name}: the engine behind the relay`, surface(), (now) => now.transports.at(-1) === 'relay' && now.handle !== null && !!now.reachable?.listeners?.some((listener) => listener.up), 90_000)
  expect(on.done, 'the film arrived before the switch, so the switch moved nothing').toBe(0)

  await vpn.click()
  const warning = scope.getByRole('dialog')
  await expect(warning.locator('p').first()).toHaveText(SENTENCE)
  await warning.getByRole('button', { name: 'Turn off' }).click()
  await expect(warning).toHaveCount(0)
  await expect(vpn).toHaveAttribute('aria-checked', 'false')
  const off = await wordsUntil(scope, 'off', 90_000)

  const played = await until(`${name}: the film over WebRTC`, surface(), (now) => now.transports.at(-1) === 'direct' && now.done === fixture.size && now.firstFrameAt !== null, 180_000)
  expect(played.ordinary.down, 'bytes came from a peer that is no WebRTC peer').toBe(0)
  // the library says what it sent on its next beat
  await until(`${name}: the film to have come from the library page`, library.page, (now) => now.upload - before.upload >= fixture.size, 15_000)

  // back on asks nothing, and the film goes on playing through the change of engine
  const playhead = () => surface().evaluate(() => document.querySelector('video')?.currentTime ?? 0)
  await surface().evaluate(() => { void document.querySelector('video')?.play() })
  const at = await playhead()
  await vpn.click()
  await expect(warning).toHaveCount(0)
  await expect(vpn).toHaveAttribute('aria-checked', 'true')
  const back = await wordsUntil(scope, 'on', 120_000)
  const end = await until(`${name}: the engine behind the relay again`, surface(), (now) => now.transports.at(-1) === 'relay' && now.done === fixture.size, 60_000)
  await expect.poll(playhead, { timeout: 30_000, message: 'the film stopped at the switch' }).toBeGreaterThan(at + 3)
  expect(end.fatal).toEqual([])
  expect(viewer.errors).toEqual([])
  record[name] = { off, back, transports: end.transports, engines: end.engines, webrtc: played.webrtc, playheadAtSwitch: at, playheadAfter: await playhead() }
  console.log(`swarm-rig webrtc ${name} ${JSON.stringify(record[name])}`)
}

test('a share link\'s watch page: the switch asks inside the player, the film arrives over WebRTC, and the VPN goes back on', async () => {
  test.setTimeout(480_000)
  const viewer = await open()
  await viewer.page.goto(watchPath(magnetFor(fixture, [])))
  await viewer.page.bringToFront()
  await throughThePlayer('watch', viewer.page, () => viewer.page, viewer)
  await close(viewer)
})

test('the player framed by another site: the same, in the storage the browser keeps for that site', async () => {
  test.setTimeout(480_000)
  const viewer = await open()
  const { page } = viewer
  // ripple's own storage says something the frame must not see
  await page.goto('/privacy')
  await page.evaluate(() => localStorage.setItem('ripple:rig-first-party', '1'))
  // this server under another name is another site
  const top = new URL('/README.md', app.origin)
  top.hostname = '127.0.0.1'
  await page.goto(top.href)
  await page.evaluate((src) => {
    const iframe = document.createElement('iframe')
    iframe.src = src
    iframe.allow = 'autoplay; fullscreen'
    iframe.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0'
    document.body.append(iframe)
  }, `${app.origin}${watchPath(magnetFor(fixture, []))}`)
  await page.bringToFront()
  const framed = () => page.frames().find((frame) => frame.parentFrame() === page.mainFrame() && frame.url().startsWith(app.origin))!
  await expect.poll(() => !!framed(), { timeout: 30_000 }).toBe(true)
  await expect(vpnOf(page.frameLocator('iframe'))).toBeVisible({ timeout: 60_000 })
  // THE CONTROL: the frame's storage is not the one ripple's own page wrote to
  expect(await framed().evaluate(() => localStorage.getItem('ripple:rig-first-party')), 'the frame is not partitioned, so this proves nothing of a framed player').toBeNull()

  await throughThePlayer('framed', page.frameLocator('iframe'), framed, viewer)
  expect(await framed().evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('ripple:vpn')))).toEqual([])
  await close(viewer)
})

test('back on the library, the VPN is switched on again and the page is behind the relay with the film whole', async () => {
  test.setTimeout(240_000)
  const { page } = library
  const vpn = vpnOf(page)
  await expect(vpn).toHaveAttribute('aria-checked', 'false')
  const gave = await told(page)
  expect(gave.webrtc.peers, 'the library never had a WebRTC peer').toBeGreaterThan(0)

  await vpn.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(vpn).toHaveAttribute('aria-checked', 'true')
  record.libraryOn = await wordsUntil(page, 'on', 120_000)
  const on = await until('the library behind the relay again', page, (now) => now.transports.at(-1) === 'relay' && now.done === fixture.size && !!now.reachable?.listeners?.some((listener) => listener.up), 60_000)
  expect(on.transports).toEqual(['relay', 'direct', 'relay'])
  expect(on.engines).toBe(3)
  expect(on.fatal).toEqual([])
  expect(library.errors).toEqual([])
  await expect(page.locator('.torrent')).toHaveCount(1)
  record.library = { off: record.libraryOff, on: record.libraryOn, uploaded: gave.upload, webrtcPeers: gave.webrtc.peers, transports: on.transports }
  console.log(`swarm-rig webrtc library ${JSON.stringify(record.library)}`)
})
