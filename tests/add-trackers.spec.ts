/*
 * Trackers added to a running torrent from its details panel, end to end on this build's engine with the VPN off. A
 * WebSocket tracker on loopback is announced to within seconds with no restart, and a line that is no tracker is
 * named. The tracker is stored before any reload, and after one the torrent lists it and announces to it again. The
 * torrent is made here from a file copied into browser storage, which keeps resume data, and from a folder, served
 * from the person's own files with none, as Chromium makes every torrent from a pick it can open again. It seeds from
 * the start, so nothing leaves this machine.
 */
import type { Page } from '@playwright/test'

import { expect, test } from './offline'

import { WEBRTC_PEERS } from '../src/torrent/vpn-config'
import { startTracker } from './vpn-off/tracker.mjs'

// with WebRTC peers stopped nothing announces to a WebSocket tracker
test.skip(!WEBRTC_PEERS, 'WebRTC peers are stopped in this build')

test.use({
  launchOptions: {
    executablePath: process.env.RIPPLE_CHROME || undefined,
    args: ['--mute-audio', '--host-resolver-rules=MAP ripple-tracker.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
  },
})

const NAME = 'Tracked.Film.bin'

/** One key of the raw idb-keyval store, where the worker keeps what each torrent was given, as text: bytes as latin1. */
const storedText = (page: Page, key: string) => page.evaluate((key) => new Promise<string>((resolve) => {
  const request = indexedDB.open('keyval-store')
  request.onerror = () => resolve('')
  request.onsuccess = () => {
    const read = request.result.transaction('keyval', 'readonly').objectStore('keyval').get(key)
    read.onsuccess = () => resolve(read.result instanceof Uint8Array ? new TextDecoder('latin1').decode(read.result) : JSON.stringify(read.result ?? ''))
    read.onerror = () => resolve('')
  }
}), key)

// where each kind keeps an added tracker: a copied file's torrent in its resume data, a folder's apart
const PICKS = [{ pick: 'a copied file', kept: 'ripple:resume:' }, { pick: 'a folder', kept: 'ripple:trackers:' }]

let tracker: Awaited<ReturnType<typeof startTracker>>
test.beforeEach(async () => { tracker = await startTracker() })
test.afterEach(async () => { await tracker.close() })

for (const { pick, kept } of PICKS) test(`a tracker added to a running torrent made from ${pick} is announced to at once, a refused line is named, and the tracker survives a reload`, async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const fs = await import('node:fs')
  fs.mkdirSync(test.info().outputPath(), { recursive: true })
  const file = test.info().outputPath(NAME)
  fs.writeFileSync(file, Buffer.alloc(200_000, 7))
  await page.context().addInitScript(({ folder, name }) => {
    try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
    delete (window as any).showOpenFilePicker
    if (!folder) { delete (window as any).showDirectoryPicker; return }
    // a folder in this origin's own storage, which the picker would hand over and which stays open across a reload
    ;(window as any).showDirectoryPicker = async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
      const writable = await (await dir.getFileHandle('film.bin', { create: true }) as any).createWritable()
      await writable.write(new Uint8Array(200_000).fill(7))
      await writable.close()
      return dir
    }
  }, { folder: pick === 'a folder', name: NAME })
  await page.goto('/')

  await page.getByRole('button', { name: 'Create a torrent' }).click()
  const dialog = page.getByRole('dialog')
  if (pick === 'a folder') {
    await dialog.getByRole('button', { name: 'Choose a folder', exact: true }).click()
  } else {
    const chooser = page.waitForEvent('filechooser')
    await dialog.getByRole('button', { name: 'Choose a file', exact: true }).click()
    await (await chooser).setFiles(file)
  }
  await dialog.getByLabel('Trackers, one per line').fill('')
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.getByText('is being shared')).toBeVisible({ timeout: 120_000 })
  const infoHash = (await dialog.locator('code').first().textContent())!
  await dialog.getByRole('button', { name: 'Close' }).click()
  const row = page.locator('.torrent', { hasText: NAME })
  await expect(row.locator('.badge')).toHaveText('Seeding', { timeout: 120_000 })

  const dock = page.getByRole('region', { name: `Details for ${NAME}` })
  const listed = dock.locator('.rows .row', { hasText: `ripple-tracker.test:${tracker.port}` })
  const openTrackers = async () => {
    await row.locator('.title').click()
    await dock.getByRole('button', { name: 'Trackers', exact: true }).click()
  }
  await openTrackers()
  // THE CONTROL: nothing announces to the tracker before it is added
  await page.waitForTimeout(3_000)
  expect(tracker.seen.announces).toBe(0)
  await expect(listed).toHaveCount(0)

  await dock.getByLabel('Trackers, one per line').fill(`ws://ripple-tracker.test:${tracker.port}\nnot a tracker\n`)
  await dock.getByRole('button', { name: 'Add trackers' }).click()
  await expect(dock.getByText('Not added: not a tracker')).toBeVisible()
  await expect.poll(() => tracker.peers(), { timeout: 15_000, message: 'the running torrent never announced to the added tracker' }).toBe(1)
  await expect(listed).toHaveCount(1, { timeout: 15_000 })
  await expect
    .poll(() => storedText(page, kept + infoHash), { timeout: 15_000, message: 'the tracker is not stored' })
    .toContain(`ripple-tracker.test:${tracker.port}`)

  const announced = tracker.seen.announces
  await page.reload()
  await expect(row.locator('.badge')).toHaveText('Seeding', { timeout: 120_000 })
  await openTrackers()
  await expect(listed).toHaveCount(1, { timeout: 30_000 })
  await expect.poll(() => tracker.seen.announces, { timeout: 30_000, message: 'the reloaded torrent never announced to the tracker' }).toBeGreaterThan(announced)
  expect(errors).toEqual([])
})
