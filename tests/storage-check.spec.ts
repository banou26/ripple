/*
 * A torrent whose files are already in browser storage, checked by the real engine in the built page. Read in one tick,
 * that check stopped the worker for its whole length, about 2.5 s per GiB: no state for any torrent, and a row reading
 * Queued at 0% until it read Seeding. No transfer, so this is headless.
 */
import { createHash } from 'node:crypto'

import { expect, test } from './offline'

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

const NAME = 'Stored'
const PIECE = 256 * 1024
const BLOCK = 16 * 1024
const CHUNK = 16 * 1024 * 1024
const FILE = { path: 'stored.bin', fill: 0x62 }

// each 16 KiB block starts with its own index, so a read answered with another read's bytes fails its piece's hash
const storedTorrent = (size: number) => {
  const bytes = Buffer.alloc(PIECE, FILE.fill)
  const pieces = Array.from({ length: size / PIECE }, (_, index) => {
    for (let at = 0; at < PIECE; at += BLOCK) bytes.writeUInt32BE((index * PIECE + at) / BLOCK, at)
    return createHash('sha1').update(bytes).digest()
  })
  const info = { name: NAME, 'piece length': PIECE, pieces: Buffer.concat(pieces), files: [{ length: size, path: [FILE.path] }] }
  return { torrent: bencode({ info }), infoHash: createHash('sha1').update(bencode(info)).digest('hex') }
}

type Beat = { at: number, progress: number | null }
type Reading = { badge: string, pct: number }

test('a torrent checking files already in browser storage keeps the engine reporting, and its row the check', async ({ page }) => {
  test.setTimeout(180_000)
  // one state message carries every torrent, so a gap between two is a gap for all of them
  await page.addInitScript(() => {
    try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
    const w = window as unknown as { __beats: Beat[], __infoHash?: string }
    w.__beats = []
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor (url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type !== 'state' || !w.__infoHash) return
          const t = (event.data.torrents ?? []).find((row: { magnet?: string }) => row.magnet?.toLowerCase().includes(w.__infoHash!))
          w.__beats.push({ at: performance.now(), progress: t?.status?.progress ?? null })
        })
      }
    }
  })
  await page.goto('/')
  await page.locator('input[type=file][accept*=".torrent"]').waitFor({ state: 'attached', timeout: 30_000 })
  /*
   * A .torrent add saves under the shared root, so this is where the engine's first check finds them. CI's browser
   * refuses a 1 GiB write (QuotaExceededError, 2026-11-18) while navigator.storage.estimate() still reports room for
   * it, so the size is what a write actually took, less a fifth left for the engine and the library.
   */
  const size = await page.evaluate(async ({ name, path, fill, block, chunkSize }) => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('dl', { create: true })).getDirectoryHandle(name, { create: true })
    const chunk = new Uint8Array(chunkSize).fill(fill)
    const view = new DataView(chunk.buffer)
    const write = async (size: number) => {
      const writable = await (await dir.getFileHandle(path, { create: true })).createWritable()
      let at = 0
      try {
        for (; at < size; at += chunk.length) {
          for (let from = 0; from < chunk.length; from += block) view.setUint32(from, (at + from) / block)
          await writable.write(chunk)
        }
      } catch (error) {
        await writable.abort()
        if ((error as DOMException).name !== 'QuotaExceededError') throw error
        return at
      }
      await writable.close()
      return size
    }
    const taken = await write(1024 * 1024 * 1024)
    if (taken === 1024 * 1024 * 1024) return taken
    const size = Math.floor(taken * 0.8 / chunk.length) * chunk.length
    return await write(size) === size ? size : 0
  }, { name: NAME, ...FILE, block: BLOCK, chunkSize: CHUNK })
  test.skip(size < 512 * 1024 * 1024, `browser storage took ${size} bytes, too few for a check long enough to time`)
  const { torrent, infoHash } = storedTorrent(size)
  await page.evaluate((infoHash) => { (window as unknown as { __infoHash: string }).__infoHash = infoHash }, infoHash)
  const addedAt = await page.evaluate((name) => {
    const readings: Reading[] = []
    Object.assign(window, { __readings: readings })
    window.setInterval(() => {
      const row = [...document.querySelectorAll('.torrent')].find((el) => el.querySelector('.title strong')?.textContent === name)
      if (row) readings.push({ badge: row.querySelector('.badge')?.textContent ?? '', pct: Number.parseFloat(row.querySelector('.pct')?.textContent ?? '') })
    }, 100)
    return performance.now()
  }, NAME)
  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${NAME}.torrent`, mimeType: 'application/x-bittorrent', buffer: torrent })

  const beats = () => page.evaluate(() => (window as unknown as { __beats: Beat[] }).__beats)
  await expect.poll(async () => (await beats()).some((b) => b.progress === 1), { timeout: 120_000, message: 'the torrent never finished its check' }).toBe(true)
  const all = await beats()
  const doneAt = all.find((b) => b.progress === 1)!.at
  // THE CONTROL: the check ran long enough that an engine stopped for it leaves a gap past the bound below
  expect(doneAt - addedAt, 'the check ended too soon to tell a stopped engine').toBeGreaterThan(1_600)
  const times = [addedAt, ...all.map((b) => b.at).filter((at) => at > addedAt && at <= doneAt)]
  const gaps = times.slice(1).map((at, i) => Math.round(at - times[i]!))
  expect(Math.max(...gaps), `the engine stopped reporting while it checked, gaps ${gaps.join(', ')} ms`).toBeLessThan(1_200)

  const readings = await page.evaluate(() => (window as unknown as { __readings: Reading[] }).__readings)
  expect(readings.filter((r) => r.badge === 'Checking' && r.pct > 0 && r.pct < 100).length, 'the row never read Checking with the check\'s progress').toBeGreaterThan(0)
})
