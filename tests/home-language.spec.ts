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
    showDirectoryPicker: async () => (await navigator.storage.getDirectory()).getDirectoryHandle(folder, { create: true }),
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
  ...['aria-label', 'placeholder', 'data-tooltip-content'].map(name => element.getAttribute(name) ?? ''),
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
        // a torrent's name is as long as it is, so the table's ends in an ellipsis in any language
        : own && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).display !== 'inline' && !element.matches('.torrent-table .title') ? [`clipped: ${named(element)}`]
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

  await page.evaluate(() => { localStorage.setItem('spec:first-visit', '1'); localStorage.removeItem('ripple:demo-seeded') })
  await page.goto(origin)
  await library(page, [], [])
  await expect(page.locator('.sample')).toBeVisible({ timeout: 15_000 })
  await read('sample')
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
    test(`${language}: the table shows its columns inside the window, and a name to read`, async ({ page }) => {
      await page.addInitScript(key => localStorage.setItem(key, 'table'), LIST_VIEW_KEY)
      await opened(page, language)
      await expect(page.locator('.torrent-table')).toBeVisible()
      const { table, window, name } = await page.evaluate(() => ({
        table: document.querySelector('.torrent-table')!.getBoundingClientRect().width,
        window: document.documentElement.clientWidth,
        name: document.querySelector('.torrent-table tbody td.name')!.getBoundingClientRect().width,
      }))
      expect(table).toBeLessThanOrEqual(window)
      expect(name).toBeGreaterThanOrEqual(90)
    })
  }

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
