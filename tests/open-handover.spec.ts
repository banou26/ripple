/*
 * "Open this torrent in Ripple" from a player in stub's frame chain, where the player keeps its data
 * in a storage partition Ripple's own tab cannot see: the tab takes what the player held, checks
 * every piece, and lists the torrent with the pieces that passed, downloading none of them again.
 *
 * The chain is stub's: a page on one site frames a page on another with stub's sandbox, which frames
 * the player back on the first site. The player's torrent is planted in its partition: a film of
 * 56 pieces in four chunk files, of which the player holds three, one with a wrong byte, and a
 * resume blob claiming every piece, as an engine that believed its blob would.
 */
import type { Frame, Page } from '@playwright/test'

import { expect, test } from '@playwright/test'

const PORT = process.env.RIPPLE_TEST_PORT || '4560'
const SITE = `http://localhost:${PORT}`
const PLUGIN = `http://127.0.0.1:${PORT}`
// stub's sandbox on the plugin frame, which the player's frame inherits
const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox'

/*
 * Playwright turns off the popup blocker and storage partitioning, and either would make this pass
 * for the wrong reason. Its feature list for 1.58 less the one wanted back; if it drifts the
 * partition control below fails first.
 */
const PLAYWRIGHT_OFF = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'BoundaryEventDispatchTracksNodeRemoval', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'Translate', 'AutoDeElevate', 'RenderDocument', 'OptimizationHints']
test.use({
  launchOptions: {
    executablePath: process.env.RIPPLE_CHROME || undefined,
    args: ['--mute-audio', `--disable-features=${PLAYWRIGHT_OFF.filter((f) => f !== 'ThirdPartyStoragePartitioning').join(',')}`],
    ignoreDefaultArgs: ['--disable-popup-blocking', `--disable-features=${PLAYWRIGHT_OFF.join(',')}`],
  },
})

const MiB = 1024 * 1024
const FILM = { size: 224 * MiB, pieceLength: 4 * MiB, chunkBytes: 64 * MiB, held: [0, 1, 3], corrupt: { chunk: 0, at: 5 * MiB } }
// pieces 16 to 31 are chunk 1, 48 to 55 chunk 3, and the wrong byte is in piece 1
const PASSED = [...Array.from({ length: 16 }, (_, p) => p).filter((p) => p !== 1), ...Array.from({ length: 16 }, (_, i) => 16 + i), ...Array.from({ length: 8 }, (_, i) => 48 + i)]

const html = (body: string) => ({ status: 200, contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><body style="margin:0">${body}` })

/** Write the film into this frame's storage as a cache torrent the player's engine restores. */
const plant = async (film: typeof FILM) => {
  // the film's bytes, written out in each function a page runs: each 32-bit word a hash of its index
  const filmBytes = (from: number, length: number) => {
    const words = new Uint32Array(length / 4)
    for (let i = 0; i < words.length; i++) words[i] = Math.imul(from / 4 + i + 1, 0x9e3779b1) >>> 0
    return new Uint8Array(words.buffer)
  }
  const enc = new TextEncoder()
  const join = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    parts.reduce((at, p) => { out.set(p, at); return at + p.length }, 0)
    return out
  }
  const str = (value: string | Uint8Array) => {
    const bytes = typeof value === 'string' ? enc.encode(value) : value
    return join([enc.encode(`${bytes.length}:`), bytes])
  }
  const int = (n: number) => enc.encode(`i${n}e`)
  const pieces = film.size / film.pieceLength
  const hashes = new Uint8Array(pieces * 20)
  for (let p = 0; p < pieces; p++) {
    hashes.set(new Uint8Array(await crypto.subtle.digest('SHA-1', filmBytes(p * film.pieceLength, film.pieceLength))), p * 20)
  }
  const name = 'handover-film.bin'
  const info = join([enc.encode('d'), str('length'), int(film.size), str('name'), str(name), str('piece length'), int(film.pieceLength), str('pieces'), str(hashes), enc.encode('e')])
  const id = new Uint8Array(await crypto.subtle.digest('SHA-1', info))
  const infoHash = [...id].map((b) => b.toString(16).padStart(2, '0')).join('')
  const resume = join([
    enc.encode('d'), str('file-format'), str('libtorrent resume file'), str('file-version'), int(1),
    str('info'), info, str('info-hash'), str(id), str('pieces'), str(new Uint8Array(pieces).fill(1)), enc.encode('e'),
  ])
  let dir = await navigator.storage.getDirectory()
  for (const segment of ['cache', infoHash, String(film.chunkBytes)]) dir = await dir.getDirectoryHandle(segment, { create: true })
  for (const chunk of film.held) {
    const bytes = filmBytes(chunk * film.chunkBytes, Math.min(film.chunkBytes, film.size - chunk * film.chunkBytes))
    if (chunk === film.corrupt.chunk) bytes[film.corrupt.at]! ^= 0xff
    const writable = await (await dir.getFileHandle(`0-${chunk}`, { create: true })).createWritable()
    await writable.write(bytes)
    await writable.close()
  }
  const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${name}`
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('keyval-store')
    request.onupgradeneeded = () => request.result.createObjectStore('keyval')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const tx = db.transaction('keyval', 'readwrite')
    const store = tx.objectStore('keyval')
    const at = Date.now()
    store.put([{ infoHash, magnet, savePath: '/cache/' + infoHash, addedAt: at, lastUsedAt: at, ephemeral: true, started: true }], 'ripple:torrents')
    store.put(resume, 'ripple:resume:' + infoHash)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  return { infoHash, magnet }
}

/** What the tab's storage holds of the film: each chunk file, and whether its bytes are the film's. */
const copied = async ({ film, infoHash }: { film: typeof FILM, infoHash: string }) => {
  // the same bytes as `plant` writes
  const filmBytes = (from: number, length: number) => {
    const words = new Uint32Array(length / 4)
    for (let i = 0; i < words.length; i++) words[i] = Math.imul(from / 4 + i + 1, 0x9e3779b1) >>> 0
    return new Uint8Array(words.buffer)
  }
  let dir = await navigator.storage.getDirectory()
  for (const segment of ['cache', infoHash, String(film.chunkBytes)]) dir = await dir.getDirectoryHandle(segment)
  const out: Record<string, boolean> = {}
  for await (const [name, handle] of (dir as unknown as { entries: () => AsyncIterable<[string, FileSystemFileHandle]> }).entries()) {
    const chunk = Number(name.split('-')[1])
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    const want = filmBytes(chunk * film.chunkBytes, Math.min(film.chunkBytes, film.size - chunk * film.chunkBytes))
    if (chunk === film.corrupt.chunk) want[film.corrupt.at]! ^= 0xff
    out[name] = bytes.length === want.length && bytes.every((b, i) => b === want[i])
  }
  return out
}

const claimedPieces = (infoHash: string) => new Promise<number[]>((resolve) => {
  const request = indexedDB.open('keyval-store')
  request.onerror = () => resolve([])
  request.onsuccess = () => {
    const read = request.result.transaction('keyval', 'readonly').objectStore('keyval').get('ripple:resume:' + infoHash)
    read.onsuccess = () => {
      const blob = read.result as Uint8Array | undefined
      const text = blob ? new TextDecoder('latin1').decode(blob) : ''
      // the last, since the info dictionary before it has a `pieces` of its own
      const at = text.lastIndexOf('6:pieces')
      if (at < 0) { resolve([]); return }
      const colon = text.indexOf(':', at + 8)
      const length = Number(text.slice(at + 8, colon))
      resolve([...blob!.subarray(colon + 1, colon + 1 + length)].flatMap((b, p) => (b & 1 ? [p] : [])))
    }
    read.onerror = () => resolve([])
  }
})

const listOpfs = (frame: Page | Frame) => frame.evaluate(async () => {
  const names: string[] = []
  for await (const name of (await navigator.storage.getDirectory() as unknown as { keys: () => AsyncIterable<string> }).keys()) names.push(name)
  return names
})

test.beforeEach(async ({ context }) => {
  // the first-run demo would add a torrent of its own a few seconds in
  await context.addInitScript(() => { try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ } })
  await context.route(`${SITE}/__first`, (route) => route.fulfill(html('')))
  await context.route(`${SITE}/__stub?*`, (route) => {
    const player = new URL(route.request().url()).searchParams.get('player')!
    return route.fulfill(html(`<iframe src="${PLUGIN}/__plugin?player=${encodeURIComponent(player)}" style="width:960px;height:540px;border:0"></iframe>`))
  })
  await context.route(`${PLUGIN}/__plugin?*`, (route) => {
    const player = new URL(route.request().url()).searchParams.get('player')!
    return route.fulfill(html(`<iframe sandbox="${SANDBOX}" allow="autoplay; fullscreen" src="${player}" style="width:100%;height:540px;border:0"></iframe>`))
  })
  await context.route(`${SITE}/__plant`, (route) => route.fulfill(html('')))
})

test('the player hands Ripple what it held, and only the pieces that check out are listed', async ({ context }) => {
  test.setTimeout(240_000)

  // THE CONTROL: the player's frame does not see what Ripple's own page stores
  const first = await context.newPage()
  await first.goto(`${SITE}/__first`)
  await first.evaluate(async () => { await (await navigator.storage.getDirectory()).getFileHandle('first-party', { create: true }) })
  const stub = await context.newPage()
  await stub.goto(`${SITE}/__stub?player=${encodeURIComponent(`${SITE}/__plant`)}`)
  await expect.poll(() => stub.frames().find((f) => f.url() === `${SITE}/__plant`)).toBeTruthy()
  const player = stub.frames().find((f) => f.url() === `${SITE}/__plant`)!
  expect(await listOpfs(first)).toContain('first-party')
  expect(await listOpfs(player), 'the frame is not partitioned, so this proves nothing').not.toContain('first-party')
  await first.close()

  const { infoHash, magnet } = await player.evaluate(plant, FILM)
  await player.goto(`${SITE}/watch?magnet=${Buffer.from(magnet).toString('base64')}`)
  // the engine restored the planted torrent and knows its file
  await expect(player.locator('.file-name')).toHaveText('handover-film.bin', { timeout: 120_000 })

  const [tab] = await Promise.all([context.waitForEvent('page'), player.getByTestId('open-in-ripple').click()])
  await tab.waitForURL(/[?&]torrent=/, { timeout: 30_000 })
  expect(new URL(tab.url()).searchParams.get('torrent')).toBe(infoHash)

  const row = tab.locator('.torrent', { hasText: 'handover-film.bin' })
  await expect(row.locator('.pct'), 'the tab never listed what the player handed it').toHaveText('69.6%', { timeout: 120_000 })
  await expect(row).toHaveClass(/selected/)
  await expect(tab.getByRole('dialog'), 'the tab fell back to downloading it again').toHaveCount(0)

  // exactly the pieces whose bytes passed, as the blob the engine was handed and kept says
  expect(await tab.evaluate(claimedPieces, infoHash)).toEqual(PASSED)
  // and the bytes behind them are the film's, the wrong one included where the player had it wrong
  expect(await tab.evaluate(copied, { film: FILM, infoHash })).toEqual({ '0-0': true, '0-1': true, '0-3': true })
})

test('a tab the player did not open offers to add the torrent instead', async ({ page }) => {
  test.setTimeout(120_000)
  const magnet = `magnet:?xt=urn:btih:${'d'.repeat(40)}&dn=Never.Handed.Over`
  await page.goto(`${SITE}/?torrent=${'d'.repeat(40)}&magnet=${Buffer.from(magnet).toString('base64')}`)
  const dialog = page.getByRole('dialog')
  await expect(dialog, 'nothing was offered for a torrent the library does not have').toBeVisible({ timeout: 60_000 })
  await expect(dialog).toContainText('Never.Handed.Over')
})
