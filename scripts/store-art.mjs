#!/usr/bin/env node
/**
 * Draws ripple's store listing again, the images package.json's fkn.background, fkn.cover and fkn.screenshots name:
 *
 *   npm run build && nix shell nixpkgs#libwebp -c npm run store-art
 *
 * The background and cover are scripts/store-art/art.html in one of its directions (`--direction`, ripples by
 * default), and `--each <dir>` also writes every direction's pair under <dir>/<direction>/. The screenshots are the
 * built app on RIPPLE_TEST_PORT, at 2560x1440 at 1.5 and a phone's 390x844 at 3, with a stand-in engine answering
 * for torrents of Blender's open films, whose stills scripts/store-art/frames.js draws; the player plays one of
 * them, made a video by ffmpeg. `--only art`, `--only shots` or `--only <shot>` draws a part. Needs cwebp and
 * ffmpeg on PATH, and RIPPLE_CHROME naming a Chromium when Playwright's own is not installed.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { chromium } from 'playwright'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'store')
const DIRECTIONS = ['ripples', 'posters', 'pieces']
const args = process.argv.slice(2)
const option = (name) => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1] }
const direction = option('--direction') ?? 'ripples'
const each = option('--each')
const only = option('--only')
if (!DIRECTIONS.includes(direction)) throw new Error(`--direction is one of ${DIRECTIONS.join(', ')}`)

const DESKTOP = { viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1.5 }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.mkv': 'video/x-matroska', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.otf': 'font/otf',
}

/** Serves `root`, with `/__store/` reading `extra`; an unknown path is the app's index.html when `app` is set. */
const serve = (root, port, { app = false, extra } = {}) => new Promise((listening) => {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://store').pathname)
    const base = extra && path.startsWith('/__store/') ? extra : root
    const file = join(base, base === root ? path : path.slice('/__store/'.length))
    const found = !relative(base, file).startsWith('..') && existsSync(file) && statSync(file).isFile()
    if (!found && !app) return response.writeHead(404).end()
    const served = found ? file : join(root, 'index.html')
    response.writeHead(200, { 'content-type': TYPES[extname(served)] ?? 'application/octet-stream' })
    createReadStream(served).pipe(response)
  })
  server.listen(port, '127.0.0.1', () => listening(server))
})
const originOf = (server) => `http://127.0.0.1:${server.address().port}`

const run = (command, ...rest) => {
  const { status, stderr, error } = spawnSync(command, rest, { encoding: 'utf8' })
  if (status !== 0) throw new Error(`${command} failed: ${error?.message ?? stderr}`)
}
// lossy and with no alpha, so each is a plain VP8 WebP (tests/store-listing.test.ts)
const webp = (png, out) => run('cwebp', '-quiet', '-q', '82', '-m', '6', '-sharp_yuv', '-noalpha', png, '-o', out)

const scratch = mkdtempSync(join(tmpdir(), 'ripple-store-'))
const browser = await chromium.launch({ executablePath: process.env.RIPPLE_CHROME, args: ['--mute-audio'] })
const art = await serve(ROOT, 0)

const drawArt = async (name, format, out) => {
  const [width, height] = format === 'cover' ? [600, 900] : [3840, 1240]
  const page = await browser.newPage({ viewport: { width, height } })
  await page.goto(`${originOf(art)}/scripts/store-art/art.html?direction=${name}&format=${format}`)
  await page.waitForSelector('body[data-ready]')
  const png = join(scratch, `${name}-${format}.png`)
  await page.screenshot({ path: png })
  await page.close()
  mkdirSync(dirname(out), { recursive: true })
  webp(png, out)
}

/** Each film's still as a PNG, at 1280x720 for a poster and 1920x1080 for the video the player plays. */
const drawStills = async () => {
  const page = await browser.newPage()
  await page.goto(`${originOf(art)}/scripts/store-art/art.html?format=cover`)
  const stills = {}
  for (const [film, width, height] of [...FILMS.map(({ film }) => [film, 1280, 720]), ['sintel', 1920, 1080]]) {
    const base64 = await page.evaluate(async ([film, width, height]) => {
      const { drawFrame } = await import('/scripts/store-art/frames.js')
      const canvas = new OffscreenCanvas(width, height)
      drawFrame(canvas.getContext('2d'), film, width, height)
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
      let text = ''
      for (const byte of bytes) text += String.fromCharCode(byte)
      return btoa(text)
    }, [film, width, height])
    const path = join(scratch, `${film}-${width}.png`)
    writeFileSync(path, Buffer.from(base64, 'base64'))
    if (width === 1280) stills[film] = base64
  }
  await page.close()
  return stills
}

const GB = 1_000_000_000
const MB = 1_000_000
const DAY = 86_400
const NOW = Math.floor(Date.now() / 1_000)
// Sintel runs 14:48, so the seek bar reads as the film's
const SINTEL_SECONDS = 888

const FILMS = [
  { name: 'Sintel', film: 'sintel', size: 1.23 * GB, progress: 0.64, rate: 8.4 * MB, peers: 48, seeds: 21, up: 310_000 },
  { name: 'Big Buck Bunny', film: 'big-buck-bunny', size: 0.89 * GB, progress: 1, peers: 6, up: 640_000 },
  { name: 'Tears of Steel', film: 'tears-of-steel', size: 2.14 * GB, progress: 0.31, rate: 5.2 * MB, peers: 37, seeds: 14, up: 120_000 },
  { name: 'Elephants Dream', film: 'elephants-dream', size: 0.82 * GB, progress: 0.52, paused: true, up: 0 },
  { name: 'Cosmos Laundromat', film: 'cosmos-laundromat', size: 1.61 * GB, progress: 1, peers: 3, up: 210_000 },
]
const PACK = {
  name: 'Blender Open Movies',
  progress: 0.12,
  rate: 2.9 * MB,
  peers: 19,
  seeds: 8,
  up: 90_000,
  files: FILMS.map(({ name, size }) => ({ path: `Blender Open Movies/${name}/${name}.mkv`, size })),
}
const MORE = [
  { name: 'Sintel Soundtrack', progress: 1, peers: 2, up: 48_000, files: Array.from({ length: 12 }, (_, i) => ({ path: `Sintel Soundtrack/Track ${String(i + 1).padStart(2, '0')}.flac`, size: 31 * MB + i * 1.7 * MB })) },
  { name: 'Big Buck Bunny 4K', film: 'big-buck-bunny', size: 3.42 * GB, progress: 1, peers: 4, up: 520_000 },
  { name: 'Tears of Steel 4K', film: 'tears-of-steel', size: 6.31 * GB, progress: 0.08, rate: 1.6 * MB, peers: 11, seeds: 5, up: 30_000 },
]
const SUBTITLES = ['en', 'fr', 'de', 'es'].map((language) => ({ path: `Sintel/Subtitles/Sintel.${language}.srt`, size: 14_000 + language.charCodeAt(0) * 40 }))

const infoHashOf = ({ name }) => createHash('sha1').update(name).digest('hex')
const magnetOf = (torrent) => `magnet:?xt=urn:btih:${infoHashOf(torrent)}&dn=${encodeURIComponent(torrent.name)}`
const filesOf = ({ name, size, files }) => {
  const all = files ?? [{ path: `${name}/${name}.mkv`, size }]
  return { files: all, contentSize: all.reduce((sum, file) => sum + file.size, 0), pieceLength: 1_048_576 }
}

/** What the engine says of a torrent, as the worker's state message carries it. */
const snapshot = (torrent, handle, over = {}) => {
  const files = over.files ?? filesOf(torrent)
  const done = Math.round(files.contentSize * torrent.progress)
  const seeding = torrent.progress === 1
  return {
    handle,
    magnet: magnetOf(torrent),
    files,
    status: {
      state: seeding ? 5 : 3, paused: !!torrent.paused, progress: torrent.progress, totalDone: done, totalWanted: files.contentSize,
      downloadRate: torrent.rate ?? 0, uploadRate: torrent.up, numPeers: torrent.peers ?? 0, numSeeds: torrent.seeds ?? 0,
      allTimeDownload: done, allTimeUpload: done * 0.18, sessionDownload: done * 0.6, sessionUpload: done * 0.1, wasted: 0,
      swarmSeeds: 214, swarmPeers: 61, numConnections: torrent.peers ?? 0, connectionsLimit: 200, availability: 7.4,
      addedAt: NOW - 2 * DAY, completedAt: seeding ? NOW - DAY : 0, lastSeenComplete: NOW - 600, hadIncoming: true,
      savePath: '/Movies', numPiecesTotal: Math.ceil(files.contentSize / 1_048_576), numPiecesHave: Math.floor(done / 1_048_576),
    },
    bitfield: null,
    recovery: null,
    userPaused: !!torrent.paused,
    windowed: false,
    swarmDownloads: -1,
    uptime: { activeSeconds: 2 * DAY, seedingSeconds: seeding ? DAY : 0 },
    sessionUptime: { activeSeconds: 3_600, seedingSeconds: seeding ? 3_600 : 0 },
    totals: {},
    ...over,
  }
}
const entry = (torrent, at) => ({ infoHash: infoHashOf(torrent), magnet: magnetOf(torrent), name: torrent.name, size: filesOf(torrent).contentSize, addedAt: at, started: true })

const LIBRARY = [...FILMS, PACK, ...MORE]
const LIST = LIBRARY.map((torrent, i) => entry(torrent, NOW - i * 3_600))
const TORRENTS = LIBRARY.map((torrent, i) => snapshot(torrent, i + 1))
const READOUT = {
  rateLimits: { down: 0, up: 0 },
  reachable: { port: 41337, listenFailed: [], listeners: [{ up: true }], portOpen: true, inbound: 4 },
  inboundNow: { total: 4, byTransport: { utp: 3, tcp: 1 } },
}

/**
 * Stands in for the engine's worker and for the browser's answers about storage. The engine's reads are answered
 * from the video under /__store/, and every other worker (libav's, the subtitles') is the browser's own.
 */
const standIns = () => {
  if (window !== window.top) return
  const heard = new Set()
  const engine = (data) => { for (const listener of heard) listener(new MessageEvent('message', { data })) }
  const Native = window.Worker
  let video
  // the video stands in for a whole film, so a read past its end is answered with zeros
  const read = async ({ id, offset, len }) => {
    video ??= fetch('/__store/sintel.mkv').then(async (response) => new Uint8Array(await response.arrayBuffer()))
    const data = new Uint8Array(len)
    data.set((await video).subarray(offset, offset + len))
    engine({ type: 'read-result', id, data })
  }
  function Worker (url, options) {
    if (!String(url).includes('/assets/worker-')) return new Native(url, options)
    return {
      addEventListener: (type, listener) => { if (type === 'message') heard.add(listener) },
      removeEventListener: (_, listener) => heard.delete(listener),
      postMessage: (message) => { if (message?.type === 'read') void read(message) },
      terminate () {},
    }
  }
  // osra knows libav's worker for one by `instanceof Worker`
  Worker.prototype = Native.prototype
  Object.defineProperty(window, 'Worker', { value: Worker })
  Object.assign(window, { engineListens: () => heard.size > 0, engine })
  navigator.storage.estimate = async () => ({ usage: 6.4e9, quota: 214e9 })
  navigator.storage.persisted = async () => true
  localStorage.setItem('ripple:demo-seeded', '1')
}

const shots = await (async () => {
  if (only === 'art') return null
  if (!existsSync(join(ROOT, 'build', 'index.html'))) throw new Error('build/ has no app in it: run npm run build first')
  const stills = await drawStills()
  // one frame a second keeps the encode to seconds; with x264's B-frames a seek in the player never ends (2026-11-15)
  run('ffmpeg', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '1', '-i', join(scratch, 'sintel-1920.png'), '-t', String(SINTEL_SECONDS),
    '-c:v', 'libx264', '-tune', 'stillimage', '-crf', '14', '-g', '20', '-bf', '0', '-pix_fmt', 'yuv420p', join(scratch, 'sintel.mkv'))
  return { stills, server: await serve(join(ROOT, 'build'), Number(process.env.RIPPLE_TEST_PORT ?? 4702), { app: true, extra: scratch }) }
})()

const post = (page, ...messages) => page.evaluate((all) => { for (const message of all) window.engine(message) }, messages)
const settled = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))

/** A page of the built app at `path`, its posters in the library's store and the engine answering. */
const open = async (device, path, { list = LIST, torrents = TORRENTS, storage = {} } = {}) => {
  const context = await browser.newContext({ ...device, locale: 'en-US' })
  const page = await context.newPage()
  const origin = originOf(shots.server)
  await page.route((url) => !url.href.startsWith(origin), (route) => route.abort())
  await page.addInitScript(standIns)
  await page.addInitScript((values) => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, storage)
  await page.goto(`${origin}${path}`)
  await page.waitForFunction(() => window.engineListens())
  await page.evaluate(async (posters) => {
    const db = await new Promise((done, fail) => {
      const request = indexedDB.open('keyval-store')
      request.onupgradeneeded = () => request.result.createObjectStore('keyval')
      request.onsuccess = () => done(request.result)
      request.onerror = () => fail(request.error)
    })
    const tx = db.transaction('keyval', 'readwrite')
    for (const [infoHash, base64] of posters) {
      tx.objectStore('keyval').put(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }), `ripple:thumb:${infoHash}`)
    }
    await new Promise((done, fail) => { tx.oncomplete = done; tx.onerror = () => fail(tx.error) })
    db.close()
  }, LIBRARY.filter(({ film }) => film).map((torrent) => [infoHashOf(torrent), shots.stills[torrent.film]]))
  await post(page, { type: 'ready' }, { type: 'list', list }, { type: 'state', torrents, ...READOUT })
  await settled(page)
  return { context, page }
}

/** Thirteen seconds of the engine's ticks, the bytes growing at rates that wander, so every speed graph fills. */
const download = (page, torrents = TORRENTS) => page.evaluate(async ([torrents, readout]) => {
  const rates = torrents.map(({ status }) => [status.downloadRate, status.uploadRate])
  const start = performance.now()
  let last = start
  for (let tick = 0; tick < 130; tick++) {
    await new Promise((done) => setTimeout(done, 100))
    const now = performance.now()
    for (const [i, { status }] of torrents.entries()) {
      if (status.paused) continue
      const wander = (phase) => 1 + 0.3 * Math.sin((now - start) / 1_400 + phase) + 0.15 * Math.sin((now - start) / 520 + phase * 3)
      status.uploadRate = Math.round(rates[i][1] * wander(i + 4))
      if (status.state === 5 || !rates[i][0]) continue
      status.totalDone = Math.min(status.totalWanted, status.totalDone + rates[i][0] * wander(i) * (now - last) / 1_000)
      status.progress = status.totalDone / status.totalWanted
    }
    last = now
    window.engine({ type: 'state', torrents, ...readout })
  }
}, [torrents, READOUT])

const capture = async (name, device, path, act, { pointer = [0, 0], ...options } = {}) => {
  const { context, page } = await open(device, path, options)
  await act(page)
  await page.mouse.move(...pointer)
  await settled(page)
  await page.waitForTimeout(400)
  const png = join(scratch, `${name}.png`)
  await page.screenshot({ path: png })
  webp(png, join(OUT, `${name}.webp`))
  await context.close()
  console.log(`store/${name}.webp`)
}

const SHOTS = {
  library: () => capture('library', DESKTOP, '/', async (page) => {
    await page.locator('.torrent').first().waitFor()
    await download(page)
  }),
  player: () => capture('player', DESKTOP, `/watch?magnet=${encodeURIComponent(Buffer.from(magnetOf(FILMS[0])).toString('base64'))}`, async (page) => {
    await post(page, { type: 'list', list: [entry(FILMS[0], NOW)] }, { type: 'state', torrents: [snapshot(FILMS[0], 1)], ...READOUT })
    const playing = (after) => page.waitForFunction((after) => {
      const video = document.querySelector('video')
      return video && video.currentTime > after && !video.seeking && video.readyState >= 3
    }, after, { timeout: 60_000 })
    await playing(0)
    const bar = page.locator('.progress-bar')
    const { width, height } = await bar.boundingBox()
    await bar.click({ position: { x: width * 0.508, y: height / 2 } })
    await playing(440)
  }, { list: [], torrents: [], pointer: [1280, 640] }),
  download: () => capture('download', DESKTOP, `/download?magnet=${encodeURIComponent(Buffer.from(magnetOf(FILMS[0])).toString('base64'))}`, async (page) => {
    const sintel = snapshot(FILMS[0], 1, { files: filesOf({ files: [{ path: 'Sintel/Sintel.mkv', size: FILMS[0].size }, ...SUBTITLES] }) })
    await post(page, { type: 'list', list: [{ ...entry(FILMS[0], NOW), ephemeral: true }] }, { type: 'state', torrents: [sintel], ...READOUT })
    await page.locator('.card .file').first().waitFor()
  }, { list: [], torrents: [] }),
  details: () => capture('details', DESKTOP, '/', async (page) => {
    await page.locator('.torrent .title strong', { hasText: /^Sintel$/ }).click()
    await page.getByRole('region', { name: /^Details for/ }).locator('.fact').first().waitFor()
    await download(page)
  }, { storage: { 'ripple:dock-height': '300' } }),
  add: () => capture('add', DESKTOP, '/', async (page) => {
    await download(page, TORRENTS.slice(0, 5))
    const field = page.locator('header form input:not([type=file])')
    await field.fill(magnetOf(PACK))
    await field.press('Enter')
    await page.getByRole('dialog').waitFor()
    const pack = snapshot({ ...PACK, progress: 0 }, 9)
    await post(page, { type: 'list', list: [...LIST.slice(0, 5), { ...entry(PACK, NOW), ephemeral: true }] }, { type: 'state', torrents: [...TORRENTS.slice(0, 5), pack], ...READOUT })
    await page.getByRole('dialog').locator('.file').first().waitFor()
  }, { list: LIST.slice(0, 5), torrents: TORRENTS.slice(0, 5), storage: { 'ripple:add-dialog': '1' } }),
  phone: () => capture('phone', PHONE, '/', async (page) => {
    await page.locator('.torrent').first().waitFor()
    await download(page)
  }),
}

try {
  if (!only || only === 'art') {
    await drawArt(direction, 'background', join(OUT, 'background.webp'))
    await drawArt(direction, 'cover', join(OUT, 'cover.webp'))
    for (const name of each ? DIRECTIONS : []) {
      for (const format of ['background', 'cover']) await drawArt(name, format, join(resolve(each), name, `${format}.webp`))
    }
  }
  for (const name of !shots ? [] : only in SHOTS ? [only] : Object.keys(SHOTS)) await SHOTS[name]()
} finally {
  await browser.close()
  art.close()
  shots?.server.close()
  rmSync(scratch, { recursive: true, force: true })
}
