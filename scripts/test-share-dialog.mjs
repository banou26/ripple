// Open the share dialog on a real build and look at it.
//
// The suites pin what the link contains; this is for the half a suite cannot judge, which is whether
// the thing on screen is the thing that was asked for: a modal, a magnet field, a drop zone, and no
// list of torrents already in the library.
//
// Headless is right here: it reads geometry and takes a picture, it observes no transfer. Muted on
// the house rule.

import { chromium } from 'playwright'
import { spawn } from 'child_process'
import { writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

const PORT = 4602
const ORIGIN = `http://127.0.0.1:${PORT}`
const OUT = process.env.SHOT_DIR ?? '/tmp/claude-1000/-home-banou-dev-ripple'

const serve = () => spawn('npx', ['serve', '-s', '-C', '-p', String(PORT), 'build'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const stop = (p) => { try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill() } catch {} } }

const waitUp = async () => {
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(ORIGIN)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('server never came up')
}

const server = serve()
let code = 0
try {
  await waitUp()
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] })

  for (const [name, width, height] of [['wide', 1280, 860], ['narrow', 620, 780]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('footer', { timeout: 30_000 })

    await page.getByRole('button', { name: /share a torrent/i }).click()
    await page.waitForSelector('[role="dialog"]', { timeout: 10_000 })
    await page.waitForTimeout(400)

    const seen = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      const card = d?.querySelector('.card')
      const rect = card?.getBoundingClientRect()
      return {
        isModal: d?.getAttribute('aria-modal') === 'true',
        magnetField: !!d?.querySelector('input[aria-label="Magnet link"]'),
        dropZone: !!d?.querySelector('.drop'),
        filePicker: !!d?.querySelector('input[type="file"]'),
        // the thing that was asked to go away
        torrentChips: d?.querySelectorAll('.chips button').length ?? 0,
        fitsWidth: rect ? rect.left >= 0 && rect.right <= window.innerWidth : false,
        fitsHeight: rect ? rect.top >= 0 && rect.bottom <= window.innerHeight : false,
        docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })

    await page.screenshot({ path: `${OUT}/share-dialog-${name}.png` })
    console.log(`${name} ${width}x${height}: ${JSON.stringify(seen)} errors=${errors.length}`)

    const bad = []
    if (!seen.isModal) bad.push('not a modal')
    if (!seen.magnetField) bad.push('no magnet field')
    if (!seen.dropZone) bad.push('no drop zone')
    if (!seen.filePicker) bad.push('no file picker')
    if (seen.torrentChips > 0) bad.push(`still lists ${seen.torrentChips} torrents`)
    if (!seen.fitsWidth || !seen.fitsHeight) bad.push('the card does not fit the viewport')
    if (seen.docOverflowX !== 0) bad.push(`document scrolls sideways by ${seen.docOverflowX}px`)
    if (errors.length) bad.push(`page errors: ${errors.slice(0, 2).join(' | ')}`)
    if (bad.length) { console.log(`  FAIL: ${bad.join('; ')}`); code = 1 }
    else console.log('  PASS')
    await page.close()
  }

  /*
   * Sharing a .torrent that is ALREADY in the library.
   *
   * This hung for ever on "Reading the torrent...". The dialog armed a claim that waits for a NEW
   * torrent to appear, and re-adding one you already have adds nothing, so nothing ever resolved
   * it. That is the likely case rather than the edge: the file on somebody's disk is usually the
   * one they already opened. Fixed by reading the infohash out of the file first and pointing
   * straight at the existing torrent.
   *
   * The fixture is built here rather than committed, so the check carries its own input and does
   * not depend on a torrent living on one particular machine.
   */
  const fixture = join(tmpdir(), 'ripple-share-fixture.torrent')
  // ONE piece exactly: `pieces` must hold 20 bytes per piece, so a length longer than one piece
  // with a single hash is rejected by the engine and the case silently stops being staged
  const pieces = Buffer.alloc(20, 7)
  const info = Buffer.concat([
    Buffer.from('d6:lengthi262144e4:name17:ripple-fixture.md12:piece lengthi262144e6:pieces20:'),
    pieces,
    Buffer.from('e'),
  ])
  // the infohash is the sha1 of the info VALUE, so building it here gives the exact number the
  // link must carry. Asserting on that rather than on "a link appeared" is the whole point: the
  // old `before` claim resolves to whatever torrent turns up next, so a check that only asks
  // whether SOMETHING resolved passes on the wrong torrent.
  const fixtureHash = createHash('sha1').update(info).digest('hex')
  await writeFile(fixture, Buffer.concat([Buffer.from('d8:announce20:udp://127.0.0.1:6969' + '4:info'), info, Buffer.from('e')]))

  const dup = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const dupErrors = []
  dup.on('pageerror', (e) => dupErrors.push(String(e)))
  await dup.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await dup.waitForSelector('header .field', { timeout: 30_000 })
  await dup.setInputFiles("header .field input[type='file']", fixture)
  const inLibrary = await dup
    .waitForFunction(() => [...document.querySelectorAll('.torrent')].some((r) => /ripple-fixture/.test(r.textContent ?? '')), null, { timeout: 45_000 })
    .then(() => true).catch(() => false)

  if (!inLibrary) {
    console.log('duplicate share: SKIPPED, the fixture never reached the library so the case cannot be staged')
  } else {
    await dup.getByRole('button', { name: /share a torrent/i }).click()
    await dup.waitForSelector('[role="dialog"]', { timeout: 10_000 })
    await dup.setInputFiles("[role=\"dialog\"] input[type='file']", fixture)
    const resolved = await dup
      .waitForFunction((want) => {
        const url = document.querySelector('[role="dialog"] [data-testid="embed-url"]')?.textContent ?? ''
        const magnet = new URLSearchParams(url.slice(url.indexOf('?'))).get('magnet')
        return !!magnet && atob(magnet).includes(want)
      }, fixtureHash, { timeout: 15_000 })
      .then(() => true).catch(() => false)
    const stillWaiting = await dup.evaluate(() => /Reading the torrent/.test(document.querySelector('[role="dialog"]')?.textContent ?? ''))
    const linked = await dup.evaluate(() => {
      const url = document.querySelector('[role="dialog"] [data-testid="embed-url"]')?.textContent ?? ''
      const magnet = new URLSearchParams(url.slice(url.indexOf('?'))).get('magnet')
      return magnet ? atob(magnet).slice(0, 60) : null
    })
    console.log(`duplicate share: linkedTheRightTorrent=${resolved} stillWaiting=${stillWaiting} link=${JSON.stringify(linked)} errors=${dupErrors.length}`)
    const bad = []
    if (!resolved) bad.push(`the link does not name the fixture (${fixtureHash}); it linked ${linked}`)
    if (stillWaiting) bad.push('still sitting on "Reading the torrent..."')
    if (dupErrors.length) bad.push(`page errors: ${dupErrors.slice(0, 2).join(' | ')}`)
    if (bad.length) { console.log(`  FAIL: ${bad.join('; ')}`); code = 1 }
    else console.log('  PASS')
  }
  await dup.close()

  /*
   * The other half of the design: sharing a torrent you already have goes through its own row,
   * which is why the dialog no longer lists them. If that path is broken there is no way to reach
   * the link builder at all, so it is worth driving rather than assuming.
   */
  const row = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const rowErrors = []
  row.on('pageerror', (e) => rowErrors.push(String(e)))
  await row.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  const seeded = await row.waitForSelector('.torrent', { timeout: 30_000 }).then(() => true).catch(() => false)
  if (!seeded) {
    console.log('row path: SKIPPED, no torrent in the library to open a menu on')
  } else {
    await row.locator('.torrent').first().click({ button: 'right' })
    await row.waitForTimeout(300)
    const item = row.getByText(/share link/i).first()
    await item.click()
    await row.waitForSelector('[role="dialog"]', { timeout: 10_000 })
    await row.waitForTimeout(500)
    const built = await row.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      return {
        hasSubject: !!d?.querySelector('.subject strong'),
        subject: d?.querySelector('.subject strong')?.textContent ?? null,
        // it went straight to the link, skipping the ask
        askedInstead: !!d?.querySelector('input[aria-label="Magnet link"]'),
        url: d?.querySelector('[data-testid="embed-url"]')?.textContent ?? '',
      }
    })
    await row.screenshot({ path: `${OUT}/share-dialog-from-row.png` })
    console.log(`row path: ${JSON.stringify(built)} errors=${rowErrors.length}`)
    const bad = []
    if (!built.hasSubject) bad.push('no torrent shown')
    if (built.askedInstead) bad.push('asked for a torrent it was already given')
    if (!built.url.includes('/embed?')) bad.push(`no link built (${built.url})`)
    if (rowErrors.length) bad.push(`page errors: ${rowErrors.slice(0, 2).join(' | ')}`)
    if (bad.length) { console.log(`  FAIL: ${bad.join('; ')}`); code = 1 }
    else console.log('  PASS')
  }
  await row.close()
  await browser.close()
} finally {
  stop(server)
}
process.exit(code)
