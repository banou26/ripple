/*
 * Live figures must not shove the things beside them, in whatever font and language they are drawn.
 *
 * `tabular-nums` was already set in both places and is not the fix: it stops DIGITS jittering and
 * does nothing about a string getting longer, which is what moves a row. 9.9 MB/s to 10.2 MB/s to
 * 999.9 kB/s happens several times a second on anything downloading, and each change drags every
 * readout to its right along with it.
 *
 * Every case runs in each of FONTS, because a room sized for one font holds in that font only: an em
 * width that holds 999.9 MB/s in Noto Sans, system-ui on this machine, leaves the readout beside
 * Download at 221 and 230 instead of 208 in DejaVu Sans, system-ui on GitHub's runner. A test drawn
 * in the machine's own font alone cannot see that.
 *
 * Driven rather than observed: waiting for real values to vary tests whatever the swarm happened to
 * do in the window, where writing the range in tests the rule.
 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { WEBRTC_PEERS } from '../src/torrent/vpn-config'
import { LANGUAGE_KEY } from './languages'
import { addSample } from './sample-offer'

/**
 * The device's own font, a wide fallback (monospace, wider than a sans face nearly everywhere), and
 * a reader's own text spacing, which widens any font: no width written in em holds all three.
 */
const FONTS: Record<string, string> = {
  'device font': '',
  'monospace fallback': 'body * { font-family: monospace !important }',
  'reader text spacing': 'body * { letter-spacing: 0.12em !important; word-spacing: 0.16em !important }',
}

/**
 * Every unit a figure is written in, at its widest and below it, as the page writes them in English
 * and in Japanese, whose 秒 is a full em where English has an s. 1,000 MB/s is what it writes from
 * 999.95 MB/s, because it picks the unit before it rounds.
 */
const LANGUAGES = {
  en: {
    speeds: ['0 B/s', '999.9 B/s', '9.9 kB/s', '999.9 kB/s', '9.9 MB/s', '99.9 MB/s', '999.9 MB/s', '1,000 MB/s', '1.23 GB/s', '9.99 GB/s'],
    sizes: ['0 B', '999 B', '9.9 kB', '999.9 kB', '99.9 MB', '999.9 MB', '1.23 GB', '999.99 GB', '1.5 TB'],
    peers: ['0 peers', '9 peers', '99 peers', '999 peers'],
  },
  ja: {
    speeds: ['0 B/秒', '999.9 B/秒', '9.9 KB/秒', '999.9 KB/秒', '9.9 MB/秒', '99.9 MB/秒', '999.9 MB/秒', '1,000 MB/秒', '1.23 GB/秒', '9.99 GB/秒'],
    sizes: ['0 B', '999 B', '9.9 KB', '999.9 KB', '99.9 MB', '999.9 MB', '1.23 GB', '999.99 GB', '1.5 TB'],
    peers: ['0ピア', '9ピア', '99ピア', '999ピア'],
  },
}

/**
 * A desktop and a phone. On the phone each figure has a line to itself, so one that outgrows its room
 * wraps and moves what follows down rather than along, which is why a position is a top and a left.
 */
const WIDTHS = [1280, 375]

test('live figures keep their room whatever the font, the language and the width', async ({ page }) => {
  test.setTimeout(120_000)
  // the page needs nothing from outside for this, so nothing leaves the machine
  await page.context().route((url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', (route) => route.abort())
  await page.goto('/')
  await addSample(page, { pause: true })

  for (const [language, figures] of Object.entries(LANGUAGES)) {
    if (language !== 'en') {
      await page.evaluate(([key, value]) => localStorage.setItem(key!, value!), [LANGUAGE_KEY, language])
      await page.reload()
    }
    await expect(page.locator('html'), 'the page is not in the language its figures are written in').toHaveAttribute('lang', language)
    await page.locator('.torrent .meta .pair').first().waitFor({ timeout: 90_000 })

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 720 })
      const seen = await page.evaluate(({ fonts, speeds, sizes, peers: counts }) => {
        const [download, upload, peak] = document.querySelectorAll<HTMLElement>('.stats .stat.rate strong')
        const nextStat = (figure: HTMLElement) => figure.parentElement!.nextElementSibling as HTMLElement
        const meta = document.querySelector('.torrent .meta') as HTMLElement
        const pair = meta.querySelector('.pair') as HTMLElement
        const [down, up] = meta.querySelectorAll<HTMLElement>('.rate')
        const peers = meta.querySelector('.peers') as HTMLElement
        // a paused row ends at its peer count, so this stands for the time left a download shows there
        const timeLeft = meta.appendChild(document.createElement('span'))
        timeLeft.textContent = '4m left'
        const total = pair.textContent.split(' / ')[1]!

        // each figure, and the box after it, whose position is what a figure growing would shove
        const cases = [
          { name: 'Download', figure: download!, beside: nextStat(download!), texts: speeds },
          { name: 'Upload', figure: upload!, beside: nextStat(upload!), texts: speeds },
          { name: 'Peak down', figure: peak!, beside: nextStat(peak!), texts: speeds },
          { name: 'size pair', figure: pair, beside: down!, texts: sizes.map((done) => `${done} / ${total}`) },
          { name: 'download speed', figure: down!, beside: up!, texts: speeds.map((value) => `↓ ${value}`) },
          { name: 'upload speed', figure: up!, beside: peers, texts: speeds.map((value) => `↑ ${value}`) },
          { name: 'peer count', figure: peers, beside: timeLeft, texts: counts },
        ]

        const sheet = document.head.appendChild(document.createElement('style'))
        const out: { font: string, name: string, spots: string[] }[] = []
        for (const [font, css] of Object.entries(fonts)) {
          sheet.textContent = css
          for (const { name, figure, beside, texts } of cases) {
            const was = figure.textContent
            const spots = texts.map((text) => {
              figure.textContent = text
              const { left, top } = beside.getBoundingClientRect()
              return `${left},${top}`
            })
            figure.textContent = was
            out.push({ font, name, spots })
          }
        }
        sheet.remove()
        timeLeft.remove()
        return out
      }, { fonts: FONTS, ...figures })

      for (const { font, name, spots } of seen) {
        expect.soft(new Set(spots).size, `${language} at ${width} px, ${font}: what follows the ${name} moved to ${spots.join(' ')}`).toBe(1)
      }
    }
  }
})

const OFFERED: string[] = JSON.parse(readFileSync(new URL('../src/i18n/offered.json', import.meta.url), 'utf8'))
/**
 * The font the header's rows are counted in. A device's own font decides them otherwise: a CI runner's DejaVu
 * Sans put English on two rows at 1280 px, where Noto Sans keeps it on one. Liberation Sans has Arial's widths,
 * and Playwright installs it with Chromium.
 */
const ROWS_FONT = 'Liberation Sans'

/** Where, in ROWS_FONT, the header's words leave the magnet field under its floor at 1280 px, or within 15 px of it. */
const TWO_ROWS_AT_1280 = ['pt-BR', 'ru']

/*
 * The header wraps, and an item more is paid by every language at once: with the VPN's switch in it the account
 * button stood alone on a second row at 1366 px in 9 of the 13 languages, and at 1280 px in 12. The switch is in
 * the strip under it, which is there before the first torrent too.
 */
test('the library\'s header is one row at the widths most laptops have, in every language, with the VPN switch under it', async ({ page }) => {
  test.setTimeout(180_000)
  await page.context().route((url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', (route) => route.abort())
  await page.addInitScript(() => localStorage.setItem('ripple:demo-seeded', '1'))
  const rows: string[] = []
  for (const language of OFFERED) {
    await page.goto('/')
    await page.evaluate(([key, value]) => localStorage.setItem(key!, value!), [LANGUAGE_KEY, language])
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    await page.addStyleTag({ content: `body * { font-family: '${ROWS_FONT}' !important }` })
    // a font the machine lacks falls back in silence: beside monospace, it then measures as monospace does
    const drawn = await page.evaluate((font) => {
      const pen = document.createElement('canvas').getContext('2d')!
      const width = (family: string) => { pen.font = `16px ${family}`; return pen.measureText('Add a magnet link').width }
      return width(`'${font}', monospace`) !== width('monospace')
    }, ROWS_FONT)
    expect(drawn, `${ROWS_FONT} is not on this machine, and the header's rows are counted in it`).toBe(true)
    // the account's button is the last thing the header gets, and the first to take a row of its own
    await page.locator('header iframe').waitFor({ state: 'attached', timeout: 30_000 })
    for (const width of [1366, 1280]) {
      if (width === 1280 && TWO_ROWS_AT_1280.includes(language)) continue
      await page.setViewportSize({ width, height: 720 })
      const tops = await page.locator('header').evaluate((header) => [...header.children]
        .map((child) => child.getBoundingClientRect())
        .filter((box) => box.width > 0)
        .map((box) => Math.round(box.top + box.height / 2)))
      // one row: every item's middle is within a few pixels of the others'
      if (Math.max(...tops) - Math.min(...tops) > 12) rows.push(`${language} at ${width} px: ${tops.join(' ')}`)
      expect(tops.length, `${language}: the header holds fewer items than a visitor's`).toBeGreaterThanOrEqual(5)
    }
  }
  expect(rows, 'the header took a second row').toEqual([])

  // and the switch is on the page with no torrent, under the header: where there is one to draw at all
  await expect(page.locator('.torrent')).toHaveCount(0)
  if (!WEBRTC_PEERS) {
    await expect(page.locator('.stats')).toHaveCount(0)
    return
  }
  const vpn = page.getByRole('switch', { name: /^VPN/ })
  await expect(vpn).toBeVisible()
  expect(await vpn.evaluate((element) => !!element.closest('header'))).toBe(false)
})
