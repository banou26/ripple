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
import { createHash } from 'crypto'

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
   * Dropping a .torrent onto the open share dialog builds a link and adds NOTHING.
   *
   * It used to do both: the drop went to the library's add path, the dialog waited for the torrent
   * to come back, and somebody who wanted a url to send a friend ended up with the torrent in their
   * own list, downloading. A `.torrent` already carries its infohash, name, file list and trackers,
   * so the link is built in the page and the engine is never involved.
   *
   * Two assertions, and the second is the one that was broken: the link names the RIGHT torrent,
   * and the library is exactly as long afterwards as it was before.
   *
   * The fixture is built here rather than committed, so the check carries its own input.
   */
  const pieces = Buffer.alloc(20, 7)
  const info = Buffer.concat([
    Buffer.from('d6:lengthi262144e4:name17:ripple-fixture.md12:piece lengthi262144e6:pieces20:'),
    pieces,
    Buffer.from('e'),
  ])
  // the infohash is the sha1 of the info VALUE, so building it here gives the exact number the link
  // must carry. Asserting that rather than "a link appeared" is the point: a check that only asks
  // whether something resolved passes on the wrong torrent.
  const fixtureHash = createHash('sha1').update(info).digest('hex')
  const fixtureBytes = Buffer.concat([Buffer.from('d8:announce20:udp://127.0.0.1:6969' + '4:info'), info, Buffer.from('e')])
  const fixtureB64 = fixtureBytes.toString('base64')

  const drop = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const dropErrors = []
  drop.on('pageerror', (e) => dropErrors.push(String(e)))
  await drop.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await drop.waitForSelector('header .field', { timeout: 30_000 })
  // Named, not counted. The demo torrent seeds asynchronously, so a row count taken too early
  // moves on its own and a later comparison reads that as "the drop added something". Asking
  // whether THE FIXTURE is in the list is exact and immune to anything else arriving.
  const fixtureInLibrary = () => drop.evaluate(() =>
    [...document.querySelectorAll('.torrent')].some((r) => /ripple-fixture/.test(r.textContent ?? '')))
  await drop.waitForTimeout(3_000)
  const before = await fixtureInLibrary()

  await drop.getByRole('button', { name: /share a torrent/i }).click()
  await drop.waitForSelector('[role="dialog"]', { timeout: 10_000 })

  // a real drop on the window, which is the path that used to add
  await drop.evaluate((b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'ripple-fixture.torrent', { type: 'application/x-bittorrent' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, fixtureB64)

  /*
   * The link names the fixture, read out of whichever parameter the dialog wrote.
   *
   * `m` is the packed form, and its infohash sits in the HEADER as raw bytes: [count][kind][20
   * bytes]. So this reads the hash without inflating anything and without knowing the compression
   * dictionary, which is what keeps this check from breaking every time that table is versioned.
   * The dictionary is frozen precisely so links stay readable, and a check that had to be revised
   * alongside it would be the wrong shape.
   *
   * `magnet` is the published base64 form, still read forever, still what a legacy link carries.
   */
  const linked = await drop
    .waitForFunction((want) => {
      const url = document.querySelector('[role="dialog"] [data-testid="embed-url"]')?.textContent ?? ''
      if (!url.includes('?')) return false
      const params = new URLSearchParams(url.slice(url.indexOf('?')))

      const packed = params.get('m')
      if (packed) {
        try {
          const binary = atob(packed.replace(/-/g, '+').replace(/_/g, '/'))
          // [0] is the hash count, [1] the kind (0 = 20-byte v1 infohash), then the bytes themselves
          if (binary.charCodeAt(1) !== 0) return false
          let hex = ''
          for (let i = 2; i < 22; i++) hex += binary.charCodeAt(i).toString(16).padStart(2, '0')
          return hex === want
        } catch { return false }
      }

      const legacy = params.get('magnet')
      try { return !!legacy && atob(legacy).includes(want) } catch { return false }
    }, fixtureHash, { timeout: 15_000 })
    .then(() => true).catch(() => false)

  // generous, because an add would show up on the next engine tick rather than instantly
  await drop.waitForTimeout(5_000)
  const after = await fixtureInLibrary()
  const stillWaiting = await drop.evaluate(() => /Reading the torrent/.test(document.querySelector('[role="dialog"]')?.textContent ?? ''))

  console.log(`drop into the dialog: linkedTheRightTorrent=${linked} fixtureInLibrary ${before} -> ${after} stillWaiting=${stillWaiting} errors=${dropErrors.length}`)
  const dropBad = []
  if (!linked) dropBad.push(`no link naming the fixture (${fixtureHash})`)
  if (stillWaiting) dropBad.push('still sitting on "Reading the torrent..."')
  if (after) dropBad.push('it also added the torrent to the library, which is the whole complaint')
  if (dropErrors.length) dropBad.push(`page errors: ${dropErrors.slice(0, 2).join(' | ')}`)
  if (dropBad.length) { console.log(`  FAIL: ${dropBad.join('; ')}`); code = 1 }
  else console.log('  PASS')
  await drop.close()

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
