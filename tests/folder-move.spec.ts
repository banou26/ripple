/*
 * A torrent added from a .torrent file and moved into the person's folder, against the real engine and the built page.
 *
 * The move adds the torrent again at the folder. A .torrent add's stored magnet is its bare hash, so a re-add from it
 * has no file list until a peer sends one, and with no peer the row read "Fetching metadata…" at 0% until a reload.
 * Here the files are placed in browser storage before the add, so the torrent finishes with no peer and moves on its
 * own, and nothing but its kept .torrent can give the folder copy its file list. The folder copy then checks its files,
 * which downloads nothing, so its row shows no speed meanwhile. No transfer, so this is headless.
 */
import type { BrowserContext, Page } from '@playwright/test'

import { createHash } from 'node:crypto'

import { expect, test } from './offline'

const PIECE = 16_384

const bencode = (value: unknown): Buffer => {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
  }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((key) => [bencode(key), bencode(record[key])]), Buffer.from('e')])
}

const NAME = 'Whole'
const FILES = [{ path: 'x.bin', size: 50_000, fill: 0x44 }, { path: 'y.bin', size: 30_000, fill: 0x55 }]

const all = Buffer.concat(FILES.map((f) => Buffer.alloc(f.size, f.fill)))
const pieces: Buffer[] = []
for (let at = 0; at < all.length; at += PIECE) pieces.push(createHash('sha1').update(all.subarray(at, at + PIECE)).digest())
const info = { name: NAME, 'piece length': PIECE, pieces: Buffer.concat(pieces), files: FILES.map((f) => ({ length: f.size, path: [f.path] })) }
const TORRENT = bencode({ info })
const INFO_HASH = createHash('sha1').update(bencode(info)).digest('hex')

type Report = { at: number, progress: number, state: number | null, paused: boolean, totalDone: number, files: number }
type Placed = { path: string, size: number, fill: number }

/** Every engine report of the torrent once it is at the folder, from the first. */
const watchMove = async (page: Page, infoHash: string) => {
  await page.addInitScript((moved) => {
    const w = window as any
    w.__moved = []
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor (url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type !== 'state') return
          const t = (event.data.torrents ?? []).find((row: any) => row.status?.savePath === moved)
          if (t) w.__moved.push({ at: performance.now(), progress: t.status.progress, state: t.status.state, paused: t.status.paused, totalDone: t.status.totalDone, files: (t.files?.files ?? []).length })
        })
      }
    }
  }, `/native/${infoHash}`)
  return () => page.evaluate(() => (window as any).__moved as Report[])
}

/** Opens the page with a folder the picker gives, and chooses it. With `ask`, an add asks where its files go. */
const chooseFolder = async (page: Page, ask = true) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
    Object.assign(window, { showDirectoryPicker: async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true }) })
  })
  await page.goto('/')
  await page.getByRole('link', { name: 'Settings', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'picked', exact: true }).waitFor({ timeout: 10_000 })
  if (ask) {
    await page.getByRole('button', { name: 'Start straight away', exact: true }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Ask what to download', exact: true }).waitFor({ timeout: 10_000 })
  }
  await page.locator('header a.back').click()
}

// a .torrent add saves under the shared root, so this is where the engine's first check finds them
const place = (page: Page, name: string, files: Placed[]) => page.evaluate(async ({ name, files }) => {
  const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('dl', { create: true })).getDirectoryHandle(name, { create: true })
  for (const { path, size, fill } of files) {
    const writable = await (await dir.getFileHandle(path, { create: true })).createWritable()
    const chunk = new Uint8Array(Math.min(size, 16 * 1024 * 1024)).fill(fill)
    for (let at = 0; at < size; at += chunk.length) await writable.write(at + chunk.length > size ? chunk.subarray(0, size - at) : chunk)
    await writable.close()
  }
}, { name, files })

const addToFolder = async (page: Page, name: string, torrent: Buffer) => {
  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${name}.torrent`, mimeType: 'application/x-bittorrent', buffer: torrent })
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Add torrent' }).waitFor({ timeout: 20_000 })
  await dialog.locator('label.check', { hasText: 'picked' }).locator('input').check()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 10_000 })
}

/** Every message the toast shows from now on, in order, since the next one replaces it. */
const watchToasts = async (page: Page) => {
  await page.evaluate(() => {
    const shown: string[] = []
    Object.assign(window, { __toasts: shown })
    new MutationObserver(() => {
      const text = document.querySelector('.toast')?.textContent
      if (text && text !== shown.at(-1)) shown.push(text)
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  return () => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)
}

/** The save paths the engine reports for the torrent, each time it changes. */
const watchPaths = async (page: Page, infoHash: string) => {
  await page.addInitScript((infoHash) => {
    const w = window as any
    w.__paths = []
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor (url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type !== 'state') return
          const path = (event.data.torrents ?? []).find((row: any) => row.status?.savePath?.endsWith(infoHash))?.status.savePath
          if (path && path !== w.__paths.at(-1)) w.__paths.push(path)
        })
      }
    }
  }, infoHash)
  return () => page.evaluate(() => (window as any).__paths as string[])
}

/** The progress the engine reports for the torrent, wherever it is, each time it changes. */
const watchProgress = async (page: Page, infoHash: string) => {
  await page.addInitScript((infoHash) => {
    const w = window as any
    w.__progress = []
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor (url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type !== 'state') return
          const progress = (event.data.torrents ?? []).find((row: any) => row.magnet?.toLowerCase().includes(infoHash))?.status?.progress
          if (progress !== undefined && progress !== w.__progress.at(-1)) w.__progress.push(progress)
        })
      }
    }
  }, infoHash)
  return () => page.evaluate(() => (window as any).__progress as number[])
}

/**
 * In every tab, each move its engine is asked for and each write of the torrent's files. A tab that borrows the engine
 * sends its commands through the tab running it, so a move asked for anywhere reaches that tab's worker.
 */
const watchMoves = (context: BrowserContext) => context.addInitScript((names) => {
  const w = window as unknown as { __relocates: string[], __writes: number }
  w.__relocates = []
  w.__writes = 0
  // oxlint-disable-next-line typescript/unbound-method
  Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
    apply: (post, worker, args) => {
      if (args[0]?.type === 'relocate') w.__relocates.push(args[0].to)
      return Reflect.apply(post, worker, args)
    },
  })
  // oxlint-disable-next-line typescript/unbound-method
  FileSystemFileHandle.prototype.createWritable = new Proxy(FileSystemFileHandle.prototype.createWritable, {
    apply: (create, handle: FileSystemFileHandle, args) => {
      if (names.includes(handle.name)) w.__writes++
      return Reflect.apply(create, handle, args)
    },
  })
}, FILES.map((f) => f.path))

const movesIn = (page: Page) => page.evaluate(() => (window as unknown as { __relocates: string[] }).__relocates)
const writesIn = (page: Page) => page.evaluate(() => (window as unknown as { __writes: number }).__writes)
const failed = (shown: string[]) => shown.filter((text) => text.includes('failed'))

/** A second tab on the library, once its toasts are watched. It borrows the engine of the tab opened first. */
const openSecondTab = async (context: BrowserContext) => {
  const other = await context.newPage()
  await other.goto('/')
  await other.locator('input[type=file][accept*=".torrent"]').waitFor({ state: 'attached', timeout: 30_000 })
  return { other, toasts: await watchToasts(other) }
}

test('a .torrent add moved into the folder keeps its file list and its progress', async ({ page, context }) => {
  test.setTimeout(180_000)
  await watchMoves(context)
  const reports = await watchMove(page, INFO_HASH)
  await chooseFolder(page)
  const toasts = await watchToasts(page)
  await place(page, NAME, FILES)
  const placed = await writesIn(page)
  await addToFolder(page, NAME, TORRENT)

  // THE CONTROL: it reached the folder, so the move ran
  await expect.poll(async () => (await reports()).length, { timeout: 90_000, message: 'the torrent never moved into the folder' }).toBeGreaterThan(0)
  await expect.poll(async () => ((await reports()).at(-1)?.progress ?? 0) >= 1, { timeout: 30_000, message: 'the moved torrent lost its progress' }).toBe(true)
  const seen = await reports()
  // libtorrent's 2 is downloading metadata
  expect(seen.filter((r) => r.state === 2), 'the moved torrent waited for its metadata').toEqual([])
  expect(seen.at(-1)?.files).toBe(FILES.length)
  await expect(page.locator('strong', { hasText: /^Whole$/ }).first()).toBeVisible()
  await expect(page.getByText('Fetching metadata…')).toHaveCount(0)
  // its saved state, which a reload restores it from
  const saved = () => page.evaluate((key) => new Promise<boolean>((resolve) => {
    const open = indexedDB.open('keyval-store')
    open.onsuccess = () => {
      const read = open.result.transaction('keyval', 'readonly').objectStore('keyval').get(key)
      read.onsuccess = () => resolve(!!read.result?.byteLength)
      read.onerror = () => resolve(false)
    }
    open.onerror = () => resolve(false)
  }), `ripple:resume:${INFO_HASH}`)
  await expect.poll(saved, { timeout: 15_000, message: 'the moved torrent saved no state' }).toBe(true)
  expect(await toasts(), 'the toast watcher saw nothing').toContain(`${NAME} added`)
  expect((await toasts()).filter((text) => text.startsWith('Moving')), 'a move that worked said it failed').toEqual([])
  // the move copies each file once, and the copy into the folder of every finished torrent leaves a moving one alone
  expect(await writesIn(page) - placed, 'a file was copied into the folder twice').toBe(FILES.length)
})

/*
 * A magnet add whose metadata landed keeps no .torrent of its own, only its saved state, which the move deletes. The
 * state is made here the way the engine makes it, by a .torrent add in browser storage; the kept file is then dropped
 * and the entry given a magnet, which is what a magnet add looks like once its metadata is in. The reload restores it
 * from that state and the move follows.
 */
test('a magnet add whose metadata landed, moved into the folder, keeps its file list without a peer', async ({ page }) => {
  test.setTimeout(240_000)
  const reports = await watchMove(page, INFO_HASH)
  const stored = (key: string) => page.evaluate((key) => new Promise<number[] | null>((resolve) => {
    const open = indexedDB.open('keyval-store')
    open.onsuccess = () => {
      const read = open.result.transaction('keyval', 'readonly').objectStore('keyval').get(key)
      read.onsuccess = () => resolve(read.result?.byteLength ? [...new Uint8Array(read.result)] : null)
      read.onerror = () => resolve(null)
    }
    open.onerror = () => resolve(null)
  }), key)
  await chooseFolder(page)
  await place(page, NAME, FILES)

  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${NAME}.torrent`, mimeType: 'application/x-bittorrent', buffer: TORRENT })
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Add torrent' }).waitFor({ timeout: 20_000 })
  await dialog.locator('label.check', { hasText: 'Browser storage' }).locator('input').check()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 10_000 })

  // THE CONTROL: the saved state carries the metadata, which is all a magnet add has once it landed
  const carriesInfo = async () => {
    const bytes = await stored(`ripple:resume:${INFO_HASH}`)
    return !!bytes && Buffer.from(bytes).includes('4:info')
  }
  await expect.poll(carriesInfo, { timeout: 60_000, message: 'the torrent saved no state with its metadata' }).toBe(true)

  await page.evaluate(({ hash, magnet }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('keyval-store')
    open.onsuccess = () => {
      const tx = open.result.transaction('keyval', 'readwrite')
      const store = tx.objectStore('keyval')
      store.delete(`ripple:torrent:${hash}`)
      const list = store.get('ripple:torrents')
      list.onsuccess = () => store.put(list.result.map((e: any) => (e.infoHash === hash ? { ...e, magnet, saveTo: 'folder' } : e)), 'ripple:torrents')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
    open.onerror = () => reject(open.error)
  }), { hash: INFO_HASH, magnet: `magnet:?xt=urn:btih:${INFO_HASH}&dn=${NAME}` })
  expect(await stored(`ripple:torrent:${INFO_HASH}`), 'the .torrent add\'s own file is still kept').toBeNull()
  await page.reload()

  await expect.poll(async () => (await reports()).length, { timeout: 90_000, message: 'the torrent never moved into the folder' }).toBeGreaterThan(0)
  await expect.poll(async () => ((await reports()).at(-1)?.progress ?? 0) >= 1, { timeout: 30_000, message: 'the moved torrent lost its progress' }).toBe(true)
  const seen = await reports()
  expect(seen.filter((r) => r.state === 2), 'the moved torrent waited for its metadata').toEqual([])
  expect(seen.at(-1)?.files).toBe(FILES.length)
  await expect(page.getByText('Fetching metadata…')).toHaveCount(0)
})

test('a torrent checking its files at the folder shows no download speed', async ({ page }) => {
  test.setTimeout(180_000)
  const BIG = 'Large'
  /*
   * A speed is read from engine reports a second apart, which come every 500 ms. Measured 2026-11-17 on a 16 thread
   * desktop, the check at the folder ran at 100 to 350 MB/s, and 512 MiB in 256 KiB pieces checked in 1.5 s.
   */
  const BIG_PIECE = 64 * 1024
  await page.goto('/')
  // the file sits in browser storage and is copied into the picked folder, which is browser storage here too, so it
  // needs twice its size; GitHub's runner gives the origin less than the 2 GiB a 1 GiB file takes
  const { quota = 0, usage = 0 } = await page.evaluate(() => navigator.storage.estimate())
  const size = Math.min(1024 * 1024 * 1024, Math.floor((quota - usage) / 3 / BIG_PIECE) * BIG_PIECE)
  test.skip(size < 256 * 1024 * 1024, `browser storage leaves room for ${size} bytes, too few for a check long enough to read a speed`)
  const file = { path: 'large.bin', size, fill: 0x61 }
  // every piece holds the same bytes, so one hash stands for all of them
  const piece = createHash('sha1').update(Buffer.alloc(BIG_PIECE, file.fill)).digest()
  const bigInfo = { name: BIG, 'piece length': BIG_PIECE, pieces: Buffer.concat(Array.from({ length: file.size / BIG_PIECE }, () => piece)), files: [{ length: file.size, path: [file.path] }] }
  const reports = await watchMove(page, createHash('sha1').update(bencode(bigInfo)).digest('hex'))
  await chooseFolder(page)
  await place(page, BIG, [file])
  await page.evaluate((name) => {
    const readings: { badge: string, down: string }[] = []
    Object.assign(window, { __readings: readings })
    window.setInterval(() => {
      const row = [...document.querySelectorAll('.torrent')].find((el) => el.querySelector('.title strong')?.textContent === name)
      if (row) readings.push({ badge: row.querySelector('.badge')?.textContent ?? '', down: row.querySelector('.meta .rate')?.textContent ?? '' })
    }, 100)
  }, BIG)
  await addToFolder(page, BIG, bencode({ info: bigInfo }))

  await expect.poll(async () => ((await reports()).at(-1)?.progress ?? 0) >= 1, { timeout: 120_000, message: 'the moved torrent never finished its check' }).toBe(true)
  // THE CONTROL: the check reported a growing total for long enough that a speed could be read from it
  const checks = (await reports()).filter((r) => r.state === 1 && !r.paused)
  expect(checks.length, 'the moved torrent never reported a check').toBeGreaterThan(0)
  expect(checks.at(-1)!.at - checks[0]!.at, 'the check ended before a speed could be read').toBeGreaterThan(1_400)
  expect(checks.at(-1)!.totalDone).toBeGreaterThan(checks[0]!.totalDone)

  const shows = (text: string) => Number(/[\d.,]+/.exec(text)?.[0]?.replaceAll(',', '') ?? 0) > 0
  const readings = await page.evaluate(() => (window as unknown as { __readings: { badge: string, down: string }[] }).__readings)
  expect(readings.filter((r) => r.badge === 'Checking').length, 'the row never read Checking').toBeGreaterThan(0)
  expect(readings.filter((r) => r.badge === 'Checking' && shows(r.down)).map((r) => r.down), 'the row showed a speed while checking').toEqual([])
  // nothing downloaded since the page opened, so the strip's highest download is none
  expect(shows((await page.locator('.stats .stat.rate strong').nth(2).textContent()) ?? ''), 'the peak counted the check as a download').toBe(false)
})

test('a move into a folder that refuses the write says it failed, and moves once the folder takes it', async ({ page }) => {
  test.setTimeout(180_000)
  const paths = await watchPaths(page, INFO_HASH)
  await chooseFolder(page)
  const toasts = await watchToasts(page)
  await place(page, NAME, FILES)
  // a directory where the move writes its first file
  const block = (on: boolean) => page.evaluate(async ({ name, path, on }) => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')).getDirectoryHandle(name, { create: true })
    if (on) await dir.getDirectoryHandle(path, { create: true })
    else await dir.removeEntry(path, { recursive: true })
  }, { name: NAME, path: FILES[0]!.path, on })
  await block(true)
  await addToFolder(page, NAME, TORRENT)

  await expect.poll(toasts, { timeout: 60_000, message: 'the refused move never said it failed' }).toContain(`Moving ${NAME} failed`)
  expect(await paths(), 'the torrent moved into a folder that refused the write').toEqual([])
  await block(false)
  await expect.poll(paths, { timeout: 60_000, message: 'the move never ran again once the folder took the write' }).toEqual([`/native/${INFO_HASH}`])
})

/*
 * The second tab holds the folder too, which its add dialog shows by offering it. Only the tab running the engine
 * moves and copies the torrent: the other tab's move ran beside it and read files the first one's had just dropped,
 * and its copy said it failed.
 */
test('with two tabs open, only the tab running the engine moves a torrent into the folder', async ({ page, context }) => {
  test.setTimeout(180_000)
  await watchMoves(context)
  const paths = await watchPaths(page, INFO_HASH)
  await chooseFolder(page)
  const toasts = await watchToasts(page)
  await place(page, NAME, FILES)
  const { other, toasts: otherToasts } = await openSecondTab(context)
  await addToFolder(other, NAME, TORRENT)

  // THE CONTROL: the tab opened first runs the engine, which moved the torrent
  await expect.poll(paths, { timeout: 90_000, message: 'the torrent never moved into the folder' }).toEqual([`/native/${INFO_HASH}`])
  // the second tab shows the copy the first made, which is what offers removing the torrent but keeping its files
  await other.getByRole('button', { name: `Options for ${NAME}`, exact: true }).first().click()
  await expect(other.getByRole('dialog').last().getByRole('button', { name: 'Remove from the library' })).toBeVisible({ timeout: 60_000 })

  expect([...await movesIn(page), ...await movesIn(other)], 'the torrent was moved more than once').toEqual(['folder'])
  expect(await writesIn(other), 'the tab not running the engine wrote into the folder').toBe(0)
  expect(failed([...await toasts(), ...await otherToasts()]), 'a move that worked said it failed').toEqual([])
})

test('a move asked for in a tab not running the engine is made once, by the tab running it', async ({ page, context }) => {
  test.setTimeout(180_000)
  await watchMoves(context)
  const paths = await watchPaths(page, INFO_HASH)
  const progress = await watchProgress(page, INFO_HASH)
  await chooseFolder(page)
  const toasts = await watchToasts(page)
  await place(page, NAME, FILES)
  const { other, toasts: otherToasts } = await openSecondTab(context)
  await other.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${NAME}.torrent`, mimeType: 'application/x-bittorrent', buffer: TORRENT })
  const dialog = other.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Add torrent' }).waitFor({ timeout: 20_000 })
  await dialog.locator('label.check', { hasText: 'Browser storage' }).locator('input').check()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 10_000 })
  await expect.poll(progress, { timeout: 60_000, message: 'the torrent never finished in browser storage' }).toContain(1)

  await other.getByRole('button', { name: `Options for ${NAME}`, exact: true }).first().click()
  await other.getByRole('dialog').last().getByRole('radio', { name: 'Move to picked' }).click({ timeout: 10_000 })

  await expect.poll(paths, { timeout: 60_000, message: 'the torrent never moved into the folder' }).toEqual([`/native/${INFO_HASH}`])
  // a second move starts on the click or on the next state report, so it is sent within a second of the first
  await page.waitForTimeout(3_000)
  expect([...await movesIn(page), ...await movesIn(other)], 'the torrent was moved more than once').toEqual(['folder'])
  expect(failed([...await toasts(), ...await otherToasts()]), 'a move that worked said it failed').toEqual([])
})

// the tab running the engine was opened before the folder was chosen, in the other tab
test('a folder chosen in a tab not running the engine reaches the tab running it, which moves into it', async ({ page, context }) => {
  test.setTimeout(180_000)
  const paths = await watchPaths(page, INFO_HASH)
  await page.addInitScript(() => { try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ } })
  await page.goto('/')
  await page.locator('input[type=file][accept*=".torrent"]').waitFor({ state: 'attached', timeout: 30_000 })
  const other = await context.newPage()
  await chooseFolder(other)
  await place(other, NAME, FILES)
  await addToFolder(other, NAME, TORRENT)

  await expect.poll(paths, { timeout: 60_000, message: 'the tab running the engine never moved the torrent' }).toEqual([`/native/${INFO_HASH}`])
})

// an add that does not ask has no place of its own, so it goes where the default says, set here in the other tab
test('a default location chosen in a tab not running the engine reaches the tab running it, which moves into it', async ({ page, context }) => {
  test.setTimeout(180_000)
  await watchMoves(context)
  const paths = await watchPaths(page, INFO_HASH)
  const progress = await watchProgress(page, INFO_HASH)
  await chooseFolder(page, false)
  await page.locator('input[type=file][accept*=".torrent"]').waitFor({ state: 'attached', timeout: 30_000 })
  const toasts = await watchToasts(page)
  const other = await context.newPage()
  await other.goto('/settings')
  await other.getByRole('button', { name: 'Files stay in the browser', exact: true }).click({ timeout: 30_000 })
  await other.getByRole('button', { name: 'Files go to picked', exact: true }).waitFor({ timeout: 10_000 })
  await other.goto('/')
  await place(other, NAME, FILES)
  await other.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${NAME}.torrent`, mimeType: 'application/x-bittorrent', buffer: TORRENT })

  // THE CONTROL: the torrent reached the engine and finished, so it could move
  await expect.poll(progress, { timeout: 60_000, message: 'the torrent never finished' }).toContain(1)
  await expect.poll(paths, { timeout: 30_000, message: 'the tab running the engine never moved the torrent' }).toEqual([`/native/${INFO_HASH}`])
  expect([...await movesIn(page), ...await movesIn(other)], 'the torrent was moved more than once').toEqual(['folder'])
  expect(failed(await toasts()), 'a move that worked said it failed').toEqual([])
})

// the tab running the engine copies from the library only, so the other tab looks for the copy first and finds nothing
test('a tab not running the engine sees a copy into the folder within seconds of it landing', async ({ page, context }) => {
  test.setTimeout(180_000)
  await chooseFolder(page)
  const toasts = await watchToasts(page)
  await page.getByRole('link', { name: 'Settings', exact: true }).click({ timeout: 30_000 })
  const other = await context.newPage()
  await other.addInitScript((name) => {
    const w = window as unknown as { __looks: number }
    w.__looks = 0
    // oxlint-disable-next-line typescript/unbound-method
    FileSystemDirectoryHandle.prototype.getDirectoryHandle = new Proxy(FileSystemDirectoryHandle.prototype.getDirectoryHandle, {
      apply: (get, dir, args) => {
        if (args[0] === name && !args[1]?.create) w.__looks++
        return Reflect.apply(get, dir, args)
      },
    })
  }, NAME)
  await other.goto('/')
  await place(other, NAME, FILES)
  await other.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${NAME}.torrent`, mimeType: 'application/x-bittorrent', buffer: TORRENT })
  const dialog = other.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Add torrent' }).waitFor({ timeout: 20_000 })
  await dialog.locator('label.check', { hasText: 'Browser storage' }).locator('input').check()
  await dialog.getByRole('button', { name: 'Add torrent' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 10_000 })

  // THE CONTROL: the other tab looked before the copy was made
  await expect.poll(() => other.evaluate(() => (window as unknown as { __looks: number }).__looks), { timeout: 60_000 }).toBeGreaterThan(0)
  await page.locator('header a.back').click()
  await expect.poll(toasts, { timeout: 30_000, message: 'the tab running the engine never copied the torrent' }).toContain(`${NAME} saved to picked`)
  await other.getByRole('button', { name: `Options for ${NAME}`, exact: true }).first().click()
  await expect(other.getByRole('dialog').last().getByRole('button', { name: 'Remove from the library' }), 'the other tab saw the copy late').toBeVisible({ timeout: 10_000 })
})

test('a folder chosen, allowed or dropped in one tab shows in the other', async ({ page, context }) => {
  // the folder's grant follows a flag, the way a browser's grant reaches every tab of a site
  await context.addInitScript(() => {
    const grant = async () => { localStorage.setItem('test:granted', '1'); return 'granted' }
    Object.assign(window, { showDirectoryPicker: async () => { await grant(); return (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true }) } })
    Object.assign(FileSystemHandle.prototype, {
      queryPermission: async () => (localStorage.getItem('test:granted') === '1' ? 'granted' : 'prompt'),
      requestPermission: grant,
    })
  })
  const button = (tab: Page, name: string) => tab.getByRole('button', { name, exact: true })
  await page.goto('/settings')
  const other = await context.newPage()
  await other.goto('/settings')
  await expect(button(page, 'Choose folder')).toBeVisible({ timeout: 30_000 })

  await button(other, 'Choose folder').click({ timeout: 30_000 })
  await expect(button(other, 'Stop')).toBeVisible()
  await expect(button(page, 'Stop'), 'a folder chosen in one tab did not reach the other').toBeVisible()

  // the browser restarted, which keeps the folder and drops its grant
  await page.evaluate(() => localStorage.setItem('test:granted', '0'))
  for (const tab of [page, other]) {
    await tab.reload()
    await expect(button(tab, 'Allow picked')).toBeVisible({ timeout: 30_000 })
  }
  await button(page, 'Allow picked').click()
  await expect(button(page, 'Stop')).toBeVisible()
  await expect(button(other, 'Stop'), 'a folder allowed in one tab is still waiting in the other').toBeVisible()

  await button(other, 'Stop').click()
  await expect(button(other, 'Choose folder')).toBeVisible()
  await expect(button(page, 'Choose folder'), 'a folder dropped in one tab is still in the other').toBeVisible()
})

test('a torrent moved into the folder moves back into browser storage when asked', async ({ page }) => {
  test.setTimeout(180_000)
  const paths = await watchPaths(page, INFO_HASH)
  await chooseFolder(page)
  await place(page, NAME, FILES)
  await addToFolder(page, NAME, TORRENT)
  // THE CONTROL: the automatic move ran
  await expect.poll(paths, { timeout: 90_000, message: 'the torrent never moved into the folder' }).toEqual([`/native/${INFO_HASH}`])

  await page.getByRole('button', { name: `Options for ${NAME}`, exact: true }).first().click()
  await page.getByRole('dialog').last().getByRole('radio', { name: 'Keep in browser storage' }).click({ timeout: 10_000 })
  await expect.poll(paths, { timeout: 60_000, message: 'the torrent never moved back' }).toEqual([`/native/${INFO_HASH}`, `/dl/${INFO_HASH}`])
})
