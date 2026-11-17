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
const FILE = { path: 'stored.bin', size: 1024 * 1024 * 1024, fill: 0x62 }
// every piece holds the same bytes, so one hash stands for all of them
const piece = createHash('sha1').update(Buffer.alloc(PIECE, FILE.fill)).digest()
const info = { name: NAME, 'piece length': PIECE, pieces: Buffer.concat(Array.from({ length: FILE.size / PIECE }, () => piece)), files: [{ length: FILE.size, path: [FILE.path] }] }
const INFO_HASH = createHash('sha1').update(bencode(info)).digest('hex')

type Beat = { at: number, progress: number | null }
type Reading = { badge: string, pct: number }

test('a torrent checking files already in browser storage keeps the engine reporting, and its row the check', async ({ page }) => {
  test.setTimeout(180_000)
  // one state message carries every torrent, so a gap between two is a gap for all of them
  await page.addInitScript((infoHash) => {
    try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
    const w = window as unknown as { __beats: Beat[] }
    w.__beats = []
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor (url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type !== 'state') return
          const t = (event.data.torrents ?? []).find((row: { magnet?: string }) => row.magnet?.toLowerCase().includes(infoHash))
          w.__beats.push({ at: performance.now(), progress: t?.status?.progress ?? null })
        })
      }
    }
  }, INFO_HASH)
  await page.goto('/')
  await page.locator('input[type=file][accept*=".torrent"]').waitFor({ state: 'attached', timeout: 30_000 })
  // a .torrent add saves under the shared root, so this is where the engine's first check finds them
  await page.evaluate(async ({ name, path, size, fill }) => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('dl', { create: true })).getDirectoryHandle(name, { create: true })
    const writable = await (await dir.getFileHandle(path, { create: true })).createWritable()
    const chunk = new Uint8Array(16 * 1024 * 1024).fill(fill)
    for (let at = 0; at < size; at += chunk.length) await writable.write(chunk)
    await writable.close()
  }, { name: NAME, ...FILE })
  const addedAt = await page.evaluate((name) => {
    const readings: Reading[] = []
    Object.assign(window, { __readings: readings })
    window.setInterval(() => {
      const row = [...document.querySelectorAll('.torrent')].find((el) => el.querySelector('.title strong')?.textContent === name)
      if (row) readings.push({ badge: row.querySelector('.badge')?.textContent ?? '', pct: Number.parseFloat(row.querySelector('.pct')?.textContent ?? '') })
    }, 100)
    return performance.now()
  }, NAME)
  await page.locator('input[type=file][accept*=".torrent"]').setInputFiles({ name: `${NAME}.torrent`, mimeType: 'application/x-bittorrent', buffer: bencode({ info }) })

  const beats = () => page.evaluate(() => (window as unknown as { __beats: Beat[] }).__beats)
  await expect.poll(async () => (await beats()).some((b) => b.progress === 1), { timeout: 120_000, message: 'the torrent never finished its check' }).toBe(true)
  const all = await beats()
  const doneAt = all.find((b) => b.progress === 1)!.at
  // THE CONTROL: the check ran long enough that an engine stopped for it leaves a gap past the bound below
  expect(doneAt - addedAt, 'the check ended too soon to tell a stopped engine').toBeGreaterThan(2_000)
  const times = [addedAt, ...all.map((b) => b.at).filter((at) => at > addedAt && at <= doneAt)]
  const gaps = times.slice(1).map((at, i) => Math.round(at - times[i]!))
  expect(Math.max(...gaps), `the engine stopped reporting while it checked, gaps ${gaps.join(', ')} ms`).toBeLessThan(1_200)

  const readings = await page.evaluate(() => (window as unknown as { __readings: Reading[] }).__readings)
  expect(readings.filter((r) => r.badge === 'Checking' && r.pct > 0 && r.pct < 100).length, 'the row never read Checking with the check\'s progress').toBeGreaterThan(0)
})
