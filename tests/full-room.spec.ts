// What a room held by an earlier film does to the release a frame opens next, with the real engine and the
// browser's own quota. Firefox holds a frame's room fixed, shrunk here to 2 GiB through its temporary storage limit
// (the group limit is a fifth of it); Chromium's ceiling floats, and is the control. Nothing needs a byte to arrive,
// so it runs headless: the torrents are made here and seeded with the library, and the earlier film's chunk files
// are planted sparse, which the quota charges their whole extent, as it does a film that was watched. CI runs Chromium
// only, so the fixed room is checked with --project=firefox (RIPPLE_FIREFOX names the store's Firefox on NixOS).
import type { Page } from '@playwright/test'

import { createHash } from 'node:crypto'

import { expect, test } from '@playwright/test'

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const CHUNK = 64 * MiB
// a fifth of 10 GiB, in KiB as the pref takes it
const TEMPORARY_LIMIT_KB = 10 * 1024 * 1024
const STORAGE_LINE = /Too big for this browser|Out of storage space/
const WINDOW_NOTE = 'Too big to download ahead here'

test.use({
  launchOptions: [async ({ browserName }, use) => {
    await use(browserName === 'firefox'
      ? {
        executablePath: process.env.RIPPLE_FIREFOX || undefined,
        firefoxUserPrefs: { 'media.volume_scale': '0.0', 'dom.quotaManager.temporaryStorage.fixedLimit': TEMPORARY_LIMIT_KB },
      }
      : { executablePath: process.env.RIPPLE_CHROME || undefined, args: ['--mute-audio'] })
  }, { scope: 'worker' }],
})

type Value = number | string | Buffer | Value[] | { [key: string]: Value }
const bencode = (v: Value): Buffer => {
  if (typeof v === 'number') return Buffer.from(`i${v}e`)
  if (typeof v === 'string') return bencode(Buffer.from(v))
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v])
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')])
  return Buffer.concat([Buffer.from('d'), ...Object.keys(v).sort().flatMap((k) => [bencode(k), bencode(v[k]!)]), Buffer.from('e')])
}

// no tracker and no peer will ever have these, so the engine knows them only from the metadata seeded below
const torrent = (name: string, sizes: number[], pieceLength: number) => {
  const total = sizes.reduce((a, b) => a + b, 0)
  const pieces = Buffer.concat(Array.from({ length: Math.ceil(total / pieceLength) }, (_, i) => createHash('sha1').update(`${name}:${i}`).digest()))
  const info: Value = sizes.length === 1
    ? { name, length: sizes[0]!, 'piece length': pieceLength, pieces }
    : { name, 'piece length': pieceLength, pieces, files: sizes.map((length, i) => ({ length, path: [`${name} - ${String(i + 1).padStart(2, '0')}.mkv`] })) }
  const infoHash = createHash('sha1').update(bencode(info)).digest('hex')
  return { infoHash, bytes: [...bencode({ info })], magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${name}` }
}
type Fixture = ReturnType<typeof torrent>

// the owner's release, a 13 episode batch whose fourth episode is 229.5 MiB, and a film bigger than the room
const BATCH = torrent('Batch', [272.3, 245.8, 251.6, 229.5, 231.1, 285.6, 260.5, 258.0, 267.5, 250.3, 268.2, 282.8, 333.9].map((m) => Math.round(m * MiB)), 2 * MiB)
const BIG = torrent('Big', [3 * GiB], 16 * MiB)
// all but 64 MiB of the room
const FILM_CHUNKS = 31
const FILM = torrent('Film', [FILM_CHUNKS * CHUNK], 16 * MiB)

type Seed = { earlier: 'cache' | 'library', opened: Fixture, fixed: boolean }

/**
 * The library as the session before left it: the film watched seconds ago and the release opened before, with their
 * metadata, and the film's bytes on disk. A cache film is in chunk files of its own; a library one is one plain file.
 */
const seed = (page: Page, { earlier, opened, fixed }: Seed) => page.evaluate(async ({ film, opened, earlier, fixed, chunks, CHUNK }) => {
  const now = Date.now()
  const cachePath = (hash: string) => '/cache/' + hash
  const list = [
    { infoHash: film.infoHash, magnet: film.magnet, savePath: earlier === 'cache' ? cachePath(film.infoHash) : '/dl/' + film.infoHash, addedAt: now, lastUsedAt: now, started: true, ephemeral: earlier === 'cache' },
    { infoHash: opened.infoHash, magnet: opened.magnet, savePath: cachePath(opened.infoHash), addedAt: now - 86_400_000, lastUsedAt: now - 86_400_000, started: true, ephemeral: true },
  ]
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('keyval-store', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keyval')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('keyval', 'readwrite')
      const store = tx.objectStore('keyval')
      store.put(list, 'ripple:torrents')
      if (fixed) store.put(true, 'ripple:ceiling-fixed')
      for (const t of [film, opened]) store.put(new Uint8Array(t.bytes), 'ripple:torrent:' + t.infoHash)
      tx.oncomplete = () => { open.result.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  })
  const code = `self.onmessage = async ({ data: { files } }) => {
    const root = await navigator.storage.getDirectory()
    for (const { path, size } of files) {
      const parts = path.split('/').filter(Boolean)
      const name = parts.pop()
      let dir = root
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
      const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle()
      handle.write(new Uint8Array(1), { at: size - 1 })
      handle.flush()
      handle.close()
    }
    postMessage('planted')
  }`
  const files = earlier === 'cache'
    ? Array.from({ length: chunks }, (_, k) => ({ path: `${cachePath(film.infoHash)}/${CHUNK}/0-${k}`, size: CHUNK }))
    : [{ path: `/dl/${film.infoHash}/Film`, size: chunks * CHUNK }]
  const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })))
  await new Promise((resolve) => { worker.onmessage = resolve; worker.postMessage({ files }) })
  worker.terminate()
}, { film: FILM, opened, earlier, fixed, chunks: FILM_CHUNKS, CHUNK })

// in the player's frame only: what the engine says about the room and the torrents, as it says it
const spy = () => {
  if (window === window.top) return
  const rig = { full: [] as boolean[], windowed: {} as Record<string, boolean>, running: {} as Record<string, boolean> }
  ;(window as any).__room = rig
  const Native = window.Worker
  const Spied = function (url: string | URL, options?: WorkerOptions) {
    const worker = new Native(url, options)
    worker.addEventListener('message', ({ data }) => {
      if (data?.type === 'storage-full') rig.full.push(data.full)
      if (data?.type !== 'state') return
      for (const t of data.torrents ?? []) {
        const hash = /btih:([0-9a-f]{40})/i.exec(t.magnet)?.[1]?.toLowerCase()
        if (!hash) continue
        rig.windowed[hash] = t.windowed
        rig.running[hash] = t.status?.state === 3 && !t.status.paused && !t.status.error
      }
    })
    return worker
  } as unknown as typeof Worker
  Spied.prototype = Native.prototype
  window.Worker = Spied
}

/** Open `opened` in a frame of this origin, as stub's plugin frames ripple, and follow it. */
const open = async (page: Page, seeded: Seed) => {
  await page.addInitScript(spy)
  await page.goto('/legal')
  await seed(page, seeded)
  const fileIndex = seeded.opened === BATCH ? 3 : 0
  const src = `/watch?magnet=${Buffer.from(seeded.opened.magnet).toString('base64')}&fileIndex=${fileIndex}`
  await page.evaluate((src) => {
    const frame = Object.assign(document.createElement('iframe'), { id: 'ripple', src, allow: 'autoplay' })
    Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', border: 'none' })
    document.body.append(frame)
  }, src)
  const lines: string[] = []
  const look = async () => {
    const seen = await page.evaluate(async ({ film, opened }) => {
      const frame = (document.getElementById('ripple') as HTMLIFrameElement | null)?.contentWindow as any
      const root = await navigator.storage.getDirectory()
      const has = async (path: string) => {
        let dir: FileSystemDirectoryHandle | null = root
        for (const part of path.split('/').filter(Boolean)) dir = dir ? await dir.getDirectoryHandle(part).catch(() => null) : null
        return !!dir
      }
      const { usage = 0, quota = 0 } = await navigator.storage.estimate()
      return {
        line: frame?.document?.querySelector('.loading-information')?.textContent ?? null,
        film: await has('/cache/' + film) || await has('/dl/' + film),
        free: quota - usage,
        full: [...frame?.__room?.full ?? []] as boolean[],
        windowed: frame?.__room?.windowed?.[opened] as boolean | undefined,
        running: frame?.__room?.running?.[opened] as boolean | undefined,
      }
    }, { film: FILM.infoHash, opened: seeded.opened.infoHash })
    if (seen.line) lines.push(seen.line)
    return seen
  }
  return { look, lines }
}

const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) })

test.describe('a room Firefox holds fixed', () => {
  test.skip(({ browserName }) => browserName !== 'firefox', 'only a fixed ceiling can be held full; Chromium\'s floats')

  test('gives the film watched before up for the episode opened after it, and never calls the episode too big', async ({ page }) => {
    test.setTimeout(120_000)
    const { look, lines } = await open(page, { earlier: 'cache', opened: BATCH, fixed: true })
    // the film's grace is 15 s from when it was last used
    await expect.poll(async () => { const seen = await look(); return !seen.film && seen.running && seen.free > 229.5 * MiB }, { timeout: 75_000, intervals: [1_000] }).toBe(true)
    await page.waitForTimeout(2_000)
    const last = await look()
    await shot(page, 'episode')
    expect(lines.filter((line) => STORAGE_LINE.test(line)), 'the episode was called too big').toEqual([])
    expect(last.full.filter(Boolean)).toEqual([])
    expect(last.windowed).toBe(false)
  })

  test('plays a release bigger than the room through a window, once the film before it is given up', async ({ page }) => {
    test.setTimeout(120_000)
    const { look, lines } = await open(page, { earlier: 'cache', opened: BIG, fixed: true })
    await expect.poll(async () => { const seen = await look(); return !seen.film && seen.windowed && seen.running }, { timeout: 75_000, intervals: [1_000] }).toBe(true)
    await expect.poll(async () => (await look()).line ?? '', { timeout: 10_000 }).toContain(WINDOW_NOTE)
    await shot(page, 'window')
    expect(lines.filter((line) => STORAGE_LINE.test(line)), 'the release was called too big').toEqual([])
    expect((await look()).full.filter(Boolean)).toEqual([])
  })

  // the control: a room held by the person's own download leaves nothing to give up, so the line has to show
  test('says in one line what to do when nothing can make room', async ({ page }) => {
    test.setTimeout(120_000)
    const { look } = await open(page, { earlier: 'library', opened: BIG, fixed: true })
    await expect.poll(async () => (await look()).line ?? '', { timeout: 60_000 }).toMatch(/^Too big for this browser's storage here\. Open it in Ripple to play it\.$/)
    await expect(page.frameLocator('#ripple').getByRole('link', { name: 'Open it in Ripple' })).toHaveAttribute('href', /\/watch\?/)
    await shot(page, 'nothing-to-give')
    const seen = await look()
    expect(seen.film, 'the person\'s own download was given up').toBe(true)
    expect(seen.windowed).toBe(false)
  })
})

test.describe('a room Chromium floats', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'the control for the fixed room above')

  test('plays the release whole, never windowed and never too big', async ({ page }) => {
    test.setTimeout(90_000)
    const { look, lines } = await open(page, { earlier: 'cache', opened: BIG, fixed: false })
    await expect.poll(async () => (await look()).running, { timeout: 30_000 }).toBe(true)
    // past the film's grace, when a fixed room would have planned a window
    await page.waitForTimeout(20_000)
    const seen = await look()
    await shot(page, 'floating')
    expect(seen.windowed).toBe(false)
    expect(lines.filter((line) => STORAGE_LINE.test(line))).toEqual([])
    expect(seen.full.filter(Boolean)).toEqual([])
  })
})
