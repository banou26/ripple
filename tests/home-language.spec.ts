// The library and download pages on built bytes, in each of ripple's languages and the pseudo-language, which a spec
// build offers too (tests/languages.ts), so a test picks one by its setting. The engine is a stand-in this file writes
// to, so each kind of row, banner and readout is drawn with no swarm, and every request leaving this origin is refused.
import type { AddressInfo } from 'node:net'
import type { Frame, Locator, Page } from '@playwright/test'
import type { Plugin } from 'vite-plus'

import { expect, test } from './offline'
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { build } from 'vite-plus'

import { catalogues, english, englishIn, LANGUAGE_KEY, offerEveryLanguage, PSEUDO } from './languages'
import { buildGroupLink, GROUP_LINK_PREFIX, readGroupLink } from '../src/router/group-link'

const ROOT = join(import.meta.dirname, '..')
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
}
const LIST_FILTER_KEY = 'ripple:list-filter'
const LIST_VIEW_KEY = 'ripple:list-view'
const FOLDER = 'A folder with quite a long name'
// longer than the Group chip's word ever has room for
const LONG_GROUP = 'Orbital Gardeners, the whole second season and the specials'
const ACCOUNT = { name: 'A person', premium: false }

/**
 * The account tag and its menu read one hook, so a stand-in for it draws them with nobody signed in: `spec:account`
 * holds the account, or 'out' for fkn.app's Connect FKN frame, or nothing for no answer yet. The FKN quota and the
 * library's sync read `spec:quota` and `spec:sync` the same way, the readouts a signed-in person sees.
 */
const signedIn = (): Plugin => ({
  name: 'spec-signed-in',
  enforce: 'pre',
  load: id => id === join(ROOT, 'src', 'torrent', 'use-account.ts')
    ? `export const useAccount = () => {
        const stored = JSON.parse(localStorage.getItem('spec:account'))
        return { info: stored === 'out' ? null : stored, ready: !!stored, logout: async () => {} }
      }`
    : id === join(ROOT, 'src', 'torrent', 'use-quota.ts')
      ? 'export const useQuota = () => JSON.parse(localStorage.getItem(\'spec:quota\'))'
      : undefined,
  transform: (code, id) => {
    if (id !== join(ROOT, 'src', 'torrent', 'use-cloud-backup.ts')) return undefined
    const hook = 'export const useCloudBackup = (): SyncState => {'
    if (!code.includes(hook)) throw new Error(`use-cloud-backup.ts no longer declares ${hook}`)
    return `${code.replace(hook, 'const ownCloudBackup = (): SyncState => {')}
export const useCloudBackup = (): SyncState => {
  const own = ownCloudBackup()
  const stored = localStorage.getItem('spec:sync')
  return stored ? JSON.parse(stored) : own
}
`
  },
})

let dir: string
let server: Server
let origin: string
/** Each request the server received, as its address and the page it came from. */
const requests: string[] = []

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
  server = createServer((request, response) => {
    requests.push(`${request.url} from ${request.headers.referer}`)
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

// stands in for the engine's worker, for a folder picker and a save picker a headless browser has none of, and for the
// browser's answers about storage, which a test sets through `answer`
const standIns = (folder: string) => {
  const heard = new Set<EventListener>()
  const engine = (data: unknown) => { for (const listener of heard) listener(new MessageEvent('message', { data })) }
  // the reads a save asks for, each answered with zeroes once the test calls answerReads, or failed with the words
  // it hands refuseReads
  const reads: { id: number, len: number }[] = []
  // the torrents those reads were for
  const readFrom = new Set<number>()
  // the info hash of each start the page sent, and the command each went in
  const started: string[] = []
  const startCommands: string[] = []
  let answering = false
  let refusal: unknown
  // each worker the page made, by its script: the engine's, and libav's for a thumbnail
  const workers: { url: string, ended: boolean }[] = []
  const answerAll = () => {
    if (refusal) for (const { id } of reads.splice(0)) engine({ type: 'read-error', id, error: refusal })
    else if (answering) for (const { id, len } of reads.splice(0)) engine({ type: 'read-result', id, data: new Uint8Array(len) })
  }
  Object.defineProperty(window, 'Worker', {
    value: class {
      made = { url: '', ended: false }
      constructor (url: string | URL) {
        this.made.url = String(url)
        workers.push(this.made)
      }
      addEventListener (type: string, listener: EventListener) { if (type === 'message') heard.add(listener) }
      removeEventListener (_: string, listener: EventListener) { heard.delete(listener) }
      postMessage (message: { type?: string, id: number, len: number, handle: number, infoHash: string, infoHashes: string[] }) {
        if (message?.type === 'start' || message?.type === 'start-many') startCommands.push(message.type)
        if (message?.type === 'start') started.push(message.infoHash)
        // answered on arrival, as the engine of this build answers it
        if (message?.type === 'start-many') {
          started.push(...message.infoHashes)
          setTimeout(() => engine({ type: 'answer', id: message.id, value: true }))
        }
        if (message?.type !== 'read') return
        readFrom.add(message.handle)
        reads.push(message)
        setTimeout(answerAll)
      }
      terminate () { this.made.ended = true }
    },
  })
  Object.assign(window, {
    engineListens: () => heard.size > 0,
    workers: () => workers.map(made => ({ ...made })),
    engine,
    answerReads: () => { answering = true; answerAll() },
    readFrom: () => [...readFrom],
    started: () => [...started],
    startCommands: () => [...startCommands],
    refuseReads: (error: unknown) => { refusal = error; answerAll() },
    // refused as a framed page's is, by the test's setting
    showSaveFilePicker: async () => {
      if (localStorage.getItem('spec:picker') === 'refused') throw new DOMException('refused', 'NotAllowedError')
      return { createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }) }
    },
    // the create dialog's pick, by its id, is a folder of its own, which the spec writes (folderToShare); the other is
    // named by `spec:folder` when a test sets it
    showDirectoryPicker: async ({ id }: { id?: string } = {}) =>
      (await navigator.storage.getDirectory()).getDirectoryHandle(id === 'ripple-source' ? 'Holiday' : localStorage.getItem('spec:folder') ?? folder, { create: true }),
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
/** The start commands the page sent the engine, in order. */
const startCommands = (page: Page) => page.evaluate(() => (window as unknown as { startCommands: () => string[] }).startCommands())
const entry = (hash: string, name: string, over: object = {}) => ({ infoHash: hash.repeat(40), magnet: magnetOf(hash, name), name, size: 4.5 * GB, addedAt: 1, started: true, ...over })

const SEEDING = { state: 5, progress: 1, totalDone: 4.5 * GB, totalWanted: 4.5 * GB, downloadRate: 0, numPeers: 1 }

// the FKN quota and the library's sync of a signed-in person, each in the state with the most words
const QUOTA_LEFT = { premium: false, overQuota: false, throttled: false, usedBytes: 2.1 * GB, limitBytes: 5 * GB, remainingBytes: 2.9 * GB, bytesPerSecond: 0, bitsPerSecond: 0 }
const THROTTLED = { ...QUOTA_LEFT, overQuota: true, throttled: true, usedBytes: 5 * GB, remainingBytes: 0, bytesPerSecond: 125_000, bitsPerSecond: 1_000_000 }
const SYNCED = { status: 'synced', reason: null }
const SYNCING = { status: 'syncing', reason: null }
const SYNC_FAILED = { status: 'error', reason: 'write-failed' }

/**
 * Opens the page signed in, as `account` or with the Connect FKN frame for 'out', with these readouts. The offer to
 * switch the VPN off once the quota is used up counts as answered today, so it covers none of them.
 */
const signIn = async (page: Page, quota: object | null, sync: object | null, account: object | 'out' = ACCOUNT) => {
  await page.evaluate(([account, quota, sync]) => {
    localStorage.setItem('spec:account', account!)
    for (const [key, value] of [['spec:quota', quota], ['spec:sync', sync]] as const) {
      if (value) localStorage.setItem(key, value)
      else localStorage.removeItem(key)
    }
    localStorage.setItem('ripple:quota-offer', String(Math.floor(Date.now() / 86_400_000)))
  }, [JSON.stringify(account), quota && JSON.stringify(quota), sync && JSON.stringify(sync)])
  await page.goto(origin)
}

const signOut = async (page: Page) => {
  await page.evaluate(() => { for (const key of ['spec:account', 'spec:quota', 'spec:sync', 'ripple:quota-offer']) localStorage.removeItem(key) })
  await page.goto(origin)
}
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
  // finished and stopped by the person, so it reads Completed and offers Start
  snapshot(11, '9', 'Watched.Film', { ...SEEDING, paused: true }, { userPaused: true }),
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
  entry('9', 'Watched.Film'),
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

/** A page, or the frame another site shows ripple in. */
type Shown = Page | Frame

const post = (page: Shown, ...messages: object[]) => page.evaluate((all) => {
  const { engine } = window as unknown as { engine: (data: object) => void }
  for (const message of all) engine(message)
}, messages)

const drawn = (page: Shown) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

/** Opens the page, the engine ready and answering with `list` and `torrents`. */
const library = async (page: Shown, list: object[], torrents: object[], extra: object = READOUTS[0]!) => {
  await page.waitForFunction(() => (window as unknown as { engineListens: () => boolean }).engineListens())
  await post(page, { type: 'ready' }, { type: 'list', list }, { type: 'state', torrents, rateLimits: { down: 5_000_000, up: 0 }, ...extra })
  await drawn(page)
}

/** The text in `root` and the words its controls carry for a screen reader, a tooltip or an empty field. */
const wordsOf = (page: Shown, root = 'body') => page.evaluate(root => [...document.querySelector(root)!.querySelectorAll<HTMLElement>('*:not(style, script)')].flatMap(element => [
  [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim(),
  ...['aria-label', 'placeholder', 'data-tooltip-content', 'title'].map(name => element.getAttribute(name) ?? ''),
]).filter(Boolean), root)

/**
 * What has no room: a sideways scroll, a box past the window's edge, a line of text clipped, an icon squeezed narrower
 * than it is tall by a label that wraps beside it, a footer label broken.
 */
const cutOff = (page: Shown, root = 'body') => page.evaluate((root) => {
  const width = document.documentElement.clientWidth
  const named = (element: Element) => `${element.tagName.toLowerCase()}.${element.getAttribute('class') ?? ''} ${element.textContent?.slice(0, 40)}`
  // always to an ellipsis, which is drawn only where the overflow is cut: on a phone the sort chip's word, which gives
  // way first, then the group chip's (the toolbar test checks the order), and the footer's Speed; a group's name, as
  // long as somebody typed it, at any width; and at 390 px the pseudo-language's filter, whose words run longer than
  // any language's (the Temporary test holds every language's whole)
  const givesWay = (element: Element) => (width <= 560 && element.matches('.list-toolbar .chip.sort .value, .list-toolbar .chip.group .value, footer .folder > span')
    || element.matches('.list-toolbar .chip.group .value[dir=auto]')
    || width <= 400 && document.documentElement.lang === 'en-XA' && element.matches('.list-toolbar .chip.show .value'))
    && getComputedStyle(element).textOverflow === 'ellipsis' && ['hidden', 'clip'].includes(getComputedStyle(element).overflowX)
  return [
    ...document.documentElement.scrollWidth > width ? [`the page scrolls sideways by ${document.documentElement.scrollWidth - width} px`] : [],
    ...[...document.querySelector(root)!.querySelectorAll<HTMLElement>('*:not(style, script)')].flatMap((element) => {
      const box = element.getBoundingClientRect()
      const own = [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())
      // a line of the stats strip scrolls sideways on a phone, so a readout past the window's edge is reachable
      return box.width > 0 && (box.left < 0 || box.right > width + 0.5) && !element.closest('.stats .line') ? [`past the edge: ${named(element)}`]
        // a torrent's name is as long as it is, so the table's ends in an ellipsis in any language; a hint wraps, and
        // only its arrow hangs past its box, on the side away from where it is placed; a box that scrolls, the share
        // link's, cuts nothing off; words kept for a screen reader alone are drawn 1 px wide
        : own && box.width > 1 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).display !== 'inline' && !givesWay(element)
          && !element.matches('.torrent-table .title, .react-tooltip, .ripple-overlay-content .file-name') && !['auto', 'scroll'].includes(getComputedStyle(element).overflowX)
          ? [`clipped: ${named(element)}`]
        : element instanceof SVGSVGElement && box.height > 0 && box.width < box.height - 0.5
          ? [`an icon squeezed to ${Math.round(box.width)} of ${Math.round(box.height)} px: ${named(element.parentElement!)}`]
        : element.matches('input:placeholder-shown') && getComputedStyle(element).textOverflow !== 'ellipsis' ? ['a placeholder with no room is cut mid letter']
        : element.matches('footer .folder > span') && box.height > 2 * parseFloat(getComputedStyle(element).fontSize) ? [`a footer label broken in two: ${named(element)}`]
        : []
    }),
  ]
}, root)

/**
 * A walk's record: `read` adds what a surface shows in `root`, in `page` or a frame of it, what has no room there, and
 * its screenshot.
 */
const walk = (page: Page, width: number, root = 'body') => {
  const words: string[] = []
  const cut: string[] = []
  const read = async (surface: string, shown: Shown = page) => {
    await drawn(shown)
    words.push(...await wordsOf(shown, root))
    cut.push(...(await cutOff(shown, root)).map(line => `${surface}: ${line}`))
    await page.screenshot({ path: test.info().outputPath(`${width}-${surface}.png`) })
  }
  return { words, cut, read }
}

const opening = (page: Page, language: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LANGUAGE_KEY, language])

/**
 * Opens Settings from the library's gear, in the page, so the engine runs on. A phone's add field unfolds over the
 * gear while it has the focus, so the focus leaves it first, as a press anywhere else takes it.
 */
const toSettings = async (page: Page) => {
  await page.locator('header form input:not([type=file])').blur()
  await page.locator('header a.settings').click()
  await expect(page).toHaveURL(`${origin}/settings`)
}

/** Back to the library from Settings, in the page. */
const toLibrary = async (page: Page) => {
  await page.locator('header a.back').click()
  await expect(page.locator('.torrent').first()).toBeVisible()
}

/** Chooses the auto-save folder on Settings, the stand-in picker's, and comes back to the library. */
const chooseFolder = async (page: Page) => {
  await toSettings(page)
  const autoSave = page.locator('main .folder').last().getByRole('button')
  await autoSave.first().click()
  await expect(autoSave).toHaveCount(3)
  await toLibrary(page)
}

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

  // a phone's header leaves FKN's mark to the footer's Powered by FKN
  if (width > 700) {
    await page.locator('.powered button').click()
    await expect(page.locator('.powered [popover]')).toBeVisible()
    await read('FKN mark')
    await page.locator('.powered button').click()
  }

  // an account brings two more readouts, the quota and the sync state
  await signIn(page, QUOTA_LEFT, SYNCED)
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.stats .stat.sync')).toBeVisible()
  await read('readouts of an account')
  await signIn(page, THROTTLED, SYNC_FAILED)
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.stats .stat.quota.throttled')).toBeVisible()
  await read('readouts of an account, throttled')
  await signOut(page)
  await library(page, LIST, TORRENTS)

  for (const readout of READOUTS) {
    await post(page, { type: 'state', torrents: TORRENTS, ...readout })
    await read('inbound')
  }

  const field = page.locator('header form input:not([type=file])')
  await field.fill('not a magnet')
  await read('clearable field')
  await field.fill('')
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text/plain', 'not a magnet')
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.toast')).toBeVisible()
  await read('toast refused')
  await field.fill(magnetOf('3', 'Fresh'))
  await field.press('Enter')
  await expect(field).toHaveValue('')
  await read('toast added')

  await toSettings(page)
  await read('settings')
  const autoSave = page.locator('main .folder').last().getByRole('button')
  await autoSave.first().click()
  await expect(autoSave).toHaveCount(3)
  await read('settings, a folder')
  await autoSave.last().click()
  await drawn(page)
  await read('settings, the folder the default')
  await toLibrary(page)

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
  await read('one hidden')

  await page.goto(origin)
  await library(page, [LIST[2]!], TORRENTS.slice(2, 3))
  await expect(page.locator('.empty')).toBeVisible()
  await read('nothing matches')

  await reopen('temporary')
  await library(page, LIST.slice(0, 2), TORRENTS.slice(0, 2))
  await expect(page.locator('.empty')).toBeVisible()
  await read('nothing temporary')

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
  // the library opens again on the way back from Settings, and offers the move to the folder chosen there
  await chooseFolder(page)
  const move = room.getByRole('button', { name: FOLDER })
  await expect(move).toBeVisible()
  await read('room, a folder chosen')
  await move.click()
  await expect(move).toHaveCount(0)
  await read('room, finished downloads moving out')

  // Storage's control is on Settings
  await answer(page, { persisted: true })
  await open()
  await read('persistent')
  await toSettings(page)
  await read('persistent, Settings')
  await answer(page, { denied: true })
  await open()
  await read('blocked')
  await toSettings(page)
  await read('blocked, Settings')
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
  await chooseFolder(page)

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

/** The fragment of the link of a group of `magnets` named `name`, as Copy link builds it. */
/** A group's name as a sentence holds it, set apart from the words around it. */
const isolated = (name: string) => `\u2068${name}\u2069`

const linkTo = (name: string, magnets: string[]) => buildGroupLink(name, magnets.map(magnet => ({ magnet }))).link!.slice(GROUP_LINK_PREFIX.length)

/** Makes a group of the ticked rows from the bar's Groups menu, named `name`. */
const groupTicked = async (page: Page, name: string) => {
  await page.locator('.bulk-bar button[aria-haspopup=menu]').click()
  await page.getByRole('menu').getByRole('menuitem').last().click()
  await page.getByRole('dialog').locator('input').fill(name)
  await page.getByRole('dialog').locator('button[type=submit]').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** Draws the Group chip and its menu, the bar's Groups menu, a group's dialogs and an empty group, at `width`. */
const groupSurfaces = async (page: Page, width: number) => {
  const { words, cut, read } = walk(page, width)
  const menu = page.getByRole('menu')
  const dialog = page.getByRole('dialog')
  const chip = page.locator('.list-toolbar .chip.group')
  await page.setViewportSize({ width, height: 1500 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  await page.goto(origin)
  await library(page, LIST, TORRENTS)

  await chip.click()
  await expect(menu).toBeVisible()
  await read('group menu, every torrent shown')
  await menu.getByRole('menuitem').click()
  await expect(dialog).toBeVisible()
  await read('new group')
  await dialog.locator('button:not([type=submit])').click()

  for (const name of ['A.Season.Pack', 'Elsewhere', 'Kept.Paused']) await page.locator('.torrent', { hasText: name }).locator('.row-check input').check()
  await page.locator('.bulk-bar button[aria-haspopup=menu]').click()
  await expect(menu).toBeVisible()
  await read('groups of the ticked rows, none yet')
  await page.keyboard.press('Escape')
  await groupTicked(page, 'Orbital Gardeners')
  await expect(page.locator('.toast')).toBeVisible()
  await read('ticked rows put in a group')
  await page.locator('.bulk-bar button[aria-haspopup=menu]').click()
  await expect(menu.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true')
  await read('groups of the ticked rows')
  await page.keyboard.press('Escape')

  await chip.click()
  await menu.getByRole('menuitemradio').last().click()
  await expect(page.locator('.torrent')).toHaveCount(3)
  await read('a group shown')
  await chip.click()
  await expect(menu.getByRole('menuitem')).toHaveCount(5)
  await read('menu of a group shown')
  await menu.getByRole('menuitem').nth(2).click()
  await expect(page.locator('.toast')).toBeVisible()
  await read('its link copied')
  await chip.click()
  await menu.getByRole('menuitem').nth(3).click()
  await expect(dialog.locator('input')).toHaveValue('Orbital Gardeners')
  await read('rename')
  await dialog.locator('button:not([type=submit])').click()
  await chip.click()
  await menu.locator('button.danger').click()
  await expect(dialog.locator('.actions button.danger')).toBeVisible()
  await read('deletion confirmed first')
  await dialog.locator('.actions button').first().click()

  await page.locator('.torrent', { hasText: 'Elsewhere' }).click({ button: 'right' })
  await expect(menu.getByRole('menuitemcheckbox').last()).toHaveAttribute('aria-checked', 'true')
  await read('menu of a torrent in a group')
  await page.keyboard.press('Escape')

  await page.locator('.list-toolbar .pick-all input').check()
  await page.locator('.bulk-bar button[aria-haspopup=menu]').click()
  await menu.getByRole('menuitemcheckbox').click()
  await expect(page.locator('.empty')).toBeVisible()
  await read('an empty group')

  const sent = linkTo('Weekend watch list', [magnetOf('7', 'Seven'), magnetOf('8', 'Eight')])
  await page.goto(`${origin}/add#${sent}`)
  await library(page, LIST, TORRENTS)
  await expect(dialog).toBeVisible()
  await read('a group sent by link')
  await page.goto(`${origin}/add#${sent.slice(0, -8)}`)
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.toast')).toBeVisible()
  await read('a group link cut short')
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
  await chooseFolder(page)

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
  // a share starts from a torrent's options, Watch then Get a share link, and the dialog's first button asks for another
  await page.locator('.torrent', { hasText: 'Some.Release.Name.S01.1080p' }).locator('button.more').click()
  await dialog.getByRole('group').first().getByRole('button').nth(1).click()
  await expect(dialog.locator('.subject')).toBeVisible()
  await dialog.locator('footer button').first().click()
  await expect(dialog.locator('form input')).toBeVisible()
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
  await header.locator('button.create').click()
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

const PACK = magnetOf('7', 'Fresh.Pack')
const PACK_FILES = {
  files: [
    { path: 'Fresh.Pack/Fresh.Pack.S01E01.1080p.mkv', size: 4.5 * GB },
    { path: 'Fresh.Pack/Extras/Commentary.srt', size: 40_000 },
    { path: 'Fresh.Pack/Extras/Notes.txt', size: 2_000 },
  ],
  contentSize: 4.5 * GB + 42_000,
  pieceLength: 16_384,
}
const PACK_LIST = [entry('7', 'Fresh.Pack', { ephemeral: true })]
const PACK_TORRENTS = [snapshot(9, '7', 'Fresh.Pack', { progress: 0, totalDone: 0 }, { files: PACK_FILES })]
// a release's name is one word with no spaces, and the Watch link and the busy button both carry it
const LONG_NAME = '[Group]_A_Really_Long_Episode_Name_Without_Spaces_Whatsoever_S01E01_1080p_HEVC_10bit.mkv'
const LONG = magnetOf('8', 'Long.Pack')
const LONG_FILES = {
  files: [{ path: `Long.Pack/${LONG_NAME}`, size: 1.2 * GB }, { path: 'Long.Pack/Extras.srt', size: 40_000 }],
  contentSize: 1.2 * GB + 40_000,
  pieceLength: 16_384,
}
const LONG_LIST = [entry('8', 'Long.Pack', { ephemeral: true })]
const LONG_TORRENTS = [snapshot(10, '8', 'Long.Pack', { progress: 0, totalDone: 0 }, { files: LONG_FILES })]

/** The download page's link for `magnet`, as a share link writes it. */
const downloadPage = (magnet?: string, search = '') =>
  `${origin}/download${magnet ? `?magnet=${encodeURIComponent(Buffer.from(magnet).toString('base64'))}${search}` : ''}`

/** Draws the download page in each of its states, and framed by another site, at `width`. */
const downloadSurfaces = async (page: Page, width: number) => {
  const { words, cut, read } = walk(page, width)
  const card = page.locator('.card')
  const row = (name: string) => card.locator('.file', { hasText: name })
  const shareNote = page.getByTestId('share-note')
  const ready = (list = PACK_LIST, torrents = PACK_TORRENTS) => library(page, list, torrents)
  await page.setViewportSize({ width, height: 1500 })

  await page.goto(downloadPage(PACK))
  await library(page, [], [])
  await read('before its file list')
  await card.locator('.share button').nth(1).click()
  await expect(card.locator('.share button').nth(1)).toBeDisabled()
  await read('the .torrent building')
  await expect(shareNote).toBeVisible({ timeout: 15_000 })
  await read('the .torrent with no metadata')
  // each note replaces the one before it
  const copy = async (answer: 'refused' | 'copied') => {
    const before = await shareNote.textContent()
    await page.evaluate(refused => { navigator.clipboard.writeText = () => refused ? Promise.reject(new Error('refused')) : Promise.resolve() }, answer === 'refused')
    await card.locator('.share button').first().click()
    await expect(shareNote).not.toHaveText(before!)
    await read(`magnet ${answer}`)
  }
  await copy('refused')
  await copy('copied')

  await ready()
  await expect(card.locator('.file')).toHaveCount(3)
  await read('file list')
  await page.locator('.powered button').click()
  await expect(page.locator('.powered [popover]')).toBeVisible()
  await read('FKN mark')
  await page.locator('.powered button').click()
  await row('Fresh.Pack.S01E01').locator('input').uncheck()
  await read('two ticked')
  await row('Commentary').locator('input').uncheck()
  await read('one ticked')
  await card.locator('.bulk button').nth(1).click()
  await read('none ticked')
  await card.locator('.bulk button').first().click()

  await card.locator('.cta').click()
  await expect(card.locator('.progress')).toBeVisible()
  await read('downloading')
  // about eight letters of a file's name on a line, beside its mark and its button, as the details panel keeps
  const room = await card.locator('.file .name').evaluateAll(names => Math.min(...names.map(name => name.getBoundingClientRect().width)))
  if (room < 80) cut.push(`downloading: a file's name has ${Math.round(room)} px`)
  await post(page, { type: 'engine-reset' })
  await expect(card.locator('.failure')).toBeVisible()
  await read('engine replaced')
  // the job it stopped ends once its save gives up waiting for the service worker
  await expect(card.locator('.progress')).toBeHidden({ timeout: 15_000 })
  await ready()

  await row('Commentary').getByRole('button').click()
  await expect(card.locator('.progress')).toBeVisible()
  await read('downloading one')
  await page.evaluate(() => (window as unknown as { answerReads: () => void }).answerReads())
  await expect(card.locator('.done')).toBeVisible({ timeout: 15_000 })
  await read('one saved')
  await row('Fresh.Pack.S01E01').locator('input').uncheck()
  await card.locator('.cta').click()
  await expect(card.locator('.mark.saved')).toHaveCount(2, { timeout: 15_000 })
  await read('two saved')

  await page.evaluate(() => localStorage.setItem('spec:picker', 'refused'))
  await row('Fresh.Pack.S01E01').getByRole('button').click()
  await expect(card.locator('.failure')).toBeVisible({ timeout: 15_000 })
  await read('too large to save')
  await page.evaluate(() => localStorage.removeItem('spec:picker'))

  await post(page, { type: 'storage-full', full: true })
  await read('out of room')
  await post(page, { type: 'storage-full', full: false }, { type: 'fatal', message: 'gone' })
  await read('engine stopped')

  await page.goto(downloadPage(PACK))
  await library(page, [], [])
  await post(page, { type: 'storage-unavailable' })
  await read('no storage')

  await page.goto(downloadPage(PACK, '&fileIndex=9'))
  await ready()
  await expect(card.locator('.cta')).toBeDisabled()
  await read('no matching files')

  await page.goto(downloadPage(LONG))
  await ready(LONG_LIST, LONG_TORRENTS)
  await expect(card.locator('.watch')).toBeVisible()
  await read('a long name')
  await row(LONG_NAME).getByRole('button').click()
  await expect(card.locator('.progress')).toBeVisible()
  await read('downloading a long name')

  // another site, at another name for this server: a frame on a loopback address from a public site is refused
  writeFileSync(join(dir, 'embedder.html'), `<body style="margin:0"><iframe src="${downloadPage(PACK)}" style="border:0;width:100vw;height:100vh"></iframe>`)
  const embedder = new URL('/embedder.html', origin.replace('127.0.0.1', 'localhost')).href
  await page.route(embedder, route => route.continue())
  await page.goto(embedder)
  const frame = page.frames().find(each => each.url().startsWith(origin))!
  await library(frame, PACK_LIST, PACK_TORRENTS)
  await expect(frame.locator('.note')).toBeVisible()
  await read('framed by another site', frame)
  // the note's link is a part of its sentence, read whole
  words.push(...await frame.locator('.note').allTextContents())

  await page.goto(downloadPage())
  await expect(card.locator('.cta')).toBeDisabled()
  await read('no magnet')
  return { words, cut }
}

/** The player's link for `magnet`, as an embedder writes it. */
const watchPage = (magnet: string) => `${origin}/watch?magnet=${encodeURIComponent(Buffer.from(magnet).toString('base64'))}`

// the swarm as the trackers counted it, as an ordinary player's top row shows it
const PLAYING = snapshot(9, '7', 'Fresh.Pack', { numPeers: 28, numSeeds: 26, swarmSeeds: 216, swarmPeers: 3, uploadRate: 312_000 }, { files: PACK_FILES, swarmDownloads: 8054 })
const RECONNECTING = { reachable: { ...PORT, listeners: [{ healing: true }] } }

/**
 * Draws the player's top row in each state, with each readout's chip, at the top level and framed by another site; then
 * a refusal the engine sends the library, and a read the engine fails on the download page, at `width`.
 */
const engineSurfaces = async (page: Page, width: number) => {
  const row = walk(page, width, '.ripple-overlay-content')
  const whole = walk(page, width)
  const chips = async (surface: string, shown: Shown = page) => {
    // a phone shows no upload speed, so it has no chip to open
    const shownIds = await shown.locator('.ripple-overlay-content [data-tooltip-id]').evaluateAll(anchors => anchors
      .filter(anchor => anchor.getClientRects().length).map(anchor => anchor.getAttribute('data-tooltip-id')!))
    for (const id of shownIds) {
      await shown.locator(`[data-tooltip-id="${id}"]`).first().hover()
      await expect(shown.locator(`[role=tooltip][id="${id}"]`)).toBeVisible()
      await row.read(`${surface}, ${id}`, shown)
      // onto the picture, away from the row
      await page.mouse.move(width / 2, 600)
      await expect(shown.locator(`[role=tooltip][id="${id}"]`)).toBeHidden()
    }
  }
  await page.setViewportSize({ width, height: 844 })

  await page.goto(watchPage(PACK))
  await library(page, PACK_LIST, [{ ...PLAYING, files: null }], RECONNECTING)
  await expect(page.locator('.loading-information')).toBeVisible()
  await row.read('before its metadata')
  await post(page, { type: 'state', torrents: [PLAYING], ...READOUTS[0] })
  await expect(page.getByTestId('peers')).toContainText('28')
  await row.read('playing')
  await chips('playing')
  await post(page, { type: 'state', torrents: [{ ...PLAYING, status: { ...PLAYING.status, swarmSeeds: -1, swarmPeers: -1 } }], ...READOUTS[3] })
  await row.read('before a tracker answers')
  await chips('before a tracker answers')
  await post(page, { type: 'storage-full', full: true })
  await expect(page.locator('.loading-information')).toBeVisible()
  await row.read('out of room')
  await post(page, { type: 'storage-full', full: false }, { type: 'fatal', message: 'gone' })
  await row.read('engine stopped')
  await page.goto(watchPage(PACK))
  await library(page, [], [])
  await post(page, { type: 'storage-unavailable' })
  await expect(page.locator('.loading-information')).toBeVisible()
  await row.read('no storage')

  writeFileSync(join(dir, 'embedder.html'), `<body style="margin:0"><iframe src="${watchPage(PACK)}" style="border:0;width:100vw;height:100vh"></iframe>`)
  const embedder = new URL('/embedder.html', origin.replace('127.0.0.1', 'localhost')).href
  await page.route(embedder, route => route.continue())
  await page.goto(embedder)
  const frame = page.frames().find(each => each.url().startsWith(origin))!
  await library(frame, PACK_LIST, [{ ...PLAYING, windowed: true }])
  await expect(frame.locator('.loading-information')).toBeVisible()
  await row.read('streaming in a frame', frame)
  await chips('streaming in a frame', frame)
  await post(frame, { type: 'storage-full', full: true })
  await expect(frame.locator('.loading-information a')).toBeVisible()
  await row.read('out of room in a frame', frame)
  // the link is a part of its sentence, read whole
  row.words.push(...await frame.locator('.loading-information').allTextContents())

  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  await post(page, { type: 'add-failed', message: { message: 'That is not a valid magnet link' } })
  await expect(page.locator('.toast')).toBeVisible()
  await whole.read('a refused add')

  await page.goto(downloadPage(PACK))
  await library(page, PACK_LIST, PACK_TORRENTS)
  await page.locator('.card .file', { hasText: 'Commentary' }).getByRole('button').click()
  await page.evaluate(() => (window as unknown as { refuseReads: (error: object) => void }).refuseReads({ message: 'torrent paused' }))
  // after its retries
  await expect(page.locator('.card .failure')).toBeVisible({ timeout: 15_000 })
  await whole.read('a read the engine failed')
  return { words: [...row.words, ...whole.words], cut: [...row.cut, ...whole.cut] }
}

// the pseudo-language for length and a language of each script but Korean's and Chinese's: the second wave's other 8,
// all in Latin, passed these on 2026-11-20, about 100 s each, too long for every push
test.describe('in each language', () => {
  for (const language of [PSEUDO, 'de', 'ja', 'fr', 'ar', 'he', 'th', 'hi', 'el', 'uk']) {
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

      test(`${language} at ${width} px: the download page fits, in the language`, async ({ page }) => {
        test.setTimeout(120_000)
        await opening(page, language)
        await expectAllTranslated(page, language, await downloadSurfaces(page, width))
      })

      test(`${language} at ${width} px: the player's top row and the engine's words fit, in the language`, async ({ page }) => {
        test.setTimeout(120_000)
        await opening(page, language)
        await expectAllTranslated(page, language, await engineSurfaces(page, width))
      })

      test(`${language} at ${width} px: the options menu and its dialogs fit, in the language`, async ({ page }) => {
        test.setTimeout(120_000)
        await opening(page, language)
        await expectAllTranslated(page, language, await optionSurfaces(page, width))
      })

      test(`${language} at ${width} px: the groups, their menus and dialogs fit, in the language`, async ({ page }) => {
        test.setTimeout(120_000)
        await opening(page, language)
        await expectAllTranslated(page, language, await groupSurfaces(page, width))
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
    await expect(page.locator('.hidden-note')).toContainText(/^2 Torrents ausgeblendet/u)
  })
})

// on Settings since RIPPLE-130, reached from the library's gear in the page, so the engine the library made runs on
test.describe('the Language setting', () => {
  const select = (page: Page) => page.locator('main .folder select')
  const labels = async (page: Page) => (await page.locator('main .folder > span').allTextContents()).slice(0, 3)
  /** The engine's workers, each with whether it was ended: a thumbnail's libav workers come and go on their own. */
  const engines = (page: Page) => page.evaluate(() => (window as unknown as { workers: () => { url: string, ended: boolean }[] }).workers()
    .filter(({ url }) => !url.includes('libav')))
  /** Each catalogue the page asked for, by its tag. */
  const fetched = (page: Page) => {
    const tags: string[] = []
    page.on('request', (request) => {
      const tag = /^\/assets\/([a-z]{2}(?:-[A-Za-z0-9]+)?)-[\w-]{8}\.js$/.exec(new URL(request.url()).pathname)?.[1]
      if (tag && tag in catalogues()) tags.push(tag)
    })
    return tags
  }

  test('in an English browser the page stays English, fetches no catalogue, and offers Automatic first', async ({ page }) => {
    const tags = fetched(page)
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    await toSettings(page)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect.poll(() => labels(page)).toEqual(['Language', 'On add', 'Storage'])
    await expect(select(page)).toHaveValue('')
    await expect(select(page).locator('option').first()).toHaveText('Automatic (English)')
    expect(tags).toEqual([])
  })

  test('picking French shows the page in French at once, with no reload, the engine running on', async ({ page }) => {
    const tags = fetched(page)
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    const engine = await engines(page)
    expect(engine, 'the control: the stand-in sees the engine made').toEqual([{ url: expect.stringContaining('/assets/'), ended: false }])
    await page.evaluate(() => { (window as unknown as { same: boolean }).same = true })

    await toSettings(page)
    await select(page).selectOption('fr')
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
    await expect.poll(() => labels(page)).toEqual(['Langue', 'À l’ajout', 'Stockage'])
    expect(await page.evaluate(() => localStorage.getItem('ripple:language'))).toBe('fr')
    const { words, cut, read } = walk(page, 1280)
    await read('picked French, Settings')
    await toLibrary(page)
    await read('picked French')
    expect(englishIn([...new Set(words)], english(), catalogues().fr), 'Settings, the header, the list and the footer, all in French').toEqual([])
    expect(cut).toEqual([])

    expect(await page.evaluate(() => (window as unknown as { same?: boolean }).same), 'the same page, not a reload').toBe(true)
    expect(await engines(page), 'the same engine, never ended').toEqual(engine)
    await post(page, { type: 'state', torrents: [{ ...TORRENTS[0]!, status: { ...TORRENTS[0]!.status, numPeers: 41 } }, ...TORRENTS.slice(1)], ...READOUTS[0] })
    await expect(page.locator('.torrent', { hasText: 'Some.Release.Name.S01.1080p' }).locator('.peers')).toHaveText('41 pairs')
    expect(tags).toEqual(['fr'])
  })

  test('a pick is kept over a reload, and Automatic forgets it', async ({ page }) => {
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    await toSettings(page)
    await select(page).selectOption('de')
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await expect(select(page)).toHaveValue('de')
    await select(page).selectOption('')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(select(page)).toHaveValue('')
  })

  test.describe('in a French browser', () => {
    test.use({ locale: 'fr-FR' })

    test('Automatic shows French, and a kept value ripple does not offer is Automatic', async ({ page }) => {
      await opening(page, 'xx')
      await page.goto(origin)
      await library(page, LIST, TORRENTS)
      await toSettings(page)
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
      await expect(select(page)).toHaveValue('')
      await expect(select(page).locator('option').first()).toHaveText('Automatique (Français)')
    })
  })

  test('a link\'s language wins over the pick on /download and /watch, and a page reached from one in place shows the pick', async ({ page }) => {
    await opening(page, 'fr')
    await page.goto(downloadPage(PACK, '&language=de'))
    await library(page, PACK_LIST, PACK_TORRENTS)
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await expect(page.locator('.card .file')).toHaveCount(3)
    expect(englishIn([...new Set(await wordsOf(page))], english(), catalogues().de)).toEqual([])
    const engine = await engines(page)

    await page.locator('.wordmark').click()
    await expect(page).toHaveURL(`${origin}/`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
    await toSettings(page)
    await expect(select(page)).toHaveValue('fr')
    expect(await engines(page), 'the same engine').toEqual(engine)

    await page.goto(`${watchPage(PACK)}&language=ja`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
    await page.goto(`${watchPage(PACK)}&language=sw`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
  })

  // a Mexican Spanish browser, so Automatic names the longest language each time
  for (const language of ['en', ...Object.keys(catalogues())]) {
    test(`${language} at 390 px: Settings and its select fit, the select's text whole, and the footer fits from 320 px with Speed and its two limits on one line`, async ({ page }) => {
      await page.addInitScript(() => Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es'] }))
      await opening(page, language)
      await page.goto(origin)
      await library(page, LIST, TORRENTS)
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 })
        await drawn(page)
        expect(await cutOff(page, 'footer'), `${width} px`).toEqual([])
        // each part's middle, and for a limit whether its text keeps to one line inside it: a second line of text is
        // over 2em, one is under 1.8em in any of these fonts
        const parts = await page.locator('footer .folder > *').evaluateAll(shown => shown.map((part) => {
          const box = part.getBoundingClientRect()
          const style = getComputedStyle(part)
          const text = box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)
          return { middle: box.top + box.height / 2, oneLine: text < 1.8 * parseFloat(style.fontSize) }
        }))
        expect(parts.length, `${width} px: the control, Speed and both limits were read`).toBe(3)
        expect(parts.every(part => Math.abs(part.middle - parts[0]!.middle) < 2), `${width} px: Speed and its two limits on one line`).toBe(true)
        expect(parts.every(part => part.oneLine), `${width} px: each limit's text on one line`).toBe(true)
      }
      // with no limit set, or a bigger text size, two limits can leave Speed no room beside them (Russian's two
      // Unlimited at 320 px): the up limit may take a second line, but nothing leaves the window or the footer's
      // padding, and Speed keeps at least a letter and its ellipsis
      for (const rateLimits of [{ down: 5_000_000, up: 0 }, { down: 0, up: 0 }]) {
        await post(page, { type: 'state', torrents: TORRENTS, rateLimits, ...READOUTS[0] })
        for (const size of ['100%', '125%']) {
          await page.evaluate((size) => { document.documentElement.style.fontSize = size }, size)
          for (const width of [320, 390]) {
            await page.setViewportSize({ width, height: 844 })
            await drawn(page)
            const at = `${width} px, ${rateLimits.down ? 'a limit' : 'no limit'} set, text at ${size}`
            expect(await cutOff(page, 'footer'), at).toEqual([])
            expect(await page.locator('footer').evaluate((footer) => {
              const speed = footer.querySelector<HTMLElement>('.folder > span')!
              const pen = document.createElement('canvas').getContext('2d')!
              pen.font = getComputedStyle(speed).font
              const end = footer.getBoundingClientRect().right - parseFloat(getComputedStyle(footer).paddingRight)
              return {
                speed: speed.clientWidth + 1 >= Math.min(speed.scrollWidth, pen.measureText(`${speed.textContent.slice(0, 1)}…`).width),
                inside: [...footer.querySelectorAll('.folder > *')].every(part => part.getBoundingClientRect().right <= end + 0.5),
              }
            }), at).toEqual({ speed: true, inside: true })
          }
        }
      }
      await page.evaluate(() => { document.documentElement.style.fontSize = '' })
      await toSettings(page)
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      await expect(select(page).locator('option').first()).toContainText('Español latinoamericano')
      expect(await cutOff(page)).toEqual([])
      const fit = await select(page).evaluate((shown: HTMLSelectElement) => {
        const style = getComputedStyle(shown)
        const pen = document.createElement('canvas').getContext('2d')!
        pen.font = style.font
        const box = shown.getBoundingClientRect()
        return {
          inside: box.left >= 0 && box.right <= document.documentElement.clientWidth,
          room: shown.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          widest: Math.max(...[...shown.options].map(option => pen.measureText(option.text).width)),
        }
      })
      expect(fit.inside).toBe(true)
      expect(fit.room, 'the widest option has room').toBeGreaterThanOrEqual(fit.widest)
    })
  }
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

// spacing breaks the line a Devanagari word's letters hang from, as it pulls Arabic's joined letters apart
test.describe('a heading in Hindi keeps its letters together', () => {
  for (const language of ['hi', 'en']) {
    test(language, async ({ page }) => {
      await opening(page, language)
      await page.goto(origin)
      await library(page, LIST, TORRENTS)
      await page.locator('.list-toolbar .chip.show').click()
      const spacing = await page.getByRole('menu').locator('.group > label').first().evaluate(label => getComputedStyle(label).letterSpacing)
      expect(spacing === 'normal', `the menu's heading spaced ${spacing}`).toBe(language === 'hi')
    })
  }
})

// wider than a 320 px window in any font
const LONG_ACCOUNT = { name: 'Alexandra Maximiliane Konstantinopoulou-Lindqvist', premium: false }

/**
 * The header's shown items, how many rows they sit on by their middles, its height, and how far the page scrolls
 * sideways. An item the unfolded field covers is drawn with no opacity, and is not shown.
 */
const headerRows = (page: Page) => page.locator('header').evaluate((header) => {
  const shown = [...header.children].filter(kid => getComputedStyle(kid).opacity !== '0')
    .map(kid => kid.getBoundingClientRect()).filter(box => box.width > 0)
  const middles = shown.map(box => box.top + box.height / 2)
  return {
    items: shown.length,
    rows: Math.max(...middles) - Math.min(...middles) > 12 ? 2 : 1,
    height: Math.round(header.getBoundingClientRect().height),
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})

/** The rows the strip's readouts sit on, by their boxes, and how many it shows. */
const stripRows = (page: Page) => page.locator('.stats').evaluate((strip) => {
  const boxes = [...strip.querySelectorAll('.stat')].map(stat => stat.getBoundingClientRect())
    .filter(box => box.width > 0).sort((a, b) => a.top - b.top)
  let rows = 0
  let bottom = -Infinity
  for (const box of boxes) {
    if (box.top >= bottom - 2) {
      rows++
      bottom = box.bottom
    } else bottom = Math.max(bottom, box.bottom)
  }
  return { rows, readouts: boxes.length, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }
})

test.describe('the header', () => {
  const field = (page: Page) => page.locator('header form input:not([type=file])')

  for (const language of ['en', ...Object.keys(catalogues())]) {
    test(`${language}: one row from 320 to 700 px and at 1280, signed in or out, the add field folded, unfolded and holding a search`, async ({ page }) => {
      test.setTimeout(120_000)
      await opening(page, language)
      await page.goto(origin)
      for (const account of ['out', LONG_ACCOUNT] as const) {
        await signIn(page, null, null, account)
        await library(page, LIST, TORRENTS)
        await expect(page.locator(account === 'out' ? 'header iframe' : 'header .account-tag'), 'the control: the account is in the header').toBeVisible()
        for (const width of [320, 360, 390, 519, 520, 700, 1280]) {
          const at = `${typeof account === 'string' ? 'signed out' : 'signed in'} at ${width} px`
          const room = () => field(page).evaluate(input => input.getBoundingClientRect().width)
          const open = () => page.locator('header form').evaluate(form => form.getBoundingClientRect().width)
          await page.setViewportSize({ width, height: 844 })
          await drawn(page)
          const folded = await headerRows(page)
          expect(folded.items, `${at}: the control, the logo, the field, Create, the gear and the account were read`).toBe(5)
          expect(folded.rows, `${at}, ${folded.height} px tall`).toBe(1)
          expect(folded.sideways, at).toBe(0)
          // folded to its glyph as wide a target as the buttons beside it; from 520 px open, at its floor or wider
          if (width < 520) expect(await room(), `${at}: the field is folded to its glyph`).toBe(30)
          else expect(await open(), `${at}: the field is open`).toBeGreaterThanOrEqual(240)
          // the file and + buttons beside the field, Create and the gear on its row, whole in the window
          for (const control of ['header .file-button', 'header button.go', 'header button.create', 'header a.settings']) {
            const box = (await page.locator(control).boundingBox())!
            expect(box.x >= 0 && box.x + box.width <= width && box.width > 0, `${at}: ${control} at ${box.x}+${box.width}`).toBe(true)
          }

          await field(page).fill('Release')
          await drawn(page)
          const unfolded = await headerRows(page)
          expect(unfolded.rows, `${at}, unfolded`).toBe(1)
          expect(unfolded.height, `${at}: unfolding moves nothing under the header`).toBe(folded.height)
          expect(unfolded.sideways, `${at}, unfolded`).toBe(0)
          if (width < 520) expect(await room(), `${at}: the unfolded field has room for what it holds`).toBeGreaterThanOrEqual(120)
          else expect(await open(), `${at}: the field holding a search keeps its floor`).toBeGreaterThanOrEqual(240)

          await field(page).blur()
          await drawn(page)
          const held = await headerRows(page)
          expect(held.items, `${at}, holding a search: the row is back`).toBe(5)
          expect(held.rows, `${at}, holding a search`).toBe(1)
          expect(held.height, `${at}, holding a search`).toBe(folded.height)
          expect(held.sideways, `${at}, holding a search`).toBe(0)
          if (width < 520) expect(await room(), `${at}: a search held folds with the focus elsewhere`).toBe(30)
          await field(page).fill('')
          await field(page).blur()
        }
      }
    })
  }

  test('on a phone the folded field opens to a press, takes a paste and the keyboard, narrows the list, and hands the row back', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 })
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    const gear = page.locator('header a.settings')
    await expect(gear).toHaveCSS('opacity', '1')
    await field(page).click()
    await expect(field(page)).toBeFocused()
    await expect(gear, 'the unfolded field covers the gear').toHaveCSS('opacity', '0')

    await page.keyboard.type('season')
    await expect(page.locator('.torrent .title')).toHaveText(['A.Season.Pack'])
    await page.keyboard.press('Escape')
    await expect(field(page)).toHaveValue('')
    await expect(page.locator('.torrent')).toHaveCount(LIST.length)

    const sent = await sending(page, ['add-magnet'])
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
    await page.evaluate(magnet => navigator.clipboard.writeText(magnet), magnetOf('7', 'Seven'))
    await page.keyboard.press('ControlOrMeta+V')
    await expect(field(page)).toHaveValue(magnetOf('7', 'Seven'))
    await page.locator('header button.go').click()
    await expect(field(page)).toHaveValue('')
    expect((await sent()).map(({ magnet }) => magnet)).toEqual([magnetOf('7', 'Seven')])

    // past the file picker, the next stop is Create, and the field folds to give it back its row
    await field(page).focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await expect(page.locator('header button.create')).toBeFocused()
    await expect(page.locator('header button.create')).toHaveCSS('opacity', '1')
    expect(await field(page).evaluate(input => input.getBoundingClientRect().width)).toBe(30)
  })

  test('on a phone a search folds once a press lands elsewhere, marked on the glyph, and the row can be pressed again', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    const gear = page.locator('header a.settings')
    const marked = () => page.locator('header .field').evaluate(shown => getComputedStyle(shown, '::after').content !== 'none')
    await field(page).click()
    await page.keyboard.type('season')
    await expect(page.locator('.torrent .title')).toHaveText(['A.Season.Pack'])
    await expect(gear, 'the control: the unfolded field covers the gear').toHaveCSS('opacity', '0')
    expect(await marked(), 'the control: no mark while the field is open').toBe(false)

    // a press on the strip's edge, which takes no focus, as a thumb putting the keyboard away
    await page.locator('.stats').click({ position: { x: 3, y: 3 } })
    await expect(field(page)).not.toBeFocused()
    await expect(gear).toHaveCSS('opacity', '1')
    expect(await field(page).evaluate(input => input.getBoundingClientRect().width), 'folded').toBe(30)
    expect(await marked(), 'the search is marked').toBe(true)
    await expect(page.locator('header .clear')).toBeHidden()
    await expect(page.locator('.torrent .title'), 'the search still narrows the list').toHaveText(['A.Season.Pack'])
    await gear.click()
    await expect(page).toHaveURL(`${origin}/settings`)
  })

  test('the logo is the way home, named Ripple', async ({ page }) => {
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    const home = page.getByRole('link', { name: 'Ripple', exact: true })
    await expect(home).toHaveAttribute('href', '/')
    await expect(home.locator('img')).toHaveJSProperty('complete', true)
    expect(await home.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth), 'the logo is drawn').toBeGreaterThan(0)
    await expect(page.locator('header')).not.toContainText('Ripple')
  })

  test('Open torrents with Ripple is on Settings alone, at every width', async ({ page }) => {
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    const install = page.getByRole('button', { name: 'Open torrents with Ripple' })
    for (const width of [1440, 1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(install, `${width} px`).toHaveCount(0)
    }
    await toSettings(page)
    await expect(install).toBeVisible()
  })

  test('in the installed app the gear still shows, and Settings still offers Open torrents with Ripple', async ({ page }) => {
    await page.addInitScript(() => {
      const own = window.matchMedia.bind(window)
      window.matchMedia = (query) => {
        const list = own(query)
        if (query.includes('display-mode: standalone')) Object.defineProperty(list, 'matches', { value: true })
        return list
      }
    })
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    expect(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches), 'the control: the page runs as the installed app').toBe(true)
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(page.locator('header a.settings'), `${width} px`).toBeVisible()
    }
    await toSettings(page)
    await expect(page.getByRole('button', { name: 'Open torrents with Ripple' })).toBeVisible()
  })
})

/*
 * Arabic and Hebrew mirror the page: what starts a row starts it on the right. English is the control, each check
 * finding the opposite side there. A name keeps its own direction and shows its start when it is cut, the player keeps
 * time running left to right, and of the icons only those that point along the line turn.
 */
test.describe('right to left', () => {
  type Box = { left: number, right: number, mid: number }
  const boxOf = (locator: Locator): Promise<Box> => locator.evaluate((element) => {
    const { left, right } = element.getBoundingClientRect()
    return { left, right, mid: (left + right) / 2 }
  })
  // the icon's own turn, which only the rule mirroring the ones that point along the line sets
  const turned = (locator: Locator) => locator.evaluate(icon => getComputedStyle(icon).scale === '-1 1')
  /** The side a gradient fades towards, as drawn: a gradient names no logical side. */
  const towards = (locator: Locator, pseudo?: string) => locator.evaluate((element, pseudo) =>
    getComputedStyle(element, pseudo).backgroundImage.match(/^linear-gradient\(to (\w+)/)?.[1], pseudo)
  /** The half of its track a switch's knob is in, along the line. */
  const knob = (track: Locator) => track.evaluate((element) => {
    const { left, width } = getComputedStyle(element, '::after')
    const leftHalf = parseFloat(left) + parseFloat(width) / 2 < element.clientWidth / 2
    return leftHalf === (getComputedStyle(element).direction === 'rtl') ? 'end' : 'start'
  })

  // names somebody wrote, each opening or closing on a bracket, a dot or a slash, which have no direction of their own
  const RELEASE = '[Group] Orbital Gardeners Season Two - 01 (1080p) [ABCD1234]'
  const PEER_ADDRESS = '[2001:db8::7]:51413'
  const PEER_CLIENT = '[XX] Unknown 0.1'
  const TRACKER = 'http://bt.example.org:2710/'
  const TRACKER_SAYS = 'Unregistered torrent.'
  const GROUP = '[Fansub] Picks (2024)'
  const ACCOUNT_NAME = '[Team] A person'
  const SAVE_FOLDER = '[Media] Downloads'
  const SKIPPED = '.DS_Store'
  const NAMED_MAGNET = magnetOf('a', encodeURIComponent(RELEASE))
  const NAMED_LIST = [entry('a', RELEASE, { magnet: NAMED_MAGNET })]
  const NAMED = snapshot(1, 'a', RELEASE, { numPeers: 28 }, {
    magnet: NAMED_MAGNET,
    files: { files: [{ path: `${RELEASE}/${RELEASE}.mkv`, size: 2 * GB }, { path: `${RELEASE}/${RELEASE}.srt`, size: 40_000 }], contentSize: 2 * GB + 40_000, pieceLength: 16_384 },
  })

  /**
   * Each of `typed` drawn inside `locator`, and how any is drawn out of its own order: a right to left line carries a
   * bracket, a dot or a slash at a name's end to its other side, and shows a cut Latin name's end rather than its start.
   * An input holding one is read by its direction.
   */
  const order = (locator: Locator, typed: string[]) => locator.evaluate((root, typed) => {
    const found: string[] = []
    const wrong: string[] = []
    const at = (node: Text, i: number) => {
      const range = document.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      return range.getBoundingClientRect()
    }
    const sameLine = (a: DOMRect, b: DOMRect) => Math.abs(a.top - b.top) < a.height / 2
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      for (const name of typed) {
        const i = node.data.indexOf(name)
        if (i < 0) continue
        const first = at(node, i)
        const second = at(node, i + 1)
        const beforeLast = at(node, i + name.length - 2)
        const last = at(node, i + name.length - 1)
        if (!first.width) continue
        found.push(name)
        if (sameLine(first, second) && first.left > second.left) wrong.push(`${name}: its first character after its second`)
        if (sameLine(beforeLast, last) && last.left < beforeLast.left) wrong.push(`${name}: its last character before the one ahead of it`)
        let clip = node.parentElement
        while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement
        const box = clip?.getBoundingClientRect() ?? { left: 0, right: document.documentElement.clientWidth }
        if (first.left < box.left - 1 || first.right > box.right + 1) wrong.push(`${name}: its start cut off`)
      }
    }
    for (const input of root.matches('input') ? [root] : [...root.querySelectorAll('input')]) {
      const name = typed.find(each => input.value.includes(each))
      if (!name) continue
      found.push(name)
      if (getComputedStyle(input).direction !== 'ltr') wrong.push(`${name}: typed right to left`)
    }
    return { found, wrong }
  }, typed)
  const expectInOrder = async (locator: Locator, typed: string[], what: string) => {
    const { found, wrong } = await order(locator, typed)
    expect(typed.filter(name => !found.includes(name)), `${what}: the control, each name is drawn`).toEqual([])
    expect(wrong, what).toEqual([])
  }
  /** Whether the colon written before `port` inside `locator` is drawn left of its first digit, or null with no such port. */
  const colonFirst = (locator: Locator, port: string) => locator.evaluate((root, port) => {
    const shown: { node: Text, i: number }[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      for (let i = 0; i < node.data.length; i++) if (!/[\u2066-\u2069]/.test(node.data[i]!)) shown.push({ node, i })
    }
    const at = shown.map(({ node, i }) => node.data[i]).join('').lastIndexOf(`:${port}`)
    const left = ({ node, i }: { node: Text, i: number }) => {
      const range = document.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      return range.getBoundingClientRect().left
    }
    return at < 0 ? null : left(shown[at]!) < left(shown[at + 1]!)
  }, port)
  /** The offset in its value the caret lands on every 4 px across an input, from 2 px inside its left edge to 2 px inside its right. */
  const caretsAcross = (input: Locator) => input.evaluate((field: HTMLInputElement) => {
    const { left, right, top, height } = field.getBoundingClientRect()
    const across = Array.from({ length: Math.ceil((right - left - 4) / 4) }, (_, k) => left + 2 + 4 * k).concat(right - 2)
    return across.map((x) => {
      const caret = document.caretPositionFromPoint(x, top + height / 2)
      if (caret?.offsetNode !== field) throw new Error(`the caret at ${x} px lands on ${caret?.offsetNode.nodeName}, not the field`)
      return caret.offset
    })
  })

  for (const language of ['ar', 'he', 'en']) {
    const rtl = language !== 'en'
    /** Whether `a` comes before `b` along the line: right of it right to left, left of it otherwise. */
    const before = (a: Box, b: Box) => (rtl ? a.mid > b.mid : a.mid < b.mid)

    test(`${language}: the header, a row, the toolbar, the menus and the details panel ${rtl ? 'mirror' : 'keep their sides'}, at 1280 and 390 px`, async ({ page }) => {
      test.setTimeout(120_000)
      await opening(page, language)
      await page.goto(origin)
      await library(page, LIST, TORRENTS)
      expect(await page.locator('html').getAttribute('dir')).toBe(rtl ? 'rtl' : null)
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await drawn(page)
        const at = `${width} px`
        expect(before(await boxOf(page.locator('header .brand')), await boxOf(page.locator('header a.settings'))), `${at}: the logo starts the header`).toBe(true)
        const row = page.locator('.torrent', { hasText: 'Elsewhere' })
        expect(before(await boxOf(row.locator('> .row-check')), await boxOf(row.locator('.content'))), `${at}: a row's box starts it`).toBe(true)
        expect(before(await boxOf(page.locator('.list-toolbar .chip.show')), await boxOf(page.locator('.list-toolbar .views'))), `${at}: the filter starts the toolbar`).toBe(true)
        // a Latin name reads left to right and sits at its row's start
        const name = row.locator('.title strong')
        expect(await name.evaluate(element => getComputedStyle(element).direction), at).toBe('ltr')
        const words = await name.evaluate((element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          const { left, right } = range.getBoundingClientRect()
          return { left, right, mid: (left + right) / 2 }
        })
        const own = await boxOf(name)
        expect(Math.abs((rtl ? own.right - words.right : words.left - own.left)), `${at}: the name at its row's start`).toBeLessThan(1)
      }

      // a menu under a control hangs from the control's start, and one at the pointer opens away from the line's end
      await page.setViewportSize({ width: 1280, height: 900 })
      const chip = page.locator('.list-toolbar .chip.show')
      await chip.click()
      const menu = page.getByRole('menu')
      await expect(menu).toBeVisible()
      const [chipBox, under] = [await boxOf(chip), await boxOf(menu)]
      expect(Math.abs(rtl ? chipBox.right - under.right : chipBox.left - under.left), 'the Show menu hangs from its chip\'s start').toBeLessThan(1)
      // spacing would pull Arabic's joined letters apart, and Hebrew's are not joined
      const spacing = await menu.locator('.group > label').first().evaluate(label => getComputedStyle(label).letterSpacing)
      expect(spacing === 'normal', `the menu's heading spaced ${spacing}`).toBe(language === 'ar')
      await page.keyboard.press('Escape')
      const row = page.locator('.torrent', { hasText: 'Elsewhere' })
      // a menu closes when the list under it scrolls, as a click's own scroll to its row would
      await row.scrollIntoViewIfNeeded()
      await drawn(page)
      const point = await boxOf(row)
      await row.click({ button: 'right', position: { x: (point.right - point.left) / 2, y: 20 } })
      await expect(menu).toBeVisible()
      const pointed = await boxOf(menu)
      const x = point.mid
      // within the pixel the pointer lands on
      expect(Math.abs(rtl ? pointed.right - x : pointed.left - x), 'the row\'s menu opens away from the pointer towards the line\'s end').toBeLessThanOrEqual(1)
      await page.keyboard.press('Escape')

      // the details panel: its first tab starts the row of tabs
      await row.click()
      const tabs = page.locator('main + section .tabs button')
      await expect(tabs.first()).toBeVisible()
      expect(before(await boxOf(tabs.nth(0)), await boxOf(tabs.nth(1))), 'the first tab starts the details panel').toBe(true)

      // an icon that points along the line turns, Play does not
      await expect(page.locator('.torrent .lucide-play').first()).toBeVisible()
      expect(await turned(page.locator('.torrent .lucide-play').first()), 'Play').toBe(false)
      expect(await turned(page.locator('.list-toolbar .views .lucide-list')), 'the list view').toBe(rtl)
      // the sort's arrow each way, the key already sorted by flipping it
      const sort = page.locator('.list-toolbar .chip.sort')
      const arrows: string[] = []
      for (const flip of [false, true]) {
        if (flip) {
          await sort.click()
          await menu.locator('[aria-checked=true]').click()
        }
        const arrow = sort.locator('svg').first()
        arrows.push((await arrow.getAttribute('class'))!.split(' ').find(name => name.startsWith('lucide-arrow'))!)
        expect(await turned(arrow), `the sort's ${arrows.at(-1)}`).toBe(rtl)
      }
      expect(arrows.sort(), 'the control: both of the sort\'s arrows').toEqual(['lucide-arrow-down-wide-narrow', 'lucide-arrow-up-narrow-wide'])
      // a gradient has no logical side, so a group's band fades towards the line's end
      expect(await towards(page.locator('.group-head').first()), 'a group\'s band').toBe(rtl ? 'left' : 'right')
      await toSettings(page)
      expect(await turned(page.locator('header a.back svg')), 'the way back').toBe(rtl)

      // the legal pages are in English on any page, so they read left to right
      await page.goto(`${origin}/privacy`)
      expect(await page.locator('p').first().evaluate(paragraph => getComputedStyle(paragraph).direction), 'the privacy page').toBe('ltr')
    })

    test(`${language}: a name cut short shows its start and ends in an ellipsis, in the table at 390 px`, async ({ page }) => {
      await opening(page, language)
      await page.addInitScript(key => localStorage.setItem(key, 'table'), LIST_VIEW_KEY)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(origin)
      await library(page, LIST, TORRENTS)
      const cut = await page.locator('.torrent-table .title').evaluateAll(titles => titles
        .filter(title => title.scrollWidth > title.clientWidth + 1)
        .map((title) => {
          const range = document.createRange()
          range.setStart(title.firstChild!, 0)
          range.setEnd(title.firstChild!, 1)
          return { name: title.textContent, gap: range.getBoundingClientRect().left - title.getBoundingClientRect().left, ellipsis: getComputedStyle(title).textOverflow }
        }))
      expect(cut.length, 'the control: a name is cut').toBeGreaterThan(0)
      expect(cut.filter(({ gap, ellipsis }) => Math.abs(gap) > 1 || ellipsis !== 'ellipsis')).toEqual([])
    })

    test(`${language}: the stats strip's line scrolls from its start, its fades on the side they cover, on a phone`, async ({ page }) => {
      await opening(page, language)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(origin)
      await signIn(page, THROTTLED, SYNCED)
      await page.evaluate(() => localStorage.removeItem('ripple:quota-offer'))
      await page.goto(origin)
      await library(page, LIST, TORRENTS)
      const fades = page.locator('.stats .fades').last()
      await expect(fades, 'the control: the line runs past its end').toHaveAttribute('data-more-end')
      await expect(fades).not.toHaveAttribute('data-more-start')
      const side = (pseudo: string) => fades.evaluate((element, pseudo) => getComputedStyle(element, pseudo)[getComputedStyle(element).direction === 'rtl' ? 'right' : 'left'], pseudo)
      expect(await side('::before'), 'the start\'s fade at the start').toBe('0px')
      expect(await towards(fades, '::before'), 'the start\'s fade clears towards the end').toBe(rtl ? 'left' : 'right')
      expect(await towards(fades, '::after'), 'the end\'s fade clears towards the start').toBe(rtl ? 'right' : 'left')
      await fades.locator('.line').evaluate((line) => { line.scrollLeft = (getComputedStyle(line).direction === 'rtl' ? -1 : 1) * line.scrollWidth })
      await expect(fades).toHaveAttribute('data-more-start')
      await expect(fades).not.toHaveAttribute('data-more-end')
    })

    test(`${language}: the player keeps left to right, its top row ${rtl ? 'mirrored' : 'as it is'}`, async ({ page }) => {
      await opening(page, language)
      await page.setViewportSize({ width: 1280, height: 844 })
      await page.goto(watchPage(PACK))
      await library(page, PACK_LIST, [PLAYING], READOUTS[0])
      await expect(page.getByTestId('peers')).toContainText('28')
      const play = await boxOf(page.locator('button.play').first())
      expect(play.mid, 'Play on the left').toBeLessThan(640)
      expect(before(await boxOf(page.locator('.ripple-overlay-content .file-name')), await boxOf(page.getByTestId('peers'))), 'the file\'s name starts the top row').toBe(true)
      expect(await turned(page.locator('[data-testid=open-in-ripple] svg')), 'the link out').toBe(rtl)
    })

    test(`${language}: a name somebody wrote keeps its own order in the table, its menus, the share dialog and the details, at 390 px`, async ({ page }) => {
      test.setTimeout(120_000)
      await opening(page, language)
      await page.addInitScript(key => localStorage.setItem(key, 'table'), LIST_VIEW_KEY)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(origin)
      await library(page, NAMED_LIST, [NAMED])
      const row = page.locator('.torrent-table tbody tr').first()
      const menu = page.getByRole('menu')
      const dialog = page.getByRole('dialog')
      const chip = page.locator('[role=tooltip]')
      const hinted = async (anchor: Locator, name: string, what: string) => {
        await anchor.hover()
        await expect(chip).toContainText(name)
        await expectInOrder(chip, [name], what)
        await page.mouse.move(0, 0)
      }
      await expectInOrder(row.locator('.title'), [RELEASE], 'the table\'s name')
      await hinted(row.locator('td.name'), RELEASE, 'the hint on the table\'s name')

      // a group, which the bar's menu, the row's menu and the options each list by its name
      await page.locator('.list-toolbar .pick-all input').check()
      await groupTicked(page, GROUP)
      await page.locator('.bulk-bar button[aria-haspopup=menu]').click()
      await expectInOrder(menu, [GROUP], 'the bar\'s Groups menu')
      await page.keyboard.press('Escape')
      await page.locator('.list-toolbar .pick-all input').uncheck()
      await row.click({ button: 'right' })
      await expect(menu).toBeVisible()
      await expectInOrder(menu, [GROUP], 'the row\'s menu')
      await page.keyboard.press('Escape')
      await row.locator('button.more').click()
      await expect(dialog).toBeVisible()
      await expectInOrder(dialog, [GROUP], 'the options')
      // the knob's place is the switch's state, at the track's end when on
      const on: boolean[] = []
      for (const each of await dialog.locator('[role=switch]').all()) {
        on.push(await each.getAttribute('aria-checked') === 'true')
        expect(await knob(each.locator('.switch')), `a switch ${on.at(-1) ? 'on' : 'off'}`).toBe(on.at(-1) ? 'end' : 'start')
      }
      expect([on.includes(false), on.includes(true)], 'the control: a switch on and one off').toEqual([true, true])
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)

      // the share dialog: the name and its files, and the link and the frame, which read left to right in any language
      await row.click({ button: 'right' })
      await menu.getByText(language === 'en' ? 'Get a share link' : catalogues()[language]!['Get a share link']!).click()
      await expect(dialog.locator('.subject')).toBeVisible()
      await expectInOrder(dialog.locator('.subject'), [RELEASE], 'the share dialog\'s name')
      await dialog.locator('details.files summary').click()
      await expectInOrder(dialog.locator('details.files'), [RELEASE], 'the share dialog\'s files')
      const link = dialog.getByTestId('embed-url')
      await expectInOrder(link, [(await link.textContent())!], 'the share link')
      await dialog.locator('details.snippet summary').click()
      const frame = dialog.getByTestId('embed-iframe')
      await expectInOrder(frame, [(await frame.textContent())!], 'the frame to embed')
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)

      // the details panel: its name, cut short here, its files, a peer and a tracker
      await row.click()
      const dock = page.locator('main + section')
      const tab = (i: number) => dock.locator('.tabs button').nth(i)
      const title = dock.locator('header .title')
      await expect(title).toBeVisible()
      expect(await title.evaluate(element => element.scrollWidth > element.clientWidth), 'the control: the name is cut').toBe(true)
      await expectInOrder(title, [RELEASE], 'the details\' name')
      await hinted(title, RELEASE, 'the hint on the details\' name')
      await tab(1).click()
      await expect(dock.locator('.row.file')).toHaveCount(2)
      await expectInOrder(dock.locator('.row.file').first(), [RELEASE], 'a file\'s path')
      await tab(2).click()
      const peer = { ...SWARM_PEER, endpoint: PEER_ADDRESS, client: PEER_CLIENT }
      const tracker = { ...SWARM_TRACKER, url: TRACKER, tier: 0, message: TRACKER_SAYS }
      await post(page, { type: 'state', torrents: [NAMED], detail: { handle: NAMED.handle, peers: [peer], trackers: [tracker] } })
      const swarm = dock.locator('.rows .row:not(.head)')
      await expect(swarm).toHaveCount(1)
      await expectInOrder(swarm, [PEER_ADDRESS], 'a peer\'s address')
      await tab(3).click()
      await expect(swarm.locator('.name')).toContainText(TRACKER)
      await expectInOrder(swarm, [TRACKER], 'a tracker, its address wrapped')
      // a phone shows no peer's client and no tracker's state
      await page.setViewportSize({ width: 1280, height: 844 })
      await expectInOrder(swarm, [TRACKER], 'a tracker')
      await hinted(swarm.locator('.name'), TRACKER, 'the hint on a tracker')
      await hinted(swarm.locator('.client'), TRACKER_SAYS, 'the hint on what a tracker said')
      await tab(2).click()
      await expect(swarm.locator('.client')).toBeVisible()
      await expectInOrder(swarm, [PEER_ADDRESS, PEER_CLIENT], 'a peer')
      await hinted(swarm.locator('.client'), PEER_CLIENT, 'the hint on a peer\'s client')
    })

    test(`${language}: a name somebody wrote keeps its own order in the account, Settings, the add and create dialogs, the download page and the player`, async ({ page }) => {
      test.setTimeout(120_000)
      await opening(page, language)
      await page.addInitScript((folder) => { localStorage.setItem('spec:folder', folder); localStorage.setItem('ripple:add-dialog', '1') }, SAVE_FOLDER)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(origin)
      await signIn(page, null, null, { name: ACCOUNT_NAME, premium: false })
      await library(page, NAMED_LIST, [NAMED])
      await expectInOrder(page.locator('.account-tag'), [ACCOUNT_NAME], 'the account\'s name')
      await page.locator('.account-tag').click()
      const menu = page.getByRole('menu')
      await expect(menu).toBeVisible()
      expect(await turned(menu.locator('.lucide-log-out')), 'the way out').toBe(rtl)
      await page.keyboard.press('Escape')

      await toSettings(page)
      const autoSave = page.locator('main .folder').last()
      await autoSave.getByRole('button').first().click()
      await expect(autoSave.getByRole('button')).toHaveCount(3)
      await expectInOrder(autoSave, [SAVE_FOLDER], 'the folder on Settings')
      await toLibrary(page)

      // the add dialog: the name, its files and the folder they can go to
      const added = magnetOf('b', encodeURIComponent(RELEASE))
      const field = page.locator('header form input:not([type=file])')
      await field.fill(added)
      await field.press('Enter')
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await post(page, { type: 'list', list: [...NAMED_LIST, entry('b', RELEASE, { magnet: added, ephemeral: true })] }, { type: 'state', torrents: [NAMED, { ...NAMED, handle: 2, magnet: added }] })
      await expect(dialog.locator('.file')).toHaveCount(2)
      await expectInOrder(dialog.locator('h2'), [RELEASE], 'the add dialog\'s name')
      await expectInOrder(dialog.locator('.file').first(), [RELEASE], 'a file in the add dialog')
      await expectInOrder(dialog.locator('label.check', { hasText: SAVE_FOLDER }), [SAVE_FOLDER], 'the folder in the add dialog')
      await dialog.locator('footer button:not(.primary)').click()
      await expect(dialog).toHaveCount(0)

      // the create dialog: a file it leaves out, and the name somebody gives the torrent
      await folderToShare(page, true)
      await page.locator('header button.create').click()
      await dialog.locator('button.go').click()
      await expect(dialog.locator('.facts')).toBeVisible()
      for (const summary of await dialog.locator('details summary').all()) await summary.click()
      await expectInOrder(dialog.locator('.skipped'), [SKIPPED], 'a file left out')
      const named = dialog.locator('label.field input').first()
      await named.fill(RELEASE)
      await expectInOrder(named, [RELEASE], 'the new torrent\'s name')

      await page.goto(downloadPage(NAMED_MAGNET))
      await library(page, NAMED_LIST, [NAMED])
      await expect(page.locator('.card .file')).toHaveCount(2)
      await expectInOrder(page.locator('.card .about .name'), [RELEASE], 'the download page\'s name')
      await expectInOrder(page.locator('.card .file').first(), [RELEASE], 'a file on the download page')

      // the player's file name, cut short on a phone
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(watchPage(NAMED_MAGNET))
      await library(page, NAMED_LIST, [NAMED])
      await expect(page.getByTestId('peers')).toContainText('28')
      const file = page.locator('.ripple-overlay-content .file-name')
      expect(await file.evaluate(element => element.scrollWidth > element.clientWidth), 'the control: the file\'s name is cut').toBe(true)
      await expectInOrder(file, [RELEASE], 'the player\'s file')
    })

    test(`${language}: a port's colon is drawn before its digits, in the stats strip and a peer's address`, async ({ page }) => {
      await opening(page, language)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(origin)
      await library(page, NAMED_LIST, [NAMED])
      const inbound = page.locator('.stats .stat.inbound strong')
      // with someone connected in, with nobody, closed, and reconnecting
      for (const readout of [READOUTS[0]!, READOUTS[2]!, READOUTS[3]!, READOUTS[4]!]) {
        await post(page, { type: 'state', torrents: [NAMED], ...readout })
        await drawn(page)
        expect(await colonFirst(inbound, '41337'), `the strip's ${await inbound.textContent()}`).toBe(true)
      }
      // an address with no letter in it to give it a direction
      await page.locator('.torrent').first().click()
      const dock = page.locator('main + section')
      await dock.locator('.tabs button').nth(2).click()
      const peers = ['203.0.113.7:51413', '[2001:2::8888]:6881']
      await post(page, { type: 'state', torrents: [NAMED], detail: { handle: NAMED.handle, peers: peers.map(endpoint => ({ ...SWARM_PEER, endpoint })), trackers: [] } })
      for (const [i, port] of ['51413', '6881'].entries()) {
        const row = dock.locator('.rows .row:not(.head)').nth(i)
        await expect(row).toContainText(peers[i]!)
        expect(await colonFirst(row, port), `the peer ${peers[i]}`).toBe(true)
      }
    })

    test(`${language}: what is typed in the add field takes its own direction, the empty field the page's`, async ({ page }) => {
      await opening(page, language)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(origin)
      await library(page, LIST, TORRENTS)
      const field = page.locator('header form input:not([type=file])')
      // its placeholder is in the page's words
      expect(await field.evaluate(input => getComputedStyle(input).direction), 'the empty field').toBe(rtl ? 'rtl' : 'ltr')
      await field.fill(magnetOf('3', 'Fresh'))
      await field.blur()
      const magnet = await caretsAcross(field)
      expect(magnet[0], 'a magnet link\'s first character is its leftmost').toBe(0)
      expect(magnet, 'and reads left to right').toEqual(magnet.toSorted((a, b) => a - b))
      await field.fill('بحث عربي')
      await field.blur()
      const arabic = await caretsAcross(field)
      expect(arabic.at(-1), 'Arabic\'s first character is its rightmost').toBe(0)
      expect(arabic, 'and reads right to left').toEqual(arabic.toSorted((a, b) => b - a))
    })

    test(`${language}: on a phone, what the unfolded add field holds runs clear of its glyph, in either direction`, async ({ page }) => {
      await opening(page, language)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(origin)
      await library(page, LIST, TORRENTS)
      const field = page.locator('header form input:not([type=file])')
      const glyph = page.locator('header .field .glyph')
      for (const typed of [magnetOf('3', 'Fresh'), 'بحث عربي']) {
        await field.click()
        await field.fill(typed)
        await drawn(page)
        const icon = (await glyph.boundingBox())!
        // a field draws its text inside its padding
        const text = await field.evaluate((input) => {
          const { left, right } = input.getBoundingClientRect()
          const { paddingLeft, paddingRight } = getComputedStyle(input)
          return { left: left + parseFloat(paddingLeft), right: right - parseFloat(paddingRight) }
        })
        const shape = `${typed.slice(0, 12)}: text from ${text.left} to ${text.right} px, the glyph from ${icon.x} to ${icon.x + icon.width} px`
        expect(icon.x >= text.right || icon.x + icon.width <= text.left, shape).toBe(true)
        await field.fill('')
        await field.blur()
      }
    })
  }
})

test.describe('the stats strip', () => {
  for (const language of ['en', ...Object.keys(catalogues())]) {
    test(`${language}: two rows at most from 320 to 1440 px, signed in with the quota and the sync, and signed out`, async ({ page }) => {
      test.setTimeout(90_000)
      await opening(page, language)
      await page.goto(origin)
      for (const [quota, sync, readouts] of [[THROTTLED, SYNCING, 7], [QUOTA_LEFT, SYNC_FAILED, 7], [null, null, 5]] as const) {
        if (quota) await signIn(page, quota, sync)
        else await signOut(page)
        await library(page, LIST, TORRENTS)
        for (const width of [320, 360, 390, 412, 701, 760, 820, 900, 1000, 1100, 1280, 1440]) {
          await page.setViewportSize({ width, height: 844 })
          await drawn(page)
          const strip = await stripRows(page)
          const at = `${width} px, ${quota ? `signed in, ${sync.status}` : 'signed out'}`
          // Inbound shows from 701 px
          expect(strip.readouts, `${at}: the control, the speeds, the VPN, storage${quota ? ', the quota and the sync' : ''} were read`).toBe(readouts + (width > 700 ? 1 : 0))
          expect(strip.rows, at).toBeLessThanOrEqual(2)
          expect(strip.sideways, at).toBe(0)
        }
      }
    })
  }

  test('en: no Active readout, and the VPN switch in its place after the speeds, starting the second row on a phone', async ({ page }) => {
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(page.locator('.stats label').first(), `${width} px: the control, the labels are read`).toHaveText('Download')
      await expect(page.locator('.stats label', { hasText: /^Active$/u }), `${width} px`).toHaveCount(0)
      if (width === 1280) {
        const order = await page.locator('.stats .stat').evaluateAll(stats => stats.map(stat => [stat.classList[1], Math.round(stat.getBoundingClientRect().left)] as const)
          .sort(([, a], [, b]) => a - b).map(([name]) => name))
        expect(order.slice(0, 5), 'one row, the switch after Peak down').toEqual(['big', 'rate', 'rate', 'vpn', 'inbound'])
      }
    }
    const vpn = (await page.locator('.stats .stat.vpn').boundingBox())!
    const download = (await page.locator('.stats .stat.big').boundingBox())!
    const storage = (await page.locator('.stats .stat.storage').boundingBox())!
    expect(vpn.y, 'below the speeds').toBeGreaterThan(download.y + download.height - 2)
    expect(vpn.x, 'first on its row').toBeLessThan(storage.x)
    expect(Math.abs(vpn.x - download.x), 'under Download').toBeLessThan(12)
  })

  test('en: the VPN\'s word takes its own width, with no room kept for a longer one before the next readout', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    const word = page.locator('.stats .stat.vpn strong')
    await expect(word, 'the control: the shortest word, so a room kept for Reconnecting would show').toHaveText('On')
    const spare = await word.evaluate((strong) => {
      const text = document.createRange()
      text.selectNodeContents(strong)
      return strong.getBoundingClientRect().width - text.getBoundingClientRect().width
    })
    expect(spare).toBeLessThan(1)
  })

  test('en: the strip, the toolbar and the cards share one left edge, on a phone and on a computer', async ({ page }) => {
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      await drawn(page)
      const lefts = await page.evaluate(() => ['.stats', '.list-toolbar', '.torrent'].map(shown => document.querySelector(shown)!.getBoundingClientRect().left))
      expect(lefts.every(left => Math.abs(left - lefts[0]!) < 1), `${width} px: ${lefts.join(', ')}`).toBe(true)
    }
  })

  test('en: on a phone the offer to switch the VPN off is drawn whole under a line that scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(origin)
    await signIn(page, THROTTLED, SYNCED)
    await page.evaluate(() => localStorage.removeItem('ripple:quota-offer'))
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    await expect(page.locator('.stats .fades').last(), 'the control: the line runs past its end').toHaveAttribute('data-more-end')
    const words = page.getByText('Your daily FKN quota is used up.')
    await expect(words).toBeVisible()
    // its pixels, and the same box with its words hidden: a box cut away by the line shows what is under it both times
    const box = (await words.boundingBox())!
    const drawnWords = await page.screenshot({ clip: box, animations: 'disabled' })
    await words.evaluate((line) => { line.style.visibility = 'hidden' })
    expect(drawnWords.equals(await page.screenshot({ clip: box, animations: 'disabled' })), 'the words reach the screen').toBe(false)
  })

  test('en: on a phone neither the strip nor a card draws its speed graph', async ({ page }) => {
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    await post(page, { type: 'state', torrents: TORRENTS, ...READOUTS[0] })
    for (const [width, shown] of [[1280, true], [390, false]] as const) {
      await page.setViewportSize({ width, height: 844 })
      await drawn(page)
      for (const graph of ['.stats svg.graph', '.torrent svg.spark']) {
        await expect(page.locator(graph), `${width} px: the control, ${graph} is drawn`).not.toHaveCount(0)
        await expect(page.locator(graph).first(), `${graph} at ${width} px`).toBeVisible({ visible: shown })
      }
    }
  })
})

test.describe('Settings', () => {
  test('the gear opens it with Language, On add, Storage and Auto-save, which the footer no longer has', async ({ page }) => {
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    await expect(page.locator('footer .folder > span')).toHaveText(['Speed'])
    await toSettings(page)
    await expect(page.locator('main .folder > span')).toHaveText(['Language', 'On add', 'Storage', 'Auto-save'])
    await expect(page.locator('main .folder', { hasText: 'Storage' }).getByRole('button')).toHaveText('Ask for more room')
  })

  test('an ask for more room refused in the library is not offered again on the way back from Settings', async ({ page }) => {
    await page.goto(origin)
    await answer(page, { low: true })
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    const room = page.locator('.storage-warning:not(.offline)')
    const ask = room.getByRole('button', { name: 'Ask for more room' })
    await ask.click()
    await expect(ask).toHaveCount(0)
    await expect(room.getByRole('button'), 'the control: the notice still offers its other way').toHaveCount(1)
    await toSettings(page)
    await expect(page.locator('main .folder', { hasText: 'Storage' })).toContainText('Not granted')
    await toLibrary(page)
    await expect(room.getByRole('button')).toHaveCount(1)
    await expect(ask).toHaveCount(0)
  })

  test('On add set there asks what to download in the library', async ({ page }) => {
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    await toSettings(page)
    const onAdd = page.locator('main .folder', { hasText: 'On add' }).getByRole('button')
    await expect(onAdd).toHaveText('Start straight away')
    await onAdd.click()
    await expect(onAdd).toHaveText('Ask what to download')
    await toLibrary(page)
    const field = page.locator('header form input:not([type=file])')
    await field.fill(FRESH)
    await field.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByRole('dialog').locator('footer button:not(.primary)').click()
    await toSettings(page)
    await onAdd.click()
    await expect(onAdd).toHaveText('Start straight away')
    await toLibrary(page)
    const sent = await sending(page, ['add-magnet'])
    await field.fill(magnetOf('7', 'Seven'))
    await field.press('Enter')
    await expect.poll(async () => (await sent()).length).toBe(1)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('a folder chosen there is the one the library saves to, and its default stays when it comes back', async ({ page }) => {
    await page.goto(origin)
    await library(page, LIST, TORRENTS)
    await toSettings(page)
    const autoSave = page.locator('main .folder', { hasText: 'Auto-save' }).getByRole('button')
    await autoSave.first().click()
    await expect(autoSave).toHaveText([FOLDER, 'Stop', 'Files stay in the browser'])
    await autoSave.last().click()
    await expect(autoSave.last()).toHaveText(`Files go to ${FOLDER}`)
    await toLibrary(page)
    await toSettings(page)
    await expect(autoSave).toHaveText([FOLDER, 'Stop', `Files go to ${FOLDER}`])
    await autoSave.nth(1).click()
    await expect(autoSave).toHaveText(['Choose folder'])
  })
})

/** A torrent's options lead to its share panel, from a card's ... and from a table row's. */
test.describe('Get a share link', () => {
  for (const view of ['cards', 'table']) {
    for (const width of [1280, 390]) {
      test(`opens the share panel for a torrent from ${view === 'cards' ? 'its card' : 'its table row'} at ${width} px`, async ({ page }) => {
        await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LIST_VIEW_KEY, view])
        await page.setViewportSize({ width, height: 844 })
        await page.goto(origin)
        await library(page, LIST, TORRENTS)
        const row = page.locator(view === 'cards' ? '.torrent' : '.torrent-table tbody tr', { hasText: 'A.Season.Pack' })
        await row.getByRole('button', { name: 'Options for A.Season.Pack' }).click()
        await page.getByRole('dialog').getByRole('button', { name: 'Get a share link' }).click()
        await expect(page.getByRole('dialog').locator('.subject')).toContainText('A.Season.Pack')
        await expect(page.locator('main + section'), 'the details stay closed').toHaveCount(0)
      })
    }
  }
})

test.describe('on a phone', () => {
  const opened = async (page: Page, language: string, list: object[] = LIST) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LANGUAGE_KEY, language])
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(origin)
    await library(page, list, TORRENTS)
    await expect(page.locator('.torrent, .torrent-table').first()).toBeVisible()
  }

  /**
   * How many rows the shown children of `selector` sit on, by their boxes: a child starts a row when it begins below
   * every child before it. 2 px of slack, since the Select all box's hit area overhangs its row.
   */
  const rowsOf = (page: Page, selector: string) => page.locator(selector).evaluate((box) => {
    const kids = [...box.children].map(kid => kid.getBoundingClientRect()).filter(kid => kid.width > 0).sort((a, b) => a.top - b.top)
    let rows = 0
    let bottom = -Infinity
    for (const kid of kids) {
      if (kid.top >= bottom - 2) {
        rows++
        bottom = kid.bottom
      } else bottom = Math.max(bottom, kid.bottom)
    }
    return { rows, kids: kids.length, height: Math.round(box.getBoundingClientRect().height) }
  })

  for (const language of ['en', ...Object.keys(catalogues())]) {
    test(`${language}: the toolbar keeps to one row from 390 to 320 px with the longest filter and sort and a long group name, chevrons whole, the sort cut first, then the group`, async ({ page }) => {
      await opened(page, language, LIST.map(item => ({ ...item, ephemeral: false })))
      const menu = page.getByRole('menu')
      // the widest word of the chip's menu, as the chip draws it, chosen
      const chooseLongest = async (chip: string) => {
        const word = page.locator(`.list-toolbar .chip.${chip} .value`)
        await page.locator(`.list-toolbar .chip.${chip}`).click()
        const font = await word.evaluate(shown => getComputedStyle(shown).font)
        const words = await menu.locator('[role=menuitemradio] .text').allTextContents()
        const widest = await page.evaluate(([words, font]) => {
          const pen = document.createElement('canvas').getContext('2d')!
          pen.font = font
          const widths = words.map(shown => pen.measureText(shown).width)
          return widths.indexOf(Math.max(...widths))
        }, [words, font] as const)
        await menu.locator('[role=menuitemradio]').nth(widest).click()
        await expect(word).toHaveText(words[widest]!)
        return words[widest]!
      }
      // the width the sort and the group chips stop at below 400 px, their icon and chevron alone
      const FLOOR = 52.5
      const fitOf = () => page.locator('.list-toolbar').evaluate((bar) => {
        const box = (shown: Element) => shown.getBoundingClientRect()
        const [show, group, sort] = ['show', 'group', 'sort'].map(chip => bar.querySelector(`.chip.${chip}`)!)
        const cut = (chip: Element) => { const word = chip.querySelector('.value')!; return word.scrollWidth > word.clientWidth }
        // how far the toolbar's end, its right or, right to left, its left, is passed
        const rtl = getComputedStyle(bar).direction === 'rtl'
        const end = (shown: Element) => (rtl ? -box(shown).left : box(shown).right)
        return {
          past: Math.max(...[...bar.children].map(end)) - end(bar),
          chevrons: [show!, group!, sort!].map((chip) => { const chevron = chip.querySelector('.chev')!; return box(chevron).width > 13.5 && end(chevron) <= end(chip) }),
          showCut: cut(show!),
          groupCut: cut(group!),
          groupWidth: box(group!).width,
          sortWidth: box(sort!).width,
        }
      })
      // as it opens, with every torrent shown: the Group chip's word gives way only once the sort has given its own, and
      // the filter's once both have
      for (const width of [390, 360, 320]) {
        await page.setViewportSize({ width, height: 844 })
        await drawn(page)
        const fit = await fitOf()
        if (fit.groupCut) expect(fit.sortWidth, `${width} px: the word Group is cut while the sort has room to give`).toBeLessThanOrEqual(FLOOR)
        if (fit.showCut) expect(Math.max(fit.sortWidth, fit.groupWidth), `${width} px: the filter is cut while another chip has room to give`).toBeLessThanOrEqual(FLOOR)
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('.list-toolbar .chip.show').click()
      await expect(menu.getByRole('menuitemradio'), 'the control: every filter but Kept and Temporary, as nothing is temporary').toHaveCount(7)
      await page.locator('.list-toolbar .chip.show').click()
      const chosen = [await chooseLongest('show'), await chooseLongest('sort')].join(', ')
      // every row in a group with a long name, shown
      await page.locator('.list-toolbar .pick-all input').check()
      await page.locator('.bulk-bar button[aria-haspopup=menu]').click()
      await menu.getByRole('menuitem').last().click()
      await page.getByRole('dialog').locator('input').fill(LONG_GROUP)
      await page.getByRole('dialog').locator('button[type=submit]').click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.locator('.list-toolbar .chip.group').click()
      await menu.getByRole('menuitemradio').last().click()
      await expect(page.locator('.list-toolbar .chip.group .value')).toHaveText(LONG_GROUP)
      await page.keyboard.press('Escape')
      for (const width of [390, 360, 320]) {
        await page.setViewportSize({ width, height: 844 })
        await drawn(page)
        const at = `${width} px, ${chosen} chosen`
        const { rows, kids, height } = await rowsOf(page, '.list-toolbar')
        expect(kids, 'the control: the box, Show, Group, Sort and the views were read').toBe(5)
        expect(rows, `${at}, ${height} px tall`).toBe(1)
        const fit = await fitOf()
        expect(fit.past, `${at}: the views end inside the toolbar`).toBeLessThanOrEqual(0.5)
        expect(fit.chevrons, `${at}: each chevron whole inside its chip`).toEqual([true, true, true])
        expect(fit.groupCut, `${at}: the control: the name is longer than any phone has room for`).toBe(true)
        // the sort gives its word's room first, then the group, and the filter, which says which rows are listed, last
        expect(fit.sortWidth, `${at}: the group is cut while the sort has room to give`).toBeLessThanOrEqual(FLOOR)
        if (fit.showCut) expect(fit.groupWidth, `${at}: the filter is cut while the group has room to give`).toBeLessThanOrEqual(FLOOR)
      }
    })
  }

  for (const language of ['en', ...Object.keys(catalogues())]) {
    test(`${language}: at 390 px the filter Temporary keeps its whole word beside the Group and Sort chips`, async ({ page }) => {
      await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LIST_FILTER_KEY, 'temporary'])
      await opened(page, language)
      const word = page.locator('.list-toolbar .chip.show .value')
      await expect(word, 'the control: the filter is Temporary').toHaveText(language === 'en' ? 'Temporary' : catalogues()[language]!['Temporary#filter']!)
      expect(await word.evaluate(shown => shown.scrollWidth - shown.clientWidth)).toBe(0)
    })
  }

  for (const language of ['en', ...Object.keys(catalogues())]) {
    test(`${language}: the bar for ticked rows keeps to one row inside the window from 390 to 320 px with Download showing, its count whole`, async ({ page }) => {
      await opened(page, language)
      for (const name of ['Some.Release.Name.S01.1080p', 'Elsewhere']) {
        await page.locator('.torrent').filter({ hasText: name }).locator('.row-check input').check()
      }
      const bar = page.locator('.bulk-bar')
      await expect(bar.locator('button svg.lucide-download'), 'the control: Download shows').toBeVisible()
      for (const width of [390, 360, 320]) {
        await page.setViewportSize({ width, height: 844 })
        await drawn(page)
        const { rows, kids, height } = await rowsOf(page, '.bulk-bar')
        expect(kids, 'the control: seven buttons, and the count while it shows, were read').toBe(width > 340 ? 8 : 7)
        expect(rows, `${width} px, ${height} px tall`).toBe(1)
        expect(await bar.evaluate(shown => shown.lastElementChild!.getBoundingClientRect().right - shown.getBoundingClientRect().right), `${width} px: past the bar`).toBeLessThanOrEqual(0)
        // its number shows whole while there is room for it, its words kept for a screen reader
        await expect(bar.locator('.count .number')).toBeVisible({ visible: width > 340 })
        await expect(bar.locator('.count .number')).toHaveText('2')
        await expect(bar.getByRole('status').locator('.words')).toContainText('2')
        expect(await bar.locator('.count').evaluate(count => count.scrollWidth - count.clientWidth), `${width} px: the count is cut`).toBe(0)
      }
    })
  }

  for (const language of ['en', 'ru', 'fr']) {
    test(`${language}: the list keeps room for a whole row`, async ({ page }) => {
      await opened(page, language)
      const room = await page.locator('main').evaluate(list => list.clientHeight)
      expect(room).toBeGreaterThanOrEqual(await page.locator('.torrent').first().evaluate(row => row.getBoundingClientRect().height))
    })
  }

  /** The list runs on below the window here and the page scrolls, so the bar holds to the window and not to the list. */
  for (const view of ['cards', 'table']) {
    test(`en: a tick in the ${view} shows the bulk bar inside the window`, async ({ page }) => {
      await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LIST_VIEW_KEY, view])
      await opened(page, 'en')
      // short enough for the list to run on below it under the one-row header and the two-row strip
      await page.setViewportSize({ width: 390, height: 600 })
      await page.getByRole('checkbox', { name: 'Select A.Season.Pack' }).check()
      await page.evaluate(() => window.scrollTo(0, 0))
      await drawn(page)
      const { list, bar, height } = await page.evaluate(() => ({
        list: document.querySelector('main')!.getBoundingClientRect().bottom,
        bar: document.querySelector('.bulk-bar')!.getBoundingClientRect().toJSON() as DOMRect,
        height: innerHeight,
      }))
      expect(list, 'the list ends inside the window, so this proves nothing').toBeGreaterThan(height)
      expect(bar.top).toBeGreaterThanOrEqual(0)
      expect(bar.bottom).toBeLessThanOrEqual(height)
    })
  }

  /** Sharing is in a torrent's options, and a table row's options have a button, since an iPhone sends no right-click. */
  test('en: a table row\'s button opens its options, with Get a share link', async ({ page }) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LIST_VIEW_KEY, 'table'])
    await opened(page, 'en')
    await page.locator('.torrent-table tbody tr').first().getByRole('button', { name: /^Options for / }).click()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Get a share link' })).toBeVisible()
    await expect(page.locator('main + section'), 'the details stay closed').toHaveCount(0)
  })

  /** A state takes a second line only when one would leave the name too little, so pausing a row keeps its height. */
  test('fr: a state keeps to one line wherever the name has room beside it', async ({ page }) => {
    await page.addInitScript(key => localStorage.setItem(key, 'table'), LIST_VIEW_KEY)
    await opened(page, 'fr')
    await expect(page.locator('.torrent-table .badge.paused')).toHaveText('En pause')
    const heights = () => page.locator('.torrent-table tbody .badge').evaluateAll(badges =>
      badges.map(badge => [badge.classList[1], Math.round(badge.getBoundingClientRect().height)] as const))
    await page.setViewportSize({ width: 390, height: 844 })
    await drawn(page)
    const at390 = await heights()
    expect(new Set(at390.map(([, height]) => height)).size, `390 px: ${at390.join(' ')}`).toBe(1)
    // with Progress showing FICHIERS MANQUANTS takes two lines, and EN PAUSE still has room for one
    await page.setViewportSize({ width: 412, height: 844 })
    await drawn(page)
    const at412 = new Map(await heights())
    expect(at412.get('paused'), `412 px: ${[...at412].join(' ')}`).toBe(at412.get('seeding'))
  })

  for (const language of ['en', ...Object.keys(catalogues()), PSEUDO]) {
    test(`${language}: the table stays inside the window from 320 to 412 px, with a name to read and each state inside its badge`, async ({ page }) => {
      await page.addInitScript(key => localStorage.setItem(key, 'table'), LIST_VIEW_KEY)
      await opened(page, language)
      await expect(page.locator('.torrent-table')).toBeVisible()
      for (const width of [320, 360, 390, 412]) {
        await page.setViewportSize({ width, height: 844 })
        await drawn(page)
        const { right, window, name, spilled } = await page.evaluate(() => ({
          right: document.querySelector('.torrent-table')!.getBoundingClientRect().right,
          window: document.documentElement.clientWidth,
          name: document.querySelector('.torrent-table tbody td.name')!.getBoundingClientRect().width,
          spilled: [...document.querySelectorAll('.torrent-table tbody .badge')].filter(badge => badge.scrollWidth > badge.clientWidth + 1).map(badge => badge.textContent),
        }))
        expect(right, `${width} px`).toBeLessThanOrEqual(window)
        // about eight letters, which a state too long to sit beside it on one line wraps to leave
        expect(name, `${width} px`).toBeGreaterThanOrEqual(80)
        expect(spilled, `${width} px`).toEqual([])
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

test('the bar for ticked rows downloads every ticked torrent not on this device in one press, and offers it only then', async ({ page }) => {
  await page.goto(origin)
  await library(page, [...LIST, entry('7', 'Elsewhere.Too', { started: false })], TORRENTS)
  const bar = page.locator('.bulk-bar')
  const tick = (name: string) => page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check()
  await tick('A.Season.Pack')
  await expect(bar).toContainText('1 selected')
  await expect(bar.getByRole('button', { name: 'Download' })).toHaveCount(0)
  // Made.Here is a created source, whose own row offers no download either
  await tick('Made.Here')
  await expect(bar).toContainText('2 selected')
  await expect(bar.getByRole('button', { name: 'Download' })).toHaveCount(0)
  for (const name of ['Elsewhere', 'Elsewhere.Too']) await tick(name)
  await expect(bar).toContainText('4 selected')
  await bar.getByRole('button', { name: 'Download' }).click()
  const started = () => page.evaluate(() => (window as unknown as { started: () => string[] }).started().sort())
  await expect.poll(started).toEqual(['7'.repeat(40), 'f'.repeat(40)])
  expect(await startCommands(page), 'one command for every ticked row').toEqual(['start-many'])
})

test('the bar for ticked rows says Stop and Start only while every ticked torrent is finished', async ({ page }) => {
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const bar = page.locator('.bulk-bar')
  for (const name of ['A.Season.Pack', 'Watched.Film']) await page.getByRole('checkbox', { name: `Select ${name}` }).check()
  await expect(bar.getByRole('button', { name: 'Stop' }).locator('svg')).toHaveClass(/lucide-square/)
  await expect(bar.getByRole('button', { name: 'Start' })).toBeEnabled()
  await page.getByRole('checkbox', { name: 'Select Some.Release.Name.S01.1080p' }).check()
  await expect(bar.getByRole('button', { name: 'Pause' }).locator('svg')).toHaveClass(/lucide-pause/)
  await expect(bar.getByRole('button', { name: 'Resume' })).toBeEnabled()
  await expect(bar.getByRole('button', { name: 'Stop' })).toHaveCount(0)
})

test('the Show menu shows the rows of the state picked, counts each, offers none with no rows, and is remembered', async ({ page }) => {
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const show = page.getByRole('button', { name: /^Show: /u })
  const rows = page.getByRole('menu').getByRole('menuitemradio')
  const offered = async () => {
    await show.click()
    const names = await rows.evaluateAll(all => all.map(row => row.getAttribute('aria-label')!))
    await show.click()
    await expect(rows).toHaveCount(0)
    return names
  }
  const choose = async (name: string | RegExp) => {
    await show.click()
    await page.getByRole('menu').getByRole('menuitemradio', { name, exact: true }).click()
    await expect(rows).toHaveCount(0)
  }
  await choose(/^Seeding /u)
  await expect(page.locator('.torrent .title')).toHaveText(['A.Season.Pack'])
  await expect(show).toHaveAccessibleName('Show: Seeding (1)')
  const all = await offered()
  expect(all.map(name => name.replace(/ \(\d+\)$/u, ''))).toEqual(['All', 'Kept', 'Temporary', 'Downloading', 'Seeding', 'Completed', 'Paused', 'Not on this device', 'Retrying'])
  for (const name of all) {
    await choose(name)
    await expect(show, name).toHaveAccessibleName(`Show: ${name}`)
    await expect(page.locator('.torrent'), name).toHaveCount(Number(/\((\d+)\)$/u.exec(name)?.[1]))
  }

  await choose(/^Paused /u)
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  await expect(show).toHaveAccessibleName(/^Show: Paused /u)
  await expect(page.locator('.torrent .title')).toHaveText(['Kept.Paused'])

  await choose(/^All /u)
  await page.goto(origin)
  await library(page, LIST.slice(0, 2), TORRENTS.slice(0, 2))
  expect(await offered()).toEqual(['All (2)', 'Downloading (1)', 'Seeding (1)'])
})

test('a group made of ticked rows is shown alone, with a state on top, counted under it, downloaded, renamed, filled, emptied and deleted', async ({ page }) => {
  // two torrents not on this device in the group, both of which its Download all fetches, and one outside it, left alone
  const list = [...LIST, entry('7', 'Elsewhere.Too', { started: false }), entry('8', 'Elsewhere.Also', { started: false })]
  await page.goto(origin)
  await library(page, list, TORRENTS)
  const chip = page.locator('.list-toolbar .chip.group')
  const menu = page.getByRole('menu')
  const titles = page.locator('.torrent .title')
  const tick = (name: string) => page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check()
  const names = () => menu.getByRole('menuitemradio').evaluateAll(all => all.map(row => row.getAttribute('aria-label')))
  const fromChip = async (which: string, row: string | RegExp) => {
    await page.locator(`.list-toolbar .chip.${which}`).click()
    await menu.getByRole('menuitemradio', { name: row, exact: true }).click()
    await expect(menu).toHaveCount(0)
  }
  await expect(chip).toHaveAccessibleName('Group: All torrents (13)')
  await expect(chip).toHaveText('Group')

  for (const name of ['A.Season.Pack', 'Elsewhere', 'Elsewhere.Also', 'Kept.Paused', 'Made.Here']) await tick(name)
  await groupTicked(page, 'Week 2')
  await expect(page.locator('.toast')).toHaveText(`Added to ${isolated('Week 2')}`)
  await expect(titles, 'making a group shows nothing else').toHaveCount(13)
  await page.keyboard.press('Escape')
  await expect(page.locator('.bulk-bar')).toHaveCount(0)

  // ticked rows the group holds only some of
  for (const name of ['A.Season.Pack', 'Watched.Film']) await tick(name)
  await page.locator('.bulk-bar button[aria-haspopup=menu]').click()
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Week 2' }), 'some of the ticked rows are not in it').toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator('.bulk-bar')).toHaveCount(0)

  // a state none of the group's rows is in says so, rather than that the group is empty
  await fromChip('show', /^Downloading \(/u)
  await fromChip('group', 'Week 2 (0)')
  await expect(page.locator('.empty')).toContainText('Nothing matches this filter.')
  await fromChip('show', 'All (5)')
  await expect.poll(async () => (await titles.allTextContents()).sort()).toEqual(['A.Season.Pack', 'Elsewhere', 'Elsewhere.Also', 'Kept.Paused', 'Made.Here'])
  await expect(chip).toHaveAccessibleName('Group: Week 2 (5)')
  await page.locator('.list-toolbar .chip.show').click()
  await expect.poll(names, 'the filter counts within the group').toEqual([
    'All (5)', 'Kept (4)', 'Temporary (1)', 'Seeding (1)', 'Paused (1)', 'Not on this device (3)',
  ])
  await menu.getByRole('menuitemradio', { name: 'Paused (1)' }).click()
  await expect(titles).toHaveText(['Kept.Paused'])
  await expect(page.locator('.hidden-note'), 'the filter hides four of the group').toContainText('4 torrents hidden')
  await chip.click()
  await expect.poll(names, 'a group counts under the filter').toEqual(['All torrents (1)', 'Week 2 (1)'])
  await page.keyboard.press('Escape')
  await fromChip('show', 'All (5)')

  // Made.Here is a created source, whose own row offers no download either
  await chip.click()
  await menu.getByRole('menuitem', { name: 'Download all' }).click()
  const started = () => page.evaluate(() => (window as unknown as { started: () => string[] }).started().sort())
  await expect.poll(started).toEqual(['8'.repeat(40), 'f'.repeat(40)])
  expect(await startCommands(page), 'one command for the whole group').toEqual(['start-many'])
  // the engine reports them started, so nothing is left to fetch
  await post(page, { type: 'list', list: list.map(item => ['Elsewhere', 'Elsewhere.Also'].includes(item.name!) ? { ...item, started: true } : item) }, {
    type: 'state', torrents: [...TORRENTS, snapshot(12, 'f', 'Elsewhere', {}), snapshot(13, '8', 'Elsewhere.Also', {})],
  })
  await chip.click()
  await expect(menu.getByRole('menuitem')).toHaveText(['New group...', 'Copy link', 'Rename...', 'Delete group'])

  await menu.getByRole('menuitem', { name: 'Rename...' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveAccessibleName('Week 2')
  await dialog.locator('input').fill('Week 3')
  await dialog.locator('input').press('Enter')
  await expect(chip).toHaveText('Week 3')

  await expect(page.locator('.torrent', { hasText: 'Watched.Film' })).toHaveCount(0)
  await fromChip('group', /^All torrents /u)
  // the state headings above it put it under the fold, and a scroll still on its way closes the menu it opens
  const film = page.locator('.torrent', { hasText: 'Watched.Film' })
  await film.scrollIntoViewIfNeeded()
  await drawn(page)
  await film.click({ button: 'right' })
  await menu.getByRole('menuitemcheckbox', { name: 'Week 3' }).click()
  await expect(page.locator('.toast')).toHaveText(`Added to ${isolated('Week 3')}`)
  await fromChip('group', 'Week 3 (6)')
  await page.goto(origin)
  await library(page, list, TORRENTS)
  await expect(chip, 'the group shown is remembered').toHaveText('Week 3')
  await expect(titles).toHaveCount(6)

  // the same scroll as above, after the reload (it closed the menu on CI, 0.0.78)
  await film.scrollIntoViewIfNeeded()
  await drawn(page)
  await film.click({ button: 'right' })
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Week 3' })).toHaveAttribute('aria-checked', 'true')
  await menu.getByRole('menuitemcheckbox', { name: 'Week 3' }).click()
  await expect(page.locator('.toast')).toHaveText(`Taken out of ${isolated('Week 3')}`)
  await expect(titles).toHaveCount(5)
  await expect(page.locator('.torrent', { hasText: 'Watched.Film' })).toHaveCount(0)

  await page.locator('.list-toolbar .pick-all input').check()
  await page.locator('.bulk-bar button[aria-haspopup=menu]').click()
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Week 3' })).toHaveAttribute('aria-checked', 'true')
  await menu.getByRole('menuitemcheckbox', { name: 'Week 3' }).click()
  await expect(page.locator('.empty')).toContainText(`Nothing in ${isolated('Week 3')}.`)
  await expect(page.locator('.bulk-bar')).toHaveCount(0)

  await chip.click()
  await menu.getByRole('menuitem', { name: 'Delete group' }).click()
  await expect(dialog).toHaveAccessibleName(`Delete ${isolated('Week 3')}?`)
  await expect(dialog).toContainText('Its torrents stay in your list.')
  await dialog.getByRole('button', { name: 'Delete group' }).click()
  await expect(chip).toHaveText('Group')
  await expect(titles).toHaveCount(13)
  await chip.click()
  await expect.poll(names).toEqual(['All torrents (13)'])
})

test('a group\'s name stops short on a wide window, so the sort keeps its word', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  await page.locator('.list-toolbar .pick-all input').check()
  const name = `${LONG_GROUP}, ${LONG_GROUP}, ${LONG_GROUP}`
  await groupTicked(page, name)
  await page.locator('.list-toolbar .chip.group').click()
  await page.getByRole('menu').getByRole('menuitemradio').last().click()
  const word = page.locator('.list-toolbar .chip.group .value')
  await expect(word).toHaveText(name)
  expect(await word.evaluate(shown => shown.scrollWidth > shown.clientWidth), 'the control: the name is cut').toBe(true)
  const sort = page.locator('.list-toolbar .chip.sort .value')
  expect(await sort.evaluate(shown => shown.scrollWidth - shown.clientWidth)).toBe(0)
})

test('a group made from the Group chip is empty and shown, and Show everything shows every torrent again', async ({ page }) => {
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const sent = await sending(page, ['add-magnet'])
  await page.locator('.list-toolbar .chip.group').click()
  await page.getByRole('menu').getByRole('menuitem', { name: 'New group...' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
  await dialog.locator('input').fill('Later')
  // a paste behind the dialog adds nothing, as behind any other
  await paste(page, magnetOf('3', 'Pasted'))
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.list-toolbar .chip.group')).toHaveText('Later')
  await expect(page.locator('.empty')).toContainText(`Nothing in ${isolated('Later')}.`)
  // nothing to put in a link, so no Copy link
  await drawn(page)
  await page.locator('.list-toolbar .chip.group').click()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['New group...', 'Rename...', 'Delete group'])
  await page.keyboard.press('Escape')
  expect(await sent()).toEqual([])
  await paste(page, magnetOf('3', 'Pasted'))
  await expect.poll(async () => (await sent()).length, 'the control: the same paste with no dialog adds it').toBe(1)
  await page.locator('.empty').getByRole('button', { name: 'Show everything' }).click()
  await expect(page.locator('.list-toolbar .chip.group')).toHaveText('Group')
  await expect(page.locator('.torrent')).toHaveCount(11)
})

/** The link of a group of Seven and Eight, which the list does not hold. */
const SENT = () => linkTo('Week 9', [magnetOf('7', 'Seven'), magnetOf('8', 'Eight')])

test('a group link asks first, adds its torrents as rows not on this device in a group of its name, and is spent', async ({ page }) => {
  // the link as Copy link writes it, at this server
  const link = buildGroupLink('Week 9', [magnetOf('7', 'Seven'), magnetOf('8', 'Eight')].map(magnet => ({ magnet }))).link!
  const fragment = link.split('#')[1]!
  // a state the received rows are not in, remembered from before
  await page.goto(origin)
  await page.evaluate(key => localStorage.setItem(key, 'downloading'), LIST_FILTER_KEY)
  requests.length = 0
  await page.goto(link.replace('https://torrent.fkn.app', origin))
  await library(page, LIST, TORRENTS)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveAccessibleName('Week 9')
  await expect(dialog.locator('p')).toHaveText('2 torrents')
  await expect(page, 'spent once read, so a reload asks nothing').toHaveURL(`${origin}/`)
  const sent = await sending(page, ['import-list', 'add-magnet'])
  // a paste or a drop behind the dialog adds nothing, as behind the add dialog
  await paste(page, magnetOf('3', 'Pasted'))
  await drag(page, 'dragenter', magnetOf('1', 'Dropped'))
  await drawn(page)
  await expect(page.locator('[data-drag]')).toHaveCount(0)
  await drag(page, 'drop', magnetOf('1', 'Dropped'))
  await drawn(page)
  expect(await sent(), 'nothing is added while it asks').toEqual([])

  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await sent()).length).toBe(1)
  const { list } = (await sent())[0] as { list: { infoHash: string, magnet: string, savePath: string }[] }
  expect(list.map(({ infoHash, magnet, savePath }) => ({ infoHash, magnet, savePath }))).toEqual(['7', '8'].map(c => ({
    infoHash: c.repeat(40), magnet: `magnet:?xt=urn:btih:${c.repeat(40)}`, savePath: `/dl/${c.repeat(40)}`,
  })))
  await expect(page.locator('.toast')).toHaveText(`${isolated('Week 9')} added`)
  // as the engine lists them: not started, so not on this device
  const listed = [...LIST, ...list.map(item => ({ ...item, started: false, ephemeral: false }))]
  await post(page, { type: 'list', list: listed })
  const chip = page.locator('.list-toolbar .chip.group')
  await expect(chip).toHaveText('Week 9')
  await expect(chip).toHaveAccessibleName('Group: Week 9 (2)')
  await expect(page.locator('.list-toolbar .chip.show')).toHaveAccessibleName(/^Show: All /u)
  await expect(page.locator('.torrent')).toHaveCount(2)
  await chip.click()
  await page.getByRole('menu').getByRole('menuitem', { name: 'Download all' }).click()
  const started = () => page.evaluate(() => (window as unknown as { started: () => string[] }).started().sort())
  await expect.poll(started).toEqual(['7'.repeat(40), '8'.repeat(40)])
  expect(await startCommands(page), 'one command for the whole group').toEqual(['start-many'])

  await paste(page, magnetOf('3', 'Pasted'))
  await expect.poll(async () => (await sent()).length, 'the control: the same paste with no dialog adds it').toBe(2)
  await drag(page, 'dragenter', magnetOf('1', 'Dropped'))
  await expect(page.locator('[data-drag]'), 'the control: the same drag with no dialog is shown').toHaveCount(1)
  await drag(page, 'drop', magnetOf('1', 'Dropped'))
  await expect.poll(async () => (await sent()).length, 'the control: the same drop with no dialog adds it').toBe(3)
  // the server never received the group, in an address or as the page a request came from
  expect(requests.filter(line => line.startsWith('/add ')), 'the control: the log holds the visit').toHaveLength(1)
  expect(requests.filter(line => line.includes(fragment.slice(0, 16)))).toEqual([])
  await page.reload()
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.list-toolbar')).toBeVisible()
  await expect(dialog).toHaveCount(0)

  // the same link again adds nothing twice
  await page.goto(link.replace('https://torrent.fkn.app', origin))
  await library(page, listed, TORRENTS)
  await expect(chip, 'the groups are read before Add').toHaveText('Week 9')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.toast')).toHaveText(`${isolated('Week 9')} added`)
  await chip.click()
  await expect(page.getByRole('menu').getByRole('menuitemradio', { name: /^Week 9 /u })).toHaveCount(1)
})

test('an /add link holding a magnet asks about the magnet, whatever follows the #', async ({ page }) => {
  await page.goto(`${origin}/add?magnet=${encodeURIComponent(magnetOf('7', 'Seven'))}#${SENT()}`)
  await library(page, LIST, TORRENTS)
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Seven')
})

test('a group link cut short says it could not be read, asks nothing, and is spent', async ({ page }) => {
  await page.goto(`${origin}/add#${SENT().slice(0, -8)}`)
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.toast')).toHaveText('That link could not be read')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(`${origin}/`)
})

test('a group link whose magnets add up past 1 MiB could not be read, and one with a long name asks with 200 characters of it', async ({ page }) => {
  // a few thousand characters, deflated
  const heavy = linkTo('Week 9', [`magnet:?xt=urn:btih:${'7'.repeat(40)}&tr=${'a'.repeat(1024 * 1024)}`])
  expect(readGroupLink(heavy), 'the control: the link reads').not.toBeNull()
  await page.goto(`${origin}/add#${heavy}`)
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.toast')).toHaveText('That link could not be read')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const name = `${'\u{1F331}'.repeat(150)}${'x'.repeat(150)}`
  await page.goto(`${origin}/add#${linkTo(`  ${name}`, [magnetOf('7', 'Seven')])}`)
  await library(page, LIST, TORRENTS)
  const title = page.getByRole('dialog').locator('h2')
  await expect(title).toBeVisible()
  expect(await title.evaluate(shown => shown.textContent)).toBe(Array.from(name).slice(0, 200).join(''))
})

test('a group link whose group the browser will not store says so, with no error left behind', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/add#${SENT()}`)
  await library(page, LIST, TORRENTS)
  const sent = await sending(page, ['import-list'])
  await page.evaluate((key) => {
    const store = IDBObjectStore.prototype as { put: (...args: unknown[]) => IDBRequest }
    const put = store.put
    store.put = function (...args) {
      if (args[1] === key) throw new DOMException('refused', 'QuotaExceededError')
      return put.apply(this, args)
    }
  }, 'ripple:groups')
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.toast')).toHaveText('Could not add the group')
  expect(await sent()).toHaveLength(1)
  // the frames of fkn.app the offline browser cannot load throw errors of their own
  expect(errors.filter(message => message.includes('refused'))).toEqual([])
})

test('a group link inside a frame asks nothing and adds nothing', async ({ page }) => {
  // another site, at another name for this server
  writeFileSync(join(dir, 'group-embedder.html'), `<body style="margin:0"><iframe src="${origin}/add#${SENT()}" style="border:0;width:100vw;height:100vh"></iframe>`)
  const embedder = new URL('/group-embedder.html', origin.replace('127.0.0.1', 'localhost')).href
  await page.route(embedder, route => route.continue())
  await page.goto(embedder)
  const frame = page.frames().find(each => each.url().startsWith(origin))!
  await library(frame, LIST, TORRENTS)
  await expect(frame.locator('.list-toolbar')).toBeVisible()
  await drawn(frame)
  await expect(frame.getByRole('dialog')).toHaveCount(0)
  await expect(frame.locator('.toast')).toHaveCount(0)
})

test('the installed app asks about a group link it is opened with, and about one reaching its open window', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'launchQueue', {
    configurable: true,
    value: { setConsumer: (consumer: unknown) => Object.assign(window, { launch: consumer }) },
  }))
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const sent = await sending(page, ['import-list', 'add-magnet'])
  const launch = (address: string) => page.evaluate(async (targetURL) => {
    const { launch } = window as unknown as { launch: (params: object) => Promise<void> }
    await launch({ targetURL, files: [] })
  }, address)
  const dialog = page.getByRole('dialog')

  await launch(`${origin}/add#${SENT()}`)
  await expect(dialog).toHaveAccessibleName('Week 9')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  // the address an /add link leads to
  await launch(`${origin}/?group#${linkTo('Week 10', [magnetOf('7', 'Seven')])}`)
  await expect(dialog).toHaveAccessibleName('Week 10')
  await expect(dialog.locator('p')).toHaveText('1 torrent')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await launch(`${origin}/add#${SENT().slice(0, -8)}`)
  await expect(page.locator('.toast')).toHaveText('That link could not be read')
  await expect(dialog).toHaveCount(0)
  expect(await sent()).toEqual([])

  // a magnet in the address is added as it is today, whatever follows the #
  await launch(`${origin}/add?magnet=${encodeURIComponent(magnetOf('7', 'Seven'))}#${SENT()}`)
  await expect(dialog.locator('h2')).toHaveText('Seven')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await launch(`${origin}/?magnet=${encodeURIComponent(magnetOf('3', 'Three'))}#${SENT()}`)
  await expect(page.locator('.toast')).toHaveText('Magnet added')
  await expect(dialog).toHaveCount(0)
})

/** Puts `bytes` where the page keeps the .torrent a torrent was added from. */
const keepTorrentFile = (page: Page, infoHash: string, bytes: Buffer) => page.evaluate(([key, bytes]) => new Promise<void>((resolve, reject) => {
  const open = indexedDB.open('keyval-store')
  open.onupgradeneeded = () => open.result.createObjectStore('keyval')
  open.onsuccess = () => {
    const put = open.result.transaction('keyval', 'readwrite').objectStore('keyval').put(new Uint8Array(bytes), key)
    put.onsuccess = () => { open.result.close(); resolve() }
    put.onerror = () => reject(put.error)
  }
  open.onerror = () => reject(open.error)
}), [`ripple:torrent:${infoHash}`, [...bytes]] as const)

const str = (value: string) => `${Buffer.byteLength(value)}:${value}`
// a .torrent whose info dictionary says private, as a private tracker hands one out
const PRIVATE_TORRENT = Buffer.from(`d${str('announce')}${str('https://members.example/key/announce')}${str('info')}d${str('length')}i11e${str('name')}${str('Members')}${str('piece length')}i16384e${str('pieces')}${str('p'.repeat(20))}${str('private')}i1eee`)

test('Copy link copies the shown group\'s link inside the click, leaves a private torrent out and says so, and reads back as the group', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  await page.goto(origin)
  // Elsewhere's kept .torrent says private
  await keepTorrentFile(page, 'f'.repeat(40), PRIVATE_TORRENT)
  await library(page, LIST, TORRENTS)
  const chip = page.locator('.list-toolbar .chip.group')
  const menu = page.getByRole('menu')
  for (const name of ['A.Season.Pack', 'Elsewhere', 'Kept.Paused']) await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check()
  await groupTicked(page, 'Week 2')
  await page.keyboard.press('Escape')
  await chip.click()
  await menu.getByRole('menuitemradio', { name: 'Week 2 (3)' }).click()
  // the link holds the whole group, whatever the Show chip lets through
  await page.locator('.list-toolbar .chip.show').click()
  await menu.getByRole('menuitemradio', { name: /^Seeding \(/u }).click()
  await expect(page.locator('.torrent .title')).toHaveText(['A.Season.Pack'])
  // where the click wrote to the clipboard: WebKit refuses a write once the click has awaited anything
  await page.evaluate(() => {
    let clicking = false
    window.addEventListener('click', () => { clicking = true }, true)
    window.addEventListener('click', () => { clicking = false })
    const write = navigator.clipboard.writeText.bind(navigator.clipboard)
    navigator.clipboard.writeText = (text: string) => {
      Object.assign(window, { inClick: clicking })
      return write(text)
    }
  })
  await chip.click()
  await menu.getByRole('menuitem', { name: 'Copy link' }).click()
  await expect(page.locator('.toast')).toHaveText('Link copied, 1 private torrent left out')
  expect(await page.evaluate(() => (window as unknown as { inClick: boolean }).inClick)).toBe(true)
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied.startsWith(GROUP_LINK_PREFIX)).toBe(true)
  const read = readGroupLink(copied.slice(GROUP_LINK_PREFIX.length))
  expect(read?.name).toBe('Week 2')
  expect(read?.torrents.map(t => t.infoHash).sort()).toEqual(['b'.repeat(40), 'c'.repeat(40)])
})

test('Copy link for a group past the most a link holds says so, and copies nothing', async ({ page }) => {
  test.setTimeout(180_000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LIST_VIEW_KEY, 'table'])
  await page.goto(origin)
  const hashOf = (i: number) => i.toString(16).padStart(40, '0')
  const many = Array.from({ length: 1001 }, (_, i) => ({ infoHash: hashOf(i), magnet: `magnet:?xt=urn:btih:${hashOf(i)}`, name: `Many.${i}`, size: GB, addedAt: 1, started: false }))
  await library(page, many, [])
  await page.locator('.list-toolbar .pick-all input').check()
  await groupTicked(page, 'All of them')
  await page.keyboard.press('Escape')
  const chip = page.locator('.list-toolbar .chip.group')
  const menu = page.getByRole('menu')
  await chip.click()
  await menu.getByRole('menuitemradio', { name: 'All of them (1001)' }).click()
  await page.evaluate(() => navigator.clipboard.writeText('held before'))
  await chip.click()
  await menu.getByRole('menuitem', { name: 'Copy link' }).click({ timeout: 30_000 })
  await expect(page.locator('.toast')).toHaveText('Links hold up to 1,000 torrents')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('held before')
})

test('a state filter says nothing matches from the engine\'s first report on, and not before', async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LIST_FILTER_KEY, 'seeding'])
  await page.goto(origin)
  await page.waitForFunction(() => (window as unknown as { engineListens: () => boolean }).engineListens())
  await post(page, { type: 'ready' }, { type: 'list', list: [entry('e', 'On.Its.Way')] })
  // the starting row is in the library, so the toolbar counts it
  await page.getByRole('button', { name: /^Show: /u }).click()
  await expect(page.getByRole('menu').getByRole('menuitemradio').first()).toHaveAccessibleName('All (1)')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.locator('.empty')).toHaveCount(0)
  // a report without the row, as after a restore that could not add it, so the row stays starting
  await post(page, { type: 'state', torrents: [], ...READOUTS[0]! })
  await expect(page.locator('.empty')).toContainText('Nothing matches this filter.')
})

test('the auto-save folder takes a completed torrent as well as a seeding one, and no download', async ({ page }) => {
  // as the engine reports a finished torrent: its files placed in the pieces and every piece held, which is what the
  // copy reads before it takes one
  const held = (snap: typeof TORRENTS[0]) => {
    if (snap.status.state !== 5 || !snap.files) return snap
    let length = 0
    const files = snap.files.files.map((file) => {
      const offset = length
      length += file.size
      return { ...file, offset }
    })
    const numPieces = Math.ceil(length / snap.files.pieceLength)
    const pieces = Array.from({ length: Math.ceil(numPieces / 8) }, () => 0xff)
    return { ...snap, files: { ...snap.files, files }, bitfield: { pieces, numPieces, pieceLength: snap.files.pieceLength, length } }
  }
  await page.goto(origin)
  await library(page, LIST, TORRENTS.map(held))
  await chooseFolder(page)
  const readFrom = () => page.evaluate(() => (window as unknown as { readFrom: () => number[] }).readFrom().sort((a, b) => a - b))
  // A.Season.Pack seeding and Watched.Film completed, each read through the engine to be copied
  await expect.poll(readFrom).toEqual([2, 11])
})

test('a torrent libtorrent\'s queue holds offers Force start in its menu, which reads ticked once forced', async ({ page }) => {
  await page.goto(origin)
  // paused and still auto-managed (TORRENT_FLAG.paused | TORRENT_FLAG.autoManaged) is the queue holding it
  await library(page, [...LIST, entry('7', 'Held.Back'), entry('8', 'Run.Anyway', { forced: true })], [
    ...TORRENTS,
    snapshot(12, '7', 'Held.Back', { paused: true, flags: 16 | 32 }),
    snapshot(13, '8', 'Run.Anyway', { flags: 0 }),
  ])
  const menu = page.getByRole('menu')
  const force = menu.getByRole('menuitemcheckbox', { name: 'Force start' })
  const openMenu = async (name: string) => {
    const row = page.locator('.torrent', { hasText: name })
    await row.scrollIntoViewIfNeeded()
    await drawn(page)
    await row.click({ button: 'right' })
    await expect(menu).toBeVisible()
  }
  await openMenu('Some.Release.Name.S01.1080p')
  await expect(menu.getByRole('menuitem', { name: 'Pause' })).toBeVisible()
  await expect(force).toHaveCount(0)
  await page.keyboard.press('Escape')
  await openMenu('Run.Anyway')
  await expect(force).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await openMenu('Held.Back')
  await expect(force).toHaveAttribute('aria-checked', 'false')
  // each Force start the page sends the engine
  await page.evaluate(() => {
    const sent: number[] = []
    const proto = Worker.prototype as { postMessage: (message: { type?: string, handle?: number }) => void }
    const post = proto.postMessage
    proto.postMessage = function (message) { if (message?.type === 'force-start') sent.push(message.handle!); post.call(this, message) }
    Object.assign(window, { forceStarted: () => [...sent] })
  })
  await force.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { forceStarted: () => number[] }).forceStarted())).toEqual([12])
})

/**
 * Any row prop the page makes anew on each of its renders (an inline arrow, a handler without useCallback) silently
 * redraws every row on every tick. A redraw shows here even when nothing in the row changed: React 19 sets a checkbox's
 * name and type again on every render of it.
 */
test('an engine tick redraws no row whose figures stood still', async ({ page }) => {
  const tick = async (torrents = TORRENTS) => {
    await post(page, { type: 'state', torrents, rateLimits: { down: 5_000_000, up: 0 }, ...READOUTS[0] })
    await drawn(page)
  }
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  // a row's speed graph keeps the last 60 ticks, so even a row standing still moves until its graph is full
  for (let i = 0; i < 60; i++) await tick()
  await page.evaluate(() => {
    const touched = new Set<string>()
    Object.assign(window, { touched: () => [...touched] })
    new MutationObserver((records) => {
      for (const { target } of records) {
        const row = (target instanceof Element ? target : target.parentElement)?.closest('.torrent')
        if (row) touched.add(row.querySelector('.title')?.textContent ?? '')
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  const touched = () => page.evaluate(() => (window as unknown as { touched: () => string[] }).touched())
  await tick()
  await tick()
  expect((await touched()).filter(name => ['A.Season.Pack', 'Kept.Paused', 'Stalled'].includes(name))).toEqual([])
  // the control: a figure that moves in one of them is seen
  await tick(TORRENTS.map(t => t.handle === 3 ? { ...t, status: { ...t.status, numPeers: 5 } } : t))
  expect(await touched()).toContain('Kept.Paused')
})

test('the peak download is the highest since the page opened, past the graph\'s two minutes and an engine change', async ({ page }) => {
  const at = (rate: number) => [{ ...TORRENTS[0]!, status: { ...TORRENTS[0]!.status, downloadRate: rate } }]
  const download = page.locator('.stats .stat.rate strong').first()
  const peak = page.locator('.stats .stat.rate strong').nth(2)
  await page.goto(origin)
  await library(page, LIST.slice(0, 1), at(9_400_000))
  const highest = (await peak.textContent())!
  await expect(download).toHaveText(highest)
  // more ticks than the graph keeps, each drawn on a frame of its own
  await page.evaluate(async (torrents) => {
    const { engine } = window as unknown as { engine: (data: object) => void }
    for (let i = 0; i < 130; i++) {
      engine({ type: 'state', torrents })
      await new Promise(requestAnimationFrame)
    }
  }, at(1_000))
  await expect(download).not.toHaveText(highest)
  await expect(peak).toHaveText(highest)
  // a VPN switch replaces the engine: the rows go back to connecting, then the new one reports
  await post(page, { type: 'engine-reset' })
  await expect(page.locator('.torrent.starting')).toHaveCount(1)
  await post(page, { type: 'ready' }, { type: 'state', torrents: at(1_000) })
  await expect(page.locator('.torrent.starting')).toHaveCount(0)
  await expect(peak).toHaveText(highest)
})

/** Each message of one of `types` the page sends the engine from here on, in order. */
const sending = async (page: Page, types: string[]) => {
  await page.evaluate((types) => {
    const sent: object[] = []
    const proto = Worker.prototype as { postMessage: (...args: unknown[]) => void }
    const post = proto.postMessage
    proto.postMessage = function (...args) {
      const message = args[0] as Record<string, unknown>
      // a .torrent's bytes by their length
      if (types.includes(message?.type as string)) sent.push(Object.fromEntries(Object.entries(message).map(([key, value]) => [key, value instanceof Uint8Array ? value.byteLength : value])))
      post.apply(this, args)
    }
    Object.assign(window, { sent: () => sent })
  }, types)
  return () => page.evaluate(() => (window as unknown as { sent: () => Record<string, unknown>[] }).sent())
}

test('a retrying torrent\'s Pause pauses it, and does not retry it', async ({ page }) => {
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const row = page.locator('.torrent', { hasText: 'Having.Trouble' })
  await expect(row.locator('.badge')).toHaveText('Retrying')
  const sent = await sending(page, ['pause', 'resume', 'retry'])
  await row.getByRole('button', { name: 'Pause Having.Trouble', exact: true }).click()
  await expect.poll(sent).toEqual([{ type: 'pause', handle: 4 }])
})

/** A drag of `text` reaching the page, or its drop, as the browser hands them over. */
const drag = (page: Page, type: 'dragenter' | 'drop', text: string) => page.evaluate(([type, text]) => {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  data.setData('text/uri-list', text)
  document.body.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
}, [type, text] as const)

const paste = (page: Page, text: string) => page.evaluate((text) => {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
}, text)

test('a paste of several magnets or bare hashes adds each torrent not listed yet, with one word for all', async ({ page }) => {
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const sent = await sending(page, ['add-magnet'])
  const toast = page.locator('.toast')

  await paste(page, '7'.repeat(40))
  await expect(toast).toHaveText('Magnet added')
  // two magnets the field joined with nothing between, a bare hash, and the hash of Watched.Film, which is listed
  const field = page.locator('header form input:not([type=file])')
  await field.fill(`${magnetOf('8', 'Eight')}${magnetOf('1', 'One')} ${'3'.repeat(40)} ${'9'.repeat(40)}`)
  await field.press('Enter')
  await expect(toast).toHaveText('3 magnets added')
  await expect(field).toHaveValue('')
  expect((await sent()).map(({ magnet }) => magnet)).toEqual([
    `magnet:?xt=urn:btih:${'7'.repeat(40)}`, magnetOf('8', 'Eight'), magnetOf('1', 'One'), `magnet:?xt=urn:btih:${'3'.repeat(40)}`,
  ])
})

test('with Ask on, several magnets are asked about one after another, and Do not ask again adds the rest', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const sent = await sending(page, ['add-magnet'])
  const field = page.locator('header form input:not([type=file])')
  await field.fill([magnetOf('7', 'Seven'), magnetOf('8', 'Eight'), magnetOf('1', 'One')].join(' '))
  await field.press('Enter')

  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Seven')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog.locator('h2')).toHaveText('Eight')
  // Eight's file list, from the swarm
  await post(page, { type: 'state', torrents: [...TORRENTS, snapshot(21, '8', 'Eight', {})], ...READOUTS[0] })
  await dialog.getByRole('checkbox', { name: 'Do not ask again' }).check()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await expect(dialog).toHaveCount(0)
  expect((await sent()).map(({ magnet, hold }) => [/dn=(\w+)/u.exec(magnet as string)?.[1], hold])).toEqual([
    ['Seven', true], ['Eight', true], ['One', false], ['Eight', false],
  ])
})

test('with Ask on, a picked .torrent is asked about from its own file list, and reaches the engine only on Add, with the answers', async ({ page }) => {
  const torrent = (name: string, buffer: Buffer) => ({ name, mimeType: 'application/x-bittorrent', buffer })
  const sintel = torrent('sintel.torrent', readFileSync(join(ROOT, 'src', 'assets', 'sintel.torrent')))
  // one file of five bytes, so two different torrents can be picked at once
  const other = torrent('other.torrent', Buffer.concat([Buffer.from('d4:infod6:lengthi5e4:name5:Other12:piece lengthi16384e6:pieces20:'), Buffer.alloc(20), Buffer.from('ee')]))
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const sent = await sending(page, ['add-torrent-file', 'add-magnet'])
  const pick = page.locator('label.file-button input[type=file]').first()
  const dialog = page.getByRole('dialog')

  await pick.setInputFiles(sintel)
  await expect(dialog.locator('h2')).toHaveText('Sintel')
  await expect(dialog.locator('.file')).toHaveCount(11)
  await expect(dialog.locator('.count')).toContainText('11 of 11 files')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await sent()).toEqual([])

  await pick.setInputFiles([sintel, other])
  await expect(dialog.locator('h2')).toHaveText('Sintel')
  await dialog.getByRole('button', { name: 'Select none' }).click()
  await dialog.getByRole('checkbox', { name: /Sintel\.mp4/u }).check()
  await dialog.getByRole('checkbox', { name: 'Start downloading' }).uncheck()
  await dialog.getByRole('checkbox', { name: 'Download in sequential order' }).check()
  await dialog.getByRole('checkbox', { name: 'Put it first' }).check()
  await dialog.getByRole('checkbox', { name: 'Download first and last pieces first' }).check()
  await dialog.getByRole('checkbox', { name: 'Do not ask again' }).check()
  expect(await sent()).toEqual([])
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.toast')).toHaveText('Sintel added, paused')
  const answers = ({ type, bytes, saveTo, wanted, firstLast, sequential, paused, top }: Record<string, unknown>) => ({ type, bytes, saveTo, wanted, firstLast, sequential, paused, top })
  expect((await sent()).map(answers)).toEqual([
    { type: 'add-torrent-file', bytes: other.buffer.byteLength, saveTo: undefined, wanted: undefined, firstLast: false, sequential: false, paused: false, top: false },
    { type: 'add-torrent-file', bytes: sintel.buffer.byteLength, saveTo: 'browser', wanted: [5], firstLast: true, sequential: true, paused: true, top: true },
  ])
})

test('with Ask on, a picked .torrent\'s dialog is drawn with every file ticked from its first frame', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  // read in the observer, after the dialog's first commit and before the page's effects run
  await page.evaluate(() => {
    const first: string[] = []
    Object.assign(window, { first })
    new MutationObserver((_, observer) => {
      const count = document.querySelector('[role=dialog] .count')
      if (!count) return
      first.push(count.textContent, document.querySelector('[role=dialog] .problem')?.textContent ?? '')
      observer.disconnect()
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.locator('label.file-button input[type=file]').first().setInputFiles(join(ROOT, 'src', 'assets', 'sintel.torrent'))
  await expect(page.getByRole('dialog').locator('.count')).toContainText('11 of 11 files')
  const [count, problem] = await page.evaluate(() => (window as unknown as { first: string[] }).first)
  expect(count).toContain('11 of 11 files')
  expect(problem).toBe('')
})

test('with Ask on, a magnet the dialog refuses is passed over for the next one', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const field = page.locator('header form input:not([type=file])')
  await field.fill(`magnet:?xt=urn:btih:${'z'.repeat(40)}&dn=Bad ${magnetOf('7', 'Seven')}`)
  await field.press('Enter')
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Seven')
})

test('the next torrent asked about starts with Do not ask again unticked', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const field = page.locator('header form input:not([type=file])')
  await field.fill(`${magnetOf('7', 'Seven')} ${magnetOf('8', 'Eight')}`)
  await field.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('h2')).toHaveText('Seven')
  await dialog.getByRole('checkbox', { name: 'Do not ask again' }).check()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog.locator('h2')).toHaveText('Eight')
  await expect(dialog.getByRole('checkbox', { name: 'Do not ask again' })).not.toBeChecked()
})

const askedFor = (sent: Record<string, unknown>[]) => sent.map(({ magnet, hold }) => [/dn=(\w+)/u.exec(magnet as string)?.[1], hold])

test('with Ask on, a link arriving while the dialog asks is asked about next, even after Do not ask again', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto(origin, { referer: 'https://example.org/list' })
  await library(page, LIST, TORRENTS)
  const sent = await sending(page, ['add-magnet'])
  const dialog = page.getByRole('dialog')
  await paste(page, magnetOf('7', 'Seven'))
  await expect(dialog.locator('h2')).toHaveText('Seven')

  // another site's link, with the dialog on screen
  await page.evaluate((magnet) => {
    history.pushState(null, '', '/?add=' + encodeURIComponent(magnet))
    dispatchEvent(new PopStateEvent('popstate'))
  }, magnetOf('8', 'Eight'))
  await drawn(page)
  await expect(dialog.locator('h2')).toHaveText('Seven')
  expect(askedFor(await sent())).toEqual([['Seven', true]])

  // Seven's file list, from the swarm
  await post(page, { type: 'state', torrents: [...TORRENTS, snapshot(21, '7', 'Seven', {})], ...READOUTS[0] })
  await dialog.getByRole('checkbox', { name: 'Do not ask again' }).check()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await expect(dialog.locator('h2')).toHaveText('Eight')
  await expect(dialog.getByText('Sent here by https://example.org')).toBeVisible()
  expect(askedFor(await sent())).toEqual([['Seven', true], ['Seven', false], ['Eight', true]])
})

test('with Ask on, a magnet or a .torrent the system opens Ripple with waits while the dialog asks', async ({ page }) => {
  // the browser's launch queue, which hands this page what the system opened Ripple with
  await page.addInitScript(() => Object.defineProperty(window, 'launchQueue', {
    configurable: true,
    value: { setConsumer: (consumer: unknown) => Object.assign(window, { launch: consumer }) },
  }))
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const sent = await sending(page, ['add-magnet', 'add-torrent-file'])
  const dialog = page.getByRole('dialog')
  await paste(page, magnetOf('7', 'Seven'))
  await expect(dialog.locator('h2')).toHaveText('Seven')

  // one file of five bytes
  const other = [...Buffer.concat([Buffer.from('d4:infod6:lengthi5e4:name5:Other12:piece lengthi16384e6:pieces20:'), Buffer.alloc(20), Buffer.from('ee')])]
  await page.evaluate(async ([address, other]) => {
    const { launch } = window as unknown as { launch: (params: object) => Promise<void> }
    await launch({ targetURL: address, files: [] })
    await launch({ targetURL: `${location.origin}/`, files: [{ getFile: async () => new File([new Uint8Array(other)], 'other.torrent') }] })
  }, [`${origin}/?magnet=${encodeURIComponent(magnetOf('8', 'Eight'))}`, other] as const)
  await drawn(page)
  await expect(dialog.locator('h2')).toHaveText('Seven')
  expect(askedFor(await sent())).toEqual([['Seven', true]])

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog.locator('h2')).toHaveText('Eight')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog.locator('h2')).toHaveText('Other')
})

test('with Ask on, a link for the torrent the dialog asks about is answered with it', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ripple:add-dialog', '1'))
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const sent = await sending(page, ['add-magnet', 'pause'])
  const dialog = page.getByRole('dialog')
  await paste(page, magnetOf('7', 'Seven'))
  await expect(dialog.locator('h2')).toHaveText('Seven')

  await page.evaluate((magnet) => {
    history.pushState(null, '', '/?add=' + encodeURIComponent(magnet))
    dispatchEvent(new PopStateEvent('popstate'))
  }, magnetOf('7', 'Again'))
  // temporary until the engine hears the Add
  await post(page, { type: 'list', list: [...LIST, entry('7', 'Seven', { ephemeral: true })] }, { type: 'state', torrents: [...TORRENTS, snapshot(21, '7', 'Seven', {})], ...READOUTS[0] })
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await drawn(page)
  expect((await sent()).map(({ type, handle, ...add }) => type === 'pause' ? handle : askedFor([add])[0])).toEqual([['Seven', true], 21, ['Seven', false]])
  await expect(dialog).toHaveCount(0)
})

test('with Ask off, a link the system opens Ripple with asks first, as in a tab, and a magnet it opens Ripple with is added', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'launchQueue', {
    configurable: true,
    value: { setConsumer: (consumer: unknown) => Object.assign(window, { launch: consumer }) },
  }))
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const sent = await sending(page, ['add-magnet'])
  const launch = (address: string) => page.evaluate(async (targetURL) => {
    const { launch } = window as unknown as { launch: (params: object) => Promise<void> }
    await launch({ targetURL, files: [] })
  }, address)
  const dialog = page.getByRole('dialog')

  // a magnet with no name, named by the link
  await launch(`${origin}/add?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${'8'.repeat(40)}`)}&name=Eight`)
  await expect(dialog.locator('h2')).toHaveText('Eight')
  await expect(dialog.getByText('Opened from a link')).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Do not ask again' })).toHaveCount(0)
  // the address an /add link leads to, opened while the dialog asks
  await launch(`${origin}/?add=${encodeURIComponent(magnetOf('7', 'Seven'))}`)
  await drawn(page)
  await expect(dialog.locator('h2')).toHaveText('Eight')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog.locator('h2')).toHaveText('Seven')
  await expect(dialog.getByText('Opened from a link')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)

  // /add as the router reads it, in any case and with a trailing slash
  await launch(`${origin}/Add?magnet=${encodeURIComponent(magnetOf('0', 'Zero'))}`)
  await expect(dialog.locator('h2')).toHaveText('Zero')
  await expect(dialog.getByText('Opened from a link')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await launch(`${origin}/add/?magnet=${encodeURIComponent(magnetOf('1', 'One'))}`)
  await expect(dialog.locator('h2')).toHaveText('One')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  // another page with a magnet or an add on its address, which a tab there adds nothing for
  await launch(`${origin}/legal?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${'01'.repeat(20)}&dn=Legal`)}`)
  await launch(`${origin}/legal?add=${encodeURIComponent(`magnet:?xt=urn:btih:${'10'.repeat(20)}&dn=LegalAdd`)}`)
  await drawn(page)
  await expect(dialog).toHaveCount(0)

  await launch(`${origin}/?magnet=${encodeURIComponent(magnetOf('3', 'Three'))}`)
  await expect(page.locator('.toast')).toHaveText('Magnet added')
  await expect(dialog).toHaveCount(0)
  expect(askedFor(await sent())).toEqual([['Eight', true], ['Seven', true], ['Zero', true], ['One', true], ['Three', false]])
})

test('the add field narrows the list to the names and info hashes it holds the start of, until Escape, and still adds a magnet', async ({ page }) => {
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  const rows = page.locator('.torrent .title')
  const all = await rows.count()
  const field = page.locator('header form input:not([type=file])')
  const add = page.getByRole('button', { name: 'Add', exact: true })

  await field.fill('season')
  await expect(rows).toHaveText(['A.Season.Pack'])
  await expect(add).toBeDisabled()
  // the start of Kept.Paused's info hash
  await field.fill('CCCC')
  await expect(rows).toHaveText(['Kept.Paused'])
  await field.press('Escape')
  await expect(field).toHaveValue('')
  await expect(rows).toHaveCount(all)

  await field.fill('no such name')
  await expect(rows).toHaveCount(0)
  await page.getByRole('button', { name: 'Show everything' }).click()
  await expect(field).toHaveValue('')
  await expect(rows).toHaveCount(all)

  const sent = await sending(page, ['add-magnet'])
  await field.fill(magnetOf('7', 'Seven'))
  await expect(rows).toHaveCount(all)
  await field.press('Enter')
  await expect(field).toHaveValue('')
  expect((await sent()).map(({ magnet }) => magnet)).toEqual([magnetOf('7', 'Seven')])

  // with the Show menu hiding the temporary rows too, the empty list is the one thing that says so
  await page.evaluate(([key, value]) => localStorage.setItem(key!, value!), [LIST_FILTER_KEY, 'library'])
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  await expect(page.locator('.hidden-note')).toBeVisible()
  await field.fill('no such name')
  await expect(page.locator('.empty')).toBeVisible()
  await expect(page.locator('.hidden-note')).toHaveCount(0)
})

test('the table narrows to what the add field holds too, and Select all ticks only the rows shown', async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [LIST_VIEW_KEY, 'table'])
  await page.goto(origin)
  await library(page, LIST, TORRENTS)
  await page.locator('header form input:not([type=file])').fill('season')
  await expect(page.locator('.torrent-table tbody tr')).toHaveCount(1)
  await page.getByRole('checkbox', { name: 'Select all', exact: true }).check()
  await expect(page.locator('.bulk-bar')).toContainText('1 selected')
})

test('the control: in English the same reading finds the page\'s own words', async ({ page }) => {
  test.setTimeout(120_000)
  const { words } = await everySurface(page, 1280)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  expect(englishIn([...new Set(words)], english()).length).toBeGreaterThan(100)
  for (const text of ['Seeding', 'Stop', 'Stop A.Season.Pack', 'Completed', 'Start', 'Start Watched.Film']) expect(words).toContain(text)
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

test('the control: in English the download page\'s own words are read too, and fit', async ({ page }) => {
  test.setTimeout(120_000)
  const { words, cut } = await downloadSurfaces(page, 1280)
  expect(cut).toEqual([])
  for (const text of [
    'Nothing to download', 'this torrent', 'Reading the torrent from the network', 'Loading torrent…', 'Copy magnet', 'Building…',
    'Save .torrent', 'Copy this torrent\'s magnet link', 'Save the .torrent file for this torrent', 'The metadata has not arrived yet',
    'Could not copy the magnet', 'Magnet copied', '4.5 GB · 3 files', 'Download 3 files as .zip', 'Watch Fresh.Pack.S01E01.1080p.mkv',
    '3 files', 'Select all', 'Select none', 'Download Commentary.srt', 'Download', 'Powered by FKN', 'How it works', '2 of 3 files',
    'Download 2 files as .zip', '1 of 3 files', 'Nothing selected', 'Select at least one file', 'Downloading', '0%', '0 bytes of 4.5 GB',
    'Cancel', '82 peers', 'The download stopped. Start it again.', 'Downloading Commentary.srt', 'Saved Commentary.srt', 'Saved',
    'Saved 2 files', 'This file is too large to save here.', 'Out of storage space. Remove a download in Ripple to free room.',
    'The download engine stopped. Reload the page to try again.', 'Ripple needs a normal (non-private) window to download this',
    'None of the requested files are in this torrent', 'No matching files', 'Download not starting? Open this page in Ripple.',
  ]) expect(words).toContain(text)
})

test('the control: in English the player\'s top row and the engine\'s words are read too, and fit', async ({ page }) => {
  test.setTimeout(120_000)
  const { words, cut } = await engineSurfaces(page, 1280)
  expect(cut).toEqual([])
  // a chip's lines are one element's text, read together
  const read = words.join('\n')
  for (const text of [
    'Loading metadata…', 'Open this torrent in Ripple', 'Download this torrent', 'Downloaded 2', 'VPN Reconnecting', 'VPN On',
    '28 peers', 'Download Fresh.Pack.S01E01.1080p.mkv', 'Torrent: Downloading', 'VPN: On', 'Seeders: 216',
    'Leechers: 3', 'Downloads: 8054', 'Connected peers: 28', 'Download speed: 8.7 MB/s', 'Upload speed: 312 kB/s',
    'Out of storage space. Remove a download in Ripple to free room.', 'The download engine stopped. Reload the page to try again.',
    'Ripple needs a normal (non-private) window to play this', 'Streams as you watch',
    'Too big to download ahead here, so it streams as you watch. In Ripple (header link), with more room allowed, it can download in full, without next episode, tracking or watch together.',
    'Too big for this browser\'s storage here. Open it in Ripple to play it.', 'That is not a valid magnet link',
    'The download stopped: could not read 40000 bytes at 0 of file 1: torrent paused',
  ]) expect(read).toContain(text)
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

test('the control: in English the groups\' surfaces and a group sent by link are read too, and fit', async ({ page }) => {
  test.setTimeout(120_000)
  const { words, cut } = await groupSurfaces(page, 1280)
  expect(cut).toEqual([])
  for (const text of ['New group...', 'Download all', 'Copy link', 'Link copied', 'Weekend watch list', '2 torrents', 'Add', 'That link could not be read']) expect(words).toContain(text)
})
