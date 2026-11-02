// The library page on built bytes, in languages ripple does not offer yet: every catalogue and the pseudo-language are
// offered (tests/languages.ts), so a test picks one by its setting. The engine is a stand-in this file writes to, so
// each kind of row, banner and readout is drawn with no swarm, and every request leaving this origin is refused.
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import type { Plugin } from 'vite-plus'

import { expect, test } from '@playwright/test'
import { copyFileSync, createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { build } from 'vite-plus'

import { catalogues, english, englishIn, LANGUAGE_KEY, offerEveryLanguage, PSEUDO } from './languages'

const ROOT = join(import.meta.dirname, '..')
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
}
const LIST_FILTER_KEY = 'ripple:list-filter'
const LIST_VIEW_KEY = 'ripple:list-view'
const FOLDER = 'A folder with quite a long name'
const ACCOUNT = { name: 'A person', premium: false }

// the account tag and its menu read one hook, so a stand-in for it draws them with nobody signed in
const signedIn = (): Plugin => ({
  name: 'spec-signed-in',
  enforce: 'pre',
  load: id => id === join(ROOT, 'src', 'torrent', 'use-account.ts')
    ? `export const useAccount = () => {
        const info = JSON.parse(localStorage.getItem('spec:account'))
        return { info, ready: !!info, logout: async () => {} }
      }`
    : undefined,
})

let dir: string
let server: Server
let origin: string

test.beforeAll(async () => {
  test.setTimeout(300_000)
  dir = mkdtempSync(join(tmpdir(), 'ripple-home-'))
  await build({
    configFile: join(ROOT, 'vite.config.ts'),
    root: ROOT,
    logLevel: 'error',
    build: { outDir: dir, emptyOutDir: true },
    plugins: [offerEveryLanguage(), signedIn()],
  })
  copyFileSync(join(ROOT, 'src', 'index.html'), join(dir, 'index.html'))
  server = createServer((request, response) => {
    const file = join(dir, decodeURIComponent(new URL(request.url ?? '/', 'http://app').pathname))
    const served = !relative(dir, file).startsWith('..') && existsSync(file) && statSync(file).isFile() ? file : join(dir, 'index.html')
    response.writeHead(200, { 'content-type': TYPES[extname(served)] ?? 'application/octet-stream' })
    createReadStream(served).pipe(response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await new Promise(resolve => server ? server.close(resolve) : resolve(undefined))
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// stands in for the engine's worker, for a folder picker a headless browser has none of, and for the browser's answers
// about storage, which a test sets through `answer`
const standIns = (folder: string) => {
  const heard = new Set<EventListener>()
  Object.defineProperty(window, 'Worker', {
    value: class {
      addEventListener (type: string, listener: EventListener) { if (type === 'message') heard.add(listener) }
      removeEventListener (_: string, listener: EventListener) { heard.delete(listener) }
      postMessage () {}
      terminate () {}
    },
  })
  Object.assign(window, {
    engineListens: () => heard.size > 0,
    engine: (data: unknown) => { for (const listener of heard) listener(new MessageEvent('message', { data })) },
    // the create dialog's pick, by its id, is a folder of its own, which the spec writes (folderToShare)
    showDirectoryPicker: async ({ id }: { id?: string } = {}) =>
      (await navigator.storage.getDirectory()).getDirectoryHandle(id === 'ripple-source' ? 'Holiday' : folder, { create: true }),
  })
  const answers = () => JSON.parse(localStorage.getItem('spec:storage') ?? '{}') as { low?: boolean, persisted?: boolean, denied?: boolean }
  const { storage, permissions } = navigator
  const native = {
    estimate: storage.estimate.bind(storage),
    persisted: storage.persisted.bind(storage),
    persist: storage.persist.bind(storage),
    query: permissions.query.bind(permissions),
  }
  storage.estimate = () => answers().low ? Promise.resolve({ usage: 1_000_000_000, quota: 1_900_000_000 }) : native.estimate()
  storage.persisted = () => answers().persisted ? Promise.resolve(true) : native.persisted()
  storage.persist = () => answers().low ? Promise.resolve(false) : native.persist()
  permissions.query = descriptor => answers().denied ? Promise.resolve({ state: 'denied' } as PermissionStatus) : native.query(descriptor)
}

// a service worker that takes an update and never finishes, so `Updating Ripple` stays up to be read
const updateStandIn = () => {
  const heard = new Set<EventListener>()
  const registration = { waiting: null as object | null, addEventListener () {}, update: async () => {} }
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      controller: {},
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
      register: async () => registration,
      addEventListener: (type: string, listener: EventListener) => { if (type === 'controllerchange') heard.add(listener) },
      removeEventListener: (_: string, listener: EventListener) => { heard.delete(listener) },
    },
  })
  Object.assign(window, {
    updateTaken: () => {
      registration.waiting = { postMessage () {} }
      for (const listener of heard) listener(new Event('controllerchange'))
    },
  })
}

const prepare = async (page: Page) => {
  await page.route(url => !url.href.startsWith(origin), route => route.abort())
  await page.addInitScript(standIns, FOLDER)
  await page.addInitScript(() => { if (!localStorage.getItem('spec:first-visit')) localStorage.setItem('ripple:demo-seeded', '1') })
}

test.beforeEach(({ page }) => prepare(page))

const magnetOf = (hash: string, name: string) => `magnet:?xt=urn:btih:${hash.repeat(40)}&dn=${name}`
const NAMELESS = `magnet:?xt=urn:btih:${'6'.repeat(40)}`

const GB = 1_000_000_000
const uptime = (seedingSeconds = 0) => ({ activeSeconds: seedingSeconds, seedingSeconds })
const snapshot = (handle: number, hash: string, name: string, status: object, over: object = {}) => ({
  handle,
  magnet: magnetOf(hash, name),
  files: { files: [{ path: `${name}.mkv`, size: 4.5 * GB }], contentSize: 4.5 * GB, pieceLength: 16_384 },
  status: { state: 3, paused: false, progress: 0.5, totalDone: 2.25 * GB, totalWanted: 4.5 * GB, downloadRate: 8_700_000, uploadRate: 120_000, numPeers: 82, numSeeds: 12, ...status },
  bitfield: null,
  recovery: null,
  userPaused: false,
  windowed: false,
  swarmDownloads: -1,
  uptime: uptime(),
  sessionUptime: uptime(),
  totals: {},
  ...over,
})
const entry = (hash: string, name: string, over: object = {}) => ({ infoHash: hash.repeat(40), magnet: magnetOf(hash, name), name, size: 4.5 * GB, addedAt: 1, started: true, ...over })

const SEEDING = { state: 5, progress: 1, totalDone: 4.5 * GB, totalWanted: 4.5 * GB, downloadRate: 0, numPeers: 1 }
const TORRENTS = [
  snapshot(1, 'a', 'Some.Release.Name.S01.1080p', {}),
  snapshot(2, 'b', 'A.Season.Pack', SEEDING, {
    files: { files: [{ path: 'one.mkv', size: 2 * GB }, { path: 'two.mkv', size: 2.5 * GB }], contentSize: 4.5 * GB, pieceLength: 16_384 },
    uptime: uptime(7_500),
  }),
  snapshot(3, 'c', 'Kept.Paused', { paused: true }, { userPaused: true }),
  snapshot(4, 'd', 'Having.Trouble', {}, { recovery: { reason: 'stalled', attempt: 1, retryAt: Date.now() + 60_000 } }),
  snapshot(6, '4', 'Also.Temporary', {}),
  snapshot(7, '5', 'Stalled', { downloadRate: 0 }),
  snapshot(8, '6', '', {}, { magnet: NAMELESS, files: null }),
]
const LIST = [
  entry('a', 'Some.Release.Name.S01.1080p', { downloadLimit: 2_000_000, uploadLimit: 500_000 }),
  entry('b', 'A.Season.Pack'),
  entry('c', 'Kept.Paused', { ephemeral: true }),
  entry('d', 'Having.Trouble'),
  entry('4', 'Also.Temporary', { ephemeral: true }),
  entry('5', 'Stalled'),
  { ...entry('6', ''), magnet: NAMELESS, name: undefined },
  entry('e', 'On.Its.Way'),
  entry('f', 'Elsewhere', { started: false }),
  entry('2', 'Made.Here', { started: false, saveTo: 'source' }),
]

const PORT = { port: 41337, listenFailed: [], listeners: [], portOpen: true, inbound: 3 }
const READOUTS = [
  { reachable: { ...PORT, listeners: [{ up: true }] }, inboundNow: { total: 1, byTransport: { utp: 1 } } },
  { reachable: PORT, inboundNow: { total: 3, byTransport: { utp: 2, tcp: 1 } } },
  { reachable: { ...PORT, inbound: 0 }, inboundNow: { total: 0, byTransport: {} } },
  { reachable: { ...PORT, portOpen: false }, inboundNow: { total: 0, byTransport: {} } },
  { reachable: { ...PORT, portOpen: false, listeners: [{ healing: true }] }, inboundNow: { total: 0, byTransport: {} } },
  { reachable: { ...PORT, port: 0 }, inboundNow: { total: 0, byTransport: {} } },
  { reachable: { ...PORT, listenFailed: ['tcp 0.0.0.0'] }, inboundNow: { total: 0, byTransport: {} } },
]

const post = (page: Page, ...messages: object[]) => page.evaluate((all) => {
  const { engine } = window as unknown as { engine: (data: object) => void }
  for (const message of all) engine(message)
}, messages)

const drawn = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

/** Opens the page, the engine ready and answering with `list` and `torrents`. */
const library = async (page: Page, list: object[], torrents: object[], extra: object = READOUTS[0]!) => {
  await page.waitForFunction(() => (window as unknown as { engineListens: () => boolean }).engineListens())
  await post(page, { type: 'ready' }, { type: 'list', list }, { type: 'state', torrents, rateLimits: { down: 5_000_000, up: 0 }, ...extra })
  await drawn(page)
}

/** The page's text and the words its controls carry for a screen reader, a tooltip or an empty field. */
const wordsOf = (page: Page) => page.evaluate(() => [...document.body.querySelectorAll<HTMLElement>('*:not(style, script)')].flatMap(element => [
  [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim(),
  ...['aria-label', 'placeholder', 'data-tooltip-content', 'title'].map(name => element.getAttribute(name) ?? ''),
]).filter(Boolean))

/** What has no room: a sideways scroll, a box past the window's edge, a line of text clipped, a footer label broken. */
const cutOff = (page: Page) => page.evaluate(() => {
  const width = document.documentElement.clientWidth
  const named = (element: Element) => `${element.tagName.toLowerCase()}.${element.getAttribute('class') ?? ''} ${element.textContent?.slice(0, 40)}`
  return [
    ...document.documentElement.scrollWidth > width ? [`the page scrolls sideways by ${document.documentElement.scrollWidth - width} px`] : [],
    ...[...document.body.querySelectorAll<HTMLElement>('*:not(style, script)')].flatMap((element) => {
      const box = element.getBoundingClientRect()
      const own = [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())
      return box.width > 0 && (box.left < 0 || box.right > width + 0.5) ? [`past the edge: ${named(element)}`]
        // a torrent's name is as long as it is, so the table's and the share dialog's end in an ellipsis in any language;
        // a hint wraps, and only its arrow hangs past its box, on the side away from where it is placed; a box that
        // scrolls, the share link's, cuts nothing off
        : own && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).display !== 'inline'
          && !element.matches('.torrent-table .title, .subject strong, .react-tooltip') && !['auto', 'scroll'].includes(getComputedStyle(element).overflowX)
          ? [`clipped: ${named(element)}`]
        : element.matches('input:placeholder-shown') && getComputedStyle(element).textOverflow !== 'ellipsis' ? ['a placeholder with no room is cut mid letter']
        : element.matches('footer .folder > span') && box.height > 2 * parseFloat(getComputedStyle(element).fontSize) ? [`a footer label broken in two: ${named(element)}`]
        : []
    }),
  ]
})

/** A walk's record: `read` adds what a surface shows, what has no room there, and its screenshot. */
const walk = (page: Page, width: number) => {
  const words: string[] = []
  const cut: string[] = []
  const read = async (surface: string) => {
    await drawn(page)
    words.push(...await wordsOf(page))
    cut.push(...(await cutOff(page)).map(line => `${surface}: ${line}`))
    await page.screenshot({ path: test.info().outputPath(`${width}-${surface}.png`) })
  }
  return { words, cut, read }
}

const opening = (page: Page, language: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LANGUAGE_KEY, language])

/** Fails on anything with no room, and on a word `language` left in English. */
const expectAllTranslated = async (page: Page, language: string, { words, cut }: { words: string[], cut: string[] }) => {
  await expect(page.locator('html')).toHaveAttribute('lang', language)
  expect(cut).toEqual([])
  expect(englishIn([...new Set(words)], english(), language === PSEUDO ? undefined : catalogues()[language])).toEqual([])
}

/** Draws every surface of the page at `width`, and returns all they showed and all that had no room. */
const everySurface = async (page: Page, width: number) => {
  const { words, cut, read } = walk(page, width)
  const reopen = async (filter: string) => {
    await page.evaluate(([key, value]) => localStorage.setItem(key!, value!), [LIST_FILTER_KEY, filter])
    await page.goto(origin)
  }
  await page.setViewportSize({ width, height: 1500 })
  await page.goto(origin)
  await reopen('all')

  await library(page, [], [])
  await expect(page.locator('.empty h1')).toBeVisible()
  await read('empty')

  await library(page, LIST, TORRENTS)
  await expect(page.locator('.torrent')).toHaveCount(LIST.length)
  await read('library')

  await page.locator('.powered button').click()
  await expect(page.locator('.powered [popover]')).toBeVisible()
  await read('FKN mark')
  await page.locator('.powered button').click()

  // an account brings two more readouts, the quota and the sync state, and this page has no account: two written in
  const readouts = page.locator('.stats .readouts')
  await readouts.evaluate((strip) => { for (const stat of [...strip.children].slice(-3, -1)) strip.append(stat.cloneNode(true)) })
  await read('readouts of an account')
  await readouts.evaluate((strip) => { strip.lastElementChild!.remove(); strip.lastElementChild!.remove() })

  for (const readout of READOUTS) {
    await post(page, { type: 'state', torrents: TORRENTS, ...readout })
    await read('inbound')
  }

  const field = page.locator('header form input:not([type=file])')
  await field.fill('not a magnet')
  await read('clearable field')
  await field.press('Enter')
  await expect(page.locator('.toast')).toBeVisible()
  await read('toast refused')
  await field.fill(magnetOf('3', 'Fresh'))
  await field.press('Enter')
  await expect(field).toHaveValue('')
  await read('toast added')

  const autoSave = page.locator('footer .folder').last().getByRole('button')
  await autoSave.first().click()
  await expect(autoSave).toHaveCount(3)
  await read('folder')
  await autoSave.last().click()
  await drawn(page)
  await read('folder as the default')

  await post(page, { type: 'state', torrents: [{ ...TORRENTS[3]!, handle: 5 }, ...TORRENTS.slice(3)] })
  await read('two retrying')

  await page.context().setOffline(true)
  await expect(page.locator('.storage-warning.offline')).toBeVisible()
  await read('offline')
  await page.context().setOffline(false)

  await post(page, { type: 'fatal', message: 'gone' })
  await read('engine stopped')

  await page.goto(origin)
  await library(page, [], [])
  await post(page, { type: 'storage-unavailable' })
  await read('no storage')

  await reopen('library')
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.hidden-note')).toBeVisible()
  await read('two hidden')
  await page.goto(origin)
  await library(page, [LIST[0]!, LIST[2]!], [TORRENTS[0]!, { ...TORRENTS[2]!, files: null }])
  await expect(page.locator('.hidden-note')).toBeVisible()
  await read('one hidden, no size')

  await page.goto(origin)
  await library(page, [LIST[2]!], TORRENTS.slice(2, 3))
  await expect(page.locator('.empty')).toBeVisible()
  await read('nothing matches')

  await reopen('temporary')
  await library(page, LIST.slice(0, 2), TORRENTS.slice(0, 2))
  await expect(page.locator('.empty')).toBeVisible()
  await read('no temporary downloads')

  await page.evaluate(key => localStorage.setItem(key, 'table'), LIST_VIEW_KEY)
  await reopen('all')
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.torrent-table')).toBeVisible()
  await read('table')
  await page.evaluate(key => localStorage.removeItem(key), LIST_VIEW_KEY)
  return { words, cut }
}

const answer = (page: Page, answers: object) => page.evaluate(value => localStorage.setItem('spec:storage', value), JSON.stringify(answers))

/** Opens the page as a first visit does, which offers the sample once no cloud library answered. */
const firstVisit = async (page: Page) => {
  await page.evaluate(() => { localStorage.setItem('spec:first-visit', '1'); localStorage.removeItem('ripple:demo-seeded') })
  await page.goto(origin)
  await library(page, [], [])
  await expect(page.locator('.sample')).toBeVisible({ timeout: 15_000 })
}

/** Draws what asks a storage, an account or a first visit of the browser, at `width`. */
const smallParts = async (page: Page, width: number) => {
  const { words, cut, read } = walk(page, width)
  const open = async () => {
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
  }
  await page.setViewportSize({ width, height: 1500 })
  await page.goto(origin)

  await answer(page, { low: true })
  await open()
  const room = page.locator('.storage-warning:not(.offline)')
  await expect(room).toBeVisible()
  await read('room')
  await room.getByRole('button').first().click()
  await expect(room.getByRole('button')).toHaveCount(1)
  await read('room, the ask refused')
  const autoSave = page.locator('footer .folder').last().getByRole('button')
  await autoSave.first().click()
  await expect(room.getByRole('button')).toContainText(FOLDER)
  await read('room, a folder chosen')
  await room.getByRole('button').click()
  await expect(room.getByRole('button')).toHaveCount(0)
  await read('room, finished downloads moving out')

  await answer(page, { persisted: true })
  await open()
  await read('persistent')
  await answer(page, { denied: true })
  await open()
  await read('blocked')
  await answer(page, {})

  await page.evaluate(value => localStorage.setItem('spec:account', value), JSON.stringify(ACCOUNT))
  await open()
  await read('account')
  await page.locator('.account-tag').click()
  await expect(page.getByRole('menu')).toBeVisible()
  await read('account menu')
  await page.evaluate(() => localStorage.removeItem('spec:account'))

  await firstVisit(page)
  await read('sample')
  return { words, cut }
}

// a torrent's own download limit above the session's 5 MB/s, so the session limit is the one that binds
const HELD = { ...LIST[0]!, downloadLimit: 8_000_000 }
const QUEUED = snapshot(1, 'a', 'Some.Release.Name.S01.1080p', { queuePosition: 2 })

/** Draws the options menu, the options dialog, both speed limit dialogs and a confirmation, at `width`. */
const optionSurfaces = async (page: Page, width: number) => {
  const { words, cut, read } = walk(page, width)
  const row = (name: string) => page.locator('.torrent', { hasText: name })
  const menu = page.getByRole('menu')
  const dialog = page.getByRole('dialog')
  await page.setViewportSize({ width, height: 1500 })
  await page.goto(origin)
  await library(page, [HELD, ...LIST.slice(1)], [QUEUED, ...TORRENTS.slice(1)])
  // a folder, so the options offer to move a torrent there
  const autoSave = page.locator('footer .folder').last().getByRole('button')
  await autoSave.first().click()
  await expect(autoSave).toHaveCount(3)

  // a menu closes when the list under it scrolls, and a click's own scroll to its row is heard a frame after the menu
  // opens, so the row is brought into view first
  const openMenu = async (name: string) => {
    await row(name).scrollIntoViewIfNeeded()
    await drawn(page)
    await row(name).click({ button: 'right' })
    await expect(menu).toBeVisible()
  }

  for (const name of ['Some.Release.Name.S01.1080p', 'Elsewhere']) {
    await openMenu(name)
    await read(`menu of ${name}`)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  }

  for (const name of ['A.Season.Pack', 'Having.Trouble', 'Elsewhere', 'Some.Release.Name.S01.1080p']) {
    await row(name).locator('button.more').click()
    await expect(dialog).toBeVisible()
    await read(`options of ${name}`)
    if (name === 'Some.Release.Name.S01.1080p') break
    await dialog.locator('footer button').click()
    await expect(dialog).toHaveCount(0)
  }
  // the folder for a torrent still downloading, so the move waits and a toast says so
  await dialog.getByRole('radio').nth(1).click()
  await expect(page.locator('.toast')).toBeVisible()
  await read('a move that waits')
  // the speed group's first item, by the order buildTorrentOptions gives: actions, manage, location, storage, piece order, speed
  await dialog.getByRole('group').nth(5).getByRole('button').first().click()
  await expect(dialog.locator('.note')).toBeVisible()
  await read('limit held by the total')
  await dialog.locator('input[type=number]').fill('')
  await expect(dialog.locator('.problem')).toBeVisible()
  await read('limit with no number')
  await dialog.getByRole('checkbox').check()
  await read('limit removed')
  await dialog.locator('.actions button').first().click()
  await expect(dialog).toHaveCount(0)

  await page.locator('footer .folder').first().getByRole('button').first().click()
  await expect(dialog).toBeVisible()
  await read('total limit')
  await dialog.locator('.actions button').first().click()
  await expect(dialog).toHaveCount(0)

  await openMenu('Some.Release.Name.S01.1080p')
  await menu.locator('button.danger').last().click()
  await expect(dialog.getByRole('checkbox')).toBeVisible()
  await read('removal confirmed first')
  await dialog.locator('.actions button').first().click()
  await expect(dialog).toHaveCount(0)
  return { words, cut }
}

// what the overview reads off a status beside what a row reads, and the engine's answer about one torrent's swarm
const DETAIL_STATUS = {
  allTimeDownload: 2.25 * GB, allTimeUpload: 0.4 * GB, sessionDownload: GB, sessionUpload: 0.1 * GB, wasted: 4096, swarmSeeds: 40,
  swarmPeers: 120, numConnections: 64, connectionsLimit: 200, availability: 2.4, addedAt: 1_755_000_000, completedAt: 0,
  lastSeenComplete: 1_755_003_600, hadIncoming: true, savePath: '/downloads', numPiecesTotal: 274_658, numPiecesHave: 137_329,
}
const SWARM_PEER = { client: 'qBittorrent 4.6.5', flags: 0, source: 0, downloadRate: 120_000, uploadRate: 40_000, totalDownload: 5_000_000, totalUpload: 900_000, progress: 0.42 }
// libtorrent-wasm's PEER_FLAG and PEER_SOURCE: an incoming encrypted seed over uTP from a tracker, with no client name, and
// one dialled over TCP found on the DHT
const SWARM_PEERS = [
  { ...SWARM_PEER, endpoint: '203.0.113.7:51413', client: '', flags: (1 << 17) | (1 << 19) | 1024, source: 1 },
  { ...SWARM_PEER, endpoint: '198.51.100.1:6881', flags: 32, source: 2, downloadRate: 0 },
]
const SWARM_TRACKER = { message: '', verified: true, nextAnnounceIn: 1_700, seeders: 40, leechers: 9, downloaded: 500, fails: 0, updating: false }
const SWARM_TRACKERS = [
  { ...SWARM_TRACKER, url: 'udp://tracker.opentrackr.org:1337/announce', tier: 0 },
  { ...SWARM_TRACKER, url: 'udp://open.demonii.com:1337/announce', tier: 1, fails: 3 },
  { ...SWARM_TRACKER, url: 'udp://tracker.torrent.eu.org:451/announce', tier: 2, fails: -1, seeders: -1, leechers: -1, nextAnnounceIn: -1 },
  { ...SWARM_TRACKER, url: 'https://tracker.example.org/announce', tier: 3, updating: true },
]

/** Draws each tab of the details panel, before and after the engine answers about the swarm, at `width`. */
const detailSurfaces = async (page: Page, width: number) => {
  const { words, cut, read } = walk(page, width)
  const selected = TORRENTS[3]!
  const torrents = TORRENTS.map(t => t === selected ? { ...t, status: { ...t.status, ...DETAIL_STATUS } } : t)
  await page.setViewportSize({ width, height: 1500 })
  // as tall as it goes, so a screenshot shows the whole overview
  await page.addInitScript(() => localStorage.setItem('ripple:dock-height', '720'))
  await page.goto(origin)
  await library(page, LIST, torrents)
  const dock = page.locator('main + section')
  const tab = (i: number) => dock.locator('.tabs button').nth(i)
  await page.locator('.torrent', { hasText: 'Having.Trouble' }).click()
  await expect(dock.locator('.fact').first()).toBeVisible()
  await read('details overview')
  await tab(1).click()
  await expect(dock.locator('.row.file')).toHaveCount(1)
  await read('details content')
  await tab(2).click()
  await expect(dock.locator('.none')).toBeVisible()
  await read('details asking')
  await post(page, { type: 'state', torrents, detail: { handle: selected.handle, peers: [], trackers: [] } })
  await read('details nobody')
  await tab(3).click()
  await read('details no trackers')
  await post(page, { type: 'state', torrents, detail: { handle: selected.handle, peers: SWARM_PEERS, trackers: SWARM_TRACKERS } })
  // about eight letters of a tracker's URL or a peer's address on a line, as the library's table keeps for a name
  const room = () => dock.locator('.rows .row:not(.head) .name').first().evaluate(cell => cell.getBoundingClientRect().width)
  await expect(dock.locator('.rows .row')).toHaveCount(SWARM_TRACKERS.length + 1)
  await read('details trackers')
  expect(await room(), 'a tracker\'s URL has room').toBeGreaterThanOrEqual(80)
  await tab(2).click()
  await expect(dock.locator('.rows .row')).toHaveCount(SWARM_PEERS.length + 1)
  await read('details peers')
  expect(await room(), 'a peer\'s address has room').toBeGreaterThanOrEqual(80)
  return { words, cut }
}

const FRESH = magnetOf('7', 'Fresh.Pack')
const FRESH_FILES = {
  files: [{ path: 'Fresh.Pack/Fresh.Pack.S01E01.1080p.mkv', size: 4.5 * GB }, { path: 'Fresh.Pack/Extras/Commentary.srt', size: 40_000 }],
  contentSize: 4.5 * GB + 40_000,
  pieceLength: 16_384,
}
const FRESH_LIST = [...LIST, entry('7', 'Fresh.Pack', { ephemeral: true })]
const FRESH_TORRENTS = [...TORRENTS, snapshot(9, '7', 'Fresh.Pack', { progress: 0, totalDone: 0 }, { files: FRESH_FILES })]

/** Writes the folder the create dialog is handed: a file, one in a subfolder and one the system wrote, or the first alone. */
const folderToShare = (page: Page, whole: boolean) => page.evaluate(async (whole) => {
  const root = await navigator.storage.getDirectory()
  await root.removeEntry('Holiday', { recursive: true }).catch(() => {})
  const dir = await root.getDirectoryHandle('Holiday', { create: true })
  const write = async (at: FileSystemDirectoryHandle, name: string, size: number) => {
    const writable = await (await at.getFileHandle(name, { create: true })).createWritable()
    await writable.write(new Uint8Array(size).fill(7))
    await writable.close()
  }
  await write(dir, 'Episode 1.mkv', 300_000)
  if (!whole) return
  await write(await dir.getDirectoryHandle('Subtitles', { create: true }), 'Episode 1.srt', 2_000)
  await write(dir, '.DS_Store', 10)
}, whole)

/** Draws the add, share and create dialogs in each of their states, at `width`. */
const dialogSurfaces = async (page: Page, width: number) => {
  const { words, cut, read } = walk(page, width)
  const dialog = page.getByRole('dialog')
  const header = page.locator('header')
  const field = header.locator('form input:not([type=file])')
  await page.setViewportSize({ width, height: 1500 })
  // an add the person makes asks first, and the browser has little room left, so the add says it will not fit
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto(origin)
  await answer(page, { low: true })
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const autoSave = page.locator('footer .folder').last().getByRole('button')
  await autoSave.first().click()
  await expect(autoSave).toHaveCount(3)

  await field.fill(FRESH)
  await field.press('Enter')
  await expect(dialog).toBeVisible()
  await read('add, before its file list')
  await post(page, { type: 'list', list: FRESH_LIST }, { type: 'state', torrents: FRESH_TORRENTS })
  await expect(dialog.locator('.file')).toHaveCount(2)
  await expect(dialog.locator('.fit')).toBeVisible()
  await read('add')
  await dialog.locator('.bulk button').nth(1).click()
  await expect(dialog.locator('.problem')).toBeVisible()
  await read('add, nothing chosen')
  await dialog.locator('footer button:not(.primary)').click()
  await expect(dialog).toHaveCount(0)

  // a link from another site, which says who sent it
  await page.goto(`${origin}/?add=${encodeURIComponent(FRESH)}`, { referer: 'https://example.org/list' })
  await library(page, FRESH_LIST, FRESH_TORRENTS)
  await expect(dialog.locator('.file')).toHaveCount(2)
  await read('add, sent by a site')
  await page.goto(`${origin}/?add=not-a-magnet`)
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.toast')).toBeVisible()
  await read('add, refused')

  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  await header.locator('button.share').first().click()
  await expect(dialog).toBeVisible()
  await read('share, asking')
  await dialog.locator('form input').fill(magnetOf('8', 'Pasted'))
  await dialog.locator('form button').click()
  await expect(dialog.locator('.subject')).toBeVisible()
  await read('share, before its file list')
  await dialog.locator('footer button').first().click()
  await dialog.locator('input[type=file]').setInputFiles(join(ROOT, 'src', 'assets', 'sintel.torrent'))
  await expect(dialog.locator('details.files')).toBeVisible()
  await dialog.locator('details.files summary').click()
  await dialog.locator('details.snippet summary').click()
  await read('share')
  await dialog.locator('.file input').first().uncheck()
  await read('share, some files')
  await dialog.locator('.bulk button').nth(1).click()
  await expect(dialog.locator('.warn')).toBeVisible()
  await read('share, no file')
  await dialog.locator('.seg button').first().click()
  await expect(dialog.locator('#share-file')).toBeVisible()
  await read('share, a watch link')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  await dialog.locator('.out button').first().click()
  await expect(page.locator('.toast')).toBeVisible()
  await read('share, copied')
  await dialog.locator('footer button').last().click()
  await expect(dialog).toHaveCount(0)

  await folderToShare(page, true)
  await header.locator('button.share').nth(1).click()
  await expect(dialog).toBeVisible()
  await read('create')
  await dialog.locator('button.go').click()
  await expect(dialog.locator('.facts')).toBeVisible()
  for (const summary of await dialog.locator('details summary').all()) await summary.click()
  await read('create, a folder read')
  await dialog.locator('select').first().selectOption('hybrid')
  await expect(dialog.locator('.fact')).toHaveCount(4)
  await read('create, hybrid')
  await dialog.locator('label.field input').first().fill('')
  await dialog.locator('button.go').click()
  await expect(dialog.locator('.warn')).toBeVisible()
  await read('create, refused')
  await dialog.locator('label.field input').first().fill('Holiday')
  await dialog.locator('button.go').click()
  await expect(dialog.locator('[data-outcome]')).toBeVisible()
  await read('create, sharing')

  // another, from a folder holding one file at its root
  await folderToShare(page, false)
  await dialog.locator('footer button').nth(1).click()
  await dialog.locator('button.go').click()
  await dialog.locator('select').first().selectOption('v2')
  await expect(dialog.locator('p.warn')).toBeVisible()
  await read('create, v2 and one file')
  return { words, cut }
}

test.describe('in a language ripple does not offer yet', () => {
  for (const language of [PSEUDO, 'de', 'ja', 'fr']) {
    test(`${language}: every surface fits at 1280 and 390 px, with none of the page's own words in English`, async ({ page }) => {
      test.setTimeout(240_000)
      await opening(page, language)
      for (const width of [1280, 390]) {
        const seen = await everySurface(page, width)
        expect(seen.words.length, `${width} px: the control, the page's words were read`).toBeGreaterThan(150)
        await expectAllTranslated(page, language, seen)
      }
    })

    for (const width of [1280, 390]) {
      test(`${language} at ${width} px: the storage notice, the account and the sample fit, in the language`, async ({ page }) => {
        test.setTimeout(120_000)
        await opening(page, language)
        await expectAllTranslated(page, language, await smallParts(page, width))
      })

      test(`${language} at ${width} px: the details panel fits, in the language`, async ({ page }) => {
        await opening(page, language)
        await expectAllTranslated(page, language, await detailSurfaces(page, width))
      })

      test(`${language} at ${width} px: the add, share and create dialogs fit, in the language`, async ({ page }) => {
        test.setTimeout(120_000)
        await opening(page, language)
        await expectAllTranslated(page, language, await dialogSurfaces(page, width))
      })

      test(`${language} at ${width} px: the options menu and its dialogs fit, in the language`, async ({ page }) => {
        test.setTimeout(120_000)
        await opening(page, language)
        await expectAllTranslated(page, language, await optionSurfaces(page, width))
      })

      test(`${language} at ${width} px: a tab another took over, and an update on its way, fit, in the language`, async ({ page }) => {
        const { words, cut, read } = walk(page, width)
        await opening(page, language)
        await page.setViewportSize({ width, height: 844 })
        await page.addInitScript(updateStandIn)
        await page.goto(origin)
        await page.locator('footer').waitFor()
        await page.evaluate(() => (window as unknown as { updateTaken: () => void }).updateTaken())
        await expect(page.locator('body > [role=status]')).toBeVisible()
        await read('updating')
        await expectAllTranslated(page, language, { words, cut })

        // with no Web Locks only one tab runs, the first
        const noLocks = () => { delete (Navigator.prototype as unknown as { locks?: LockManager }).locks }
        const context = page.context()
        const pages = [await context.newPage(), await context.newPage()]
        for (const tab of pages) {
          await prepare(tab)
          await opening(tab, language)
          await tab.setViewportSize({ width, height: 844 })
          await tab.addInitScript(noLocks)
        }
        await pages[0]!.goto(origin)
        await pages[0]!.locator('footer').waitFor()
        await pages[1]!.goto(origin)
        await expect(pages[1]!.getByRole('button')).toHaveCount(1)
        const taken = walk(pages[1]!, width)
        await taken.read('another tab')
        await expectAllTranslated(pages[1]!, language, taken)
      })
    }
  }

  test('de: each count takes its own form, and a value lands where the language puts it', async ({ page }) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LANGUAGE_KEY, 'de'])
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    const downloading = page.locator('.torrent', { hasText: 'Some.Release.Name.S01.1080p' })
    const seeding = page.locator('.torrent', { hasText: 'A.Season.Pack' })
    await expect(downloading.locator('.peers')).toHaveText('82 Peers')
    await expect(seeding.locator('.peers')).toHaveText('1 Peer')
    await expect(page.locator('.storage-warning.offline')).toHaveText('Ein Download hatte ein Problem, neuer Versuch läuft')
    await expect(downloading.getByRole('button', { name: 'Some.Release.Name.S01.1080p pausieren' })).toBeVisible()
    await expect(seeding.locator('.pct')).toHaveText(/^100\s%$/u)
    await expect(page.locator('.powered button')).toHaveAttribute('aria-label', 'Bereitgestellt von FKN')
    await expect(page.locator('.powered [popover] a')).toHaveText('So funktioniert es')
    await expect(page.locator('.powered [popover] a')).toHaveAttribute('href', 'https://docs.fkn.dev/user/')
    const stalled = page.locator('.torrent', { hasText: 'Stalled' })
    await expect(stalled.locator('.meta > span').last()).toHaveText('eingereiht')
    await expect(page.locator('.torrent', { hasText: 'Metadaten werden geladen…' })).toBeVisible()
    await stalled.click()
    await expect(page.locator('main + section')).toContainText('eingereiht')
    await post(page, { type: 'state', torrents: [{ ...TORRENTS[3]!, handle: 5 }, ...TORRENTS.slice(3)] })
    await expect(page.locator('.storage-warning.offline')).toHaveText('2 Downloads hatten ein Problem, neuer Versuch läuft')
    await page.evaluate(([key, value]) => localStorage.setItem(key!, value!), [LIST_FILTER_KEY, 'library'])
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    await expect(page.locator('.hidden-note')).toContainText(/^2 temporäre Downloads ausgeblendet · 9\sGB/u)
  })
})

test.describe('the Inbound tooltip joins its two sentences as the language does', () => {
  const JOINS = { ja: '。このセッション', 'zh-Hans': '。本次', 'zh-Hant': '。本次', fr: '\\. Acceptés' }
  for (const [language, join] of Object.entries(JOINS)) {
    test(language, async ({ page }) => {
      await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LANGUAGE_KEY, language])
      await page.goto(origin)
      await library(page, LIST, TORRENTS)
      await expect(page.locator('.stats [data-tooltip-content*="41337"]')).toHaveAttribute('data-tooltip-content', new RegExp(join))
    })
  }
})

test.describe('on a phone', () => {
  const opened = async (page: Page, language: string) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LANGUAGE_KEY, language])
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    await expect(page.locator('.torrent, .torrent-table').first()).toBeVisible()
  }

  for (const language of ['en', 'ru', 'fr']) {
    test(`${language}: the list keeps room for a whole row`, async ({ page }) => {
      await opened(page, language)
      const room = await page.locator('main').evaluate(list => list.clientHeight)
      expect(room).toBeGreaterThanOrEqual(await page.locator('.torrent').first().evaluate(row => row.getBoundingClientRect().height))
    })
  }

  for (const language of ['en', ...Object.keys(catalogues())]) {
    test(`${language}: the table stays inside the window from 320 to 412 px, with a name to read`, async ({ page }) => {
      await page.addInitScript(key => localStorage.setItem(key, 'table'), LIST_VIEW_KEY)
      await opened(page, language)
      await expect(page.locator('.torrent-table')).toBeVisible()
      for (const width of [320, 360, 390, 412]) {
        await page.setViewportSize({ width, height: 844 })
        await drawn(page)
        const { right, window, name } = await page.evaluate(() => ({
          right: document.querySelector('.torrent-table')!.getBoundingClientRect().right,
          window: document.documentElement.clientWidth,
          name: document.querySelector('.torrent-table tbody td.name')!.getBoundingClientRect().width,
        }))
        expect(right, `${width} px`).toBeLessThanOrEqual(window)
        // about eight letters; in DejaVu Sans, which GitHub's runner draws, Brazilian Portuguese at 320 px leaves 83
        expect(name, `${width} px`).toBeGreaterThanOrEqual(80)
      }
    })
  }

  test('the sample\'s two answers stay inside the window', async ({ page }) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LANGUAGE_KEY, 'de'])
    await page.setViewportSize({ width: 320, height: 844 })
    await page.goto(origin)
    await firstVisit(page)
    const right = await page.locator('.sample .actions button').last().evaluate(button => button.getBoundingClientRect().right)
    expect(right).toBeLessThanOrEqual(320)
  })

  test('a row\'s details still open on the screen', async ({ page }) => {
    await opened(page, 'en')
    await page.locator('.torrent').first().click()
    const details = await page.locator('main + section').boundingBox()
    expect(details!.y).toBeLessThan(844)
  })
})

test('the control: in English the same reading finds the page\'s own words', async ({ page }) => {
  test.setTimeout(120_000)
  const { words } = await everySurface(page, 1280)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  expect(englishIn([...new Set(words)], english()).length).toBeGreaterThan(100)
})

test('the control: in English the small parts\' own words are read too', async ({ page }) => {
  test.setTimeout(120_000)
  const { words } = await smallParts(page, 1280)
  for (const text of ['Running out of room', 'Persistent', 'Blocked', 'Manage account', 'Add Sintel']) expect(words).toContain(text)
})

test('the control: in English the details panel\'s own words are read too', async ({ page }) => {
  const { words } = await detailSurfaces(page, 1280)
  for (const text of [
    'Details for Having.Trouble', 'Resize the details panel', 'Torrent details', 'General', 'Transfer', 'Time active', 'Seeds',
    '12 connected of 40 known', 'Inbound peers', 'Yes', 'Completed on', 'Not yet', 'Retrying', 'Content', 'Save', 'Asking the engine…',
    'Nobody is connected right now.', 'No trackers.', 'Working', 'Failed 3×', 'Not contacted', 'Announcing…', 'Tier', 'Next',
    'Address', 'Has', 'Got', 'Sent', 'incoming', 'encrypted', 'seed', 'tracker', 'unknown',
  ]) expect(words).toContain(text)
})

test('the control: in English the options menu\'s and its dialogs\' own words are read too', async ({ page }) => {
  test.setTimeout(120_000)
  const { words } = await optionSurfaces(page, 1280)
  for (const text of [
    'Force recheck', 'Force recheck. Not on this device', 'Queue position 3', 'Try again now', 'Unlimited, 5 MB/s in total',
    '8 MB/s, held to 5 MB/s in total', `Moves to ${FOLDER} when it finishes`, 'Done', 'Capped at 5 MB/s by the total limit.',
    'kB/s', 'Enter a speed in kB/s, or tick Unlimited.', 'Remove limit', 'Cancel', 'Don\'t ask again',
  ]) expect(words).toContain(text)
})
