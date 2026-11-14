/**
 * A browser of its own on the swarm rig, with what its engine says of one torrent: the transport it runs on,
 * how much of the fixture it holds, and what each kind of peer delivered.
 */
import type { BrowserContext, BrowserType, Frame, FrameLocator, LaunchOptions, Page, ViewportSize } from '@playwright/test'

import { expect } from '@playwright/test'

import { DEMO_SEEDED_KEY } from '../../src/torrent/constants'

export type Browser = { type: BrowserType, launchOptions: LaunchOptions, viewport: ViewportSize | null, baseURL: string | undefined }

/**
 * What one kind of peer moved, over every connection of that kind the torrent ever had. Read off the peer list
 * twice a second, so what a peer moved in its last half second can be missing: a split between kinds, not a total.
 */
export type Kind = { down: number, up: number, peers: number }

export type Told = {
  /** each transport an engine named, in the order they came */
  transports: string[]
  /** engine workers this page started */
  engines: number
  fatal: string[]
  states: number
  lastStateAt: number
  /** the fixture's torrent, once the engine lists it */
  handle: number | null
  done: number
  state: number | null
  numPeers: number
  /** every payload byte the torrent ever sent, as the engine counts it */
  upload: number
  noPeersSince: number | null
  reachable: { port: number | null, portOpen?: boolean, listeners?: { up: boolean, healing: boolean, port: number | null }[] } | null
  webrtc: Kind
  ordinary: Kind
  /** each connection, by the peer's endpoint, which for a WebRTC peer is no address */
  connections: Record<string, { transport: string, down: number, up: number }>
  /** every WebSocket tracker row of the torrent, as the Trackers tab would list it */
  trackers: { url: string, verified: boolean, fails: number, seeders: number }[]
  firstFrameAt: number | null
  /** how many peer connections of the browser this frame made: none while its engine is behind the relay */
  made: number
}

/**
 * Runs in every frame before anything: the stored VPN choice on the first load only, so a choice made in the
 * page afterwards is the page's, and a record of what the engine tells its page.
 */
const install = ({ key, infoHash, vpn }: { key: string, infoHash: string, vpn: 'on' | 'off' }) => {
  try {
    localStorage.setItem(key, '1')
    if (!localStorage.getItem('ripple:rig-visited')) {
      localStorage.setItem('ripple:rig-visited', '1')
      if (vpn === 'off') localStorage.setItem('ripple:vpn', 'off')
    }
  } catch { /* a frame with no storage runs no engine either */ }

  const told: Told = {
    transports: [], engines: 0, fatal: [], states: 0, lastStateAt: 0,
    handle: null, done: 0, state: null, numPeers: 0, upload: 0, noPeersSince: null, reachable: null,
    webrtc: { down: 0, up: 0, peers: 0 }, ordinary: { down: 0, up: 0, peers: 0 }, connections: {}, trackers: [], firstFrameAt: null, made: 0,
  }
  const NativeConnection = window.RTCPeerConnection
  window.RTCPeerConnection = class extends NativeConnection {
    constructor (configuration?: RTCConfiguration) { super(configuration); told.made++ }
  }
  let engine: Worker | null = null
  const last: Record<string, { down: number, up: number }> = {}
  Object.assign(window, { __rig: told, __rigPost: (message: unknown) => engine?.postMessage(message) })

  const hear = (worker: Worker, generation: number, data: any) => {
    if (data?.type === 'fatal' || data?.type === 'worker-error') told.fatal.push(String(data.message ?? data.args))
    if (data?.type !== 'state' || !Array.isArray(data.torrents)) return
    told.states++
    told.lastStateAt = Date.now()
    if (told.transports.at(-1) !== data.transport) told.transports.push(data.transport)
    if (data.reachable) told.reachable = data.reachable
    const torrent = data.torrents.find((t: any) => String(t.magnet ?? '').toLowerCase().includes(infoHash))
    told.handle = torrent?.handle ?? null
    if (!torrent) return
    told.done = torrent.status?.totalDone ?? 0
    told.state = torrent.status?.state ?? null
    told.numPeers = torrent.status?.numPeers ?? 0
    told.upload = torrent.status?.allTimeUpload ?? 0
    told.noPeersSince = torrent.noPeersSince ?? null
    // the peer list is the inspected torrent's alone, and a new engine has to be asked again
    if (data.detail?.handle !== torrent.handle) { worker.postMessage({ type: 'inspect', handle: torrent.handle }); return }
    told.trackers = (data.detail.trackers ?? []).filter((t: any) => /^wss?:/.test(t.url)).map((t: any) => ({ url: t.url, verified: t.verified, fails: t.fails, seeders: t.seeders }))
    for (const peer of data.detail.peers ?? []) {
      // each engine numbers its WebRTC peers from one again
      const id = `${generation}:${peer.endpoint}`
      const before = last[id]
      const kind = peer.transport === 'webrtc' ? told.webrtc : told.ordinary
      // a peer that connects again starts its count over
      const down = peer.totalDownload - (before && peer.totalDownload >= before.down ? before.down : 0)
      const up = peer.totalUpload - (before && peer.totalUpload >= before.up ? before.up : 0)
      if (!before) kind.peers++
      kind.down += down
      kind.up += up
      last[id] = { down: peer.totalDownload, up: peer.totalUpload }
      const connection = told.connections[id] ??= { transport: peer.transport, down: 0, up: 0 }
      connection.down += down
      connection.up += up
    }
  }

  const Native = window.Worker
  window.Worker = class extends Native {
    constructor (url: string | URL, options?: WorkerOptions) {
      super(url, options)
      // the player's and the thumbnails' workers are not engines
      if (!/\/assets\/worker-/.test(String(url))) return
      const generation = ++told.engines
      engine = this
      this.addEventListener('message', ({ data }: MessageEvent) => hear(this, generation, data))
    }
  }

  // setInterval, not rAF, which an unfocused page holds back until the poll never runs
  const poll = setInterval(() => {
    const video = document.querySelector('video')
    if (!video) return
    video.requestVideoFrameCallback(() => { told.firstFrameAt ??= Date.now() })
    if (told.firstFrameAt) clearInterval(poll)
  }, 100)
}

/** The frame that runs ripple: the page itself, or the player another site frames. */
export type Surface = Page | Frame

export const told = (surface: Surface) => surface.evaluate(() => (window as unknown as { __rig: Told }).__rig)

/** Says `message` to the page's engine worker, as the page's own client would. */
export const post = (surface: Surface, message: Record<string, unknown>) =>
  surface.evaluate((m) => (window as unknown as { __rigPost: (message: unknown) => void }).__rigPost(m), message)

/**
 * A fresh REGULAR profile, as the lane's own spec opens (an off the record one crashes Chrome 153 reading a
 * FileSystemHandle back), with the record installed and the VPN choice stored before its first load.
 */
export const visitor = async (browser: Browser, infoHash: string, vpn: 'on' | 'off' = 'on') => {
  const context: BrowserContext = await browser.type.launchPersistentContext('', {
    ...browser.launchOptions,
    headless: false,
    baseURL: browser.baseURL,
    viewport: browser.viewport,
  })
  const page = context.pages()[0] ?? await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  // a wasm says so on the console when it aborts, and the player when a read fails it: with the script that said it
  page.on('console', (message) => {
    if (/Aborted\(|RuntimeError|playback failed/.test(message.text())) errors.push(`${message.text()} (${(message.worker()?.url() ?? message.location().url).replace(/^.*\//, '')})`)
  })
  await context.addInitScript(install, { key: DEMO_SEEDED_KEY, infoHash, vpn })
  return { context, page, errors }
}

export type Visitor = Awaited<ReturnType<typeof visitor>>

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What the engine tells `surface` once `pass` holds of it, read four times a second for `ms` at most. */
export const until = async (what: string, surface: Surface, pass: (now: Told) => boolean, ms: number) => {
  const deadline = Date.now() + ms
  for (;;) {
    const now = await told(surface)
    if (pass(now)) return now
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms / 1000} s (${JSON.stringify({ ...now, connections: undefined })})`)
    await sleep(250)
  }
}

export const vpnOf = (scope: Page | FrameLocator) => scope.getByRole('switch', { name: /^VPN/ })

/** Adds a magnet on the library page. */
export const add = async (page: Page, magnet: string) => {
  await page.getByPlaceholder('Add a magnet link').fill(magnet)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
}

/** Whether a WebSocket tracker of the torrent has answered the page's engine. */
export const announced = (now: Told) => now.trackers.some((row) => row.verified)

/**
 * A library page that takes the fixture from the seeders named in `magnet` with the VPN on, then turns the VPN
 * off as a person does, so it holds the fixture as a WebRTC peer that is not behind the relay. Answers once the
 * lane's tracker has heard of it.
 */
export const holder = async (browser: Browser, fixture: { infoHash: string, size: number }, magnet: string) => {
  const one = await visitor(browser, fixture.infoHash)
  const { page } = one
  await page.goto('/')
  await add(page, magnet)
  await until('the film from the seeders', page, (now) => now.done === fixture.size, 120_000)
  await vpnOf(page).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click()
  await expect(vpnOf(page)).toHaveAttribute('aria-checked', 'false')
  await until('the engine with no relay, and the tracker to answer it', page, (now) => now.transports.at(-1) === 'direct' && now.done === fixture.size && announced(now), 120_000)
  return one
}
