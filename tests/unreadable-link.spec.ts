/*
 * A link whose magnet the engine cannot add: one with no magnet ripple can read, one whose hash is malformed, one that
 * names two torrents. The engine lists no torrent for any of them, so the download page and the player say the link is
 * not a valid one rather than loading for good, and offer nothing that only opens the same link again. On built bytes,
 * headless: nothing here needs a peer, and every request leaving the machine is refused.
 */
import type { Frame, Page } from '@playwright/test'

import { expect, test } from './offline'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { catalogues } from './languages'

const BAD_LINK = 'That is not a valid magnet link'
const OFFERED: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src', 'i18n', 'offered.json'), 'utf8'))
const said = (language: string) => language === 'en' ? BAD_LINK : catalogues()[language]![BAD_LINK]!

const legacy = (magnet: string) => `magnet=${encodeURIComponent(Buffer.from(magnet).toString('base64'))}`
const UNREADABLE = {
  'no magnet ripple can read': 'magnet=not!base64!',
  'a malformed hash': legacy('magnet:?xt=urn:btih:08ada5a7&dn=Broken'),
  'two torrents': legacy(`magnet:?xt=urn:btih:${'1a'.repeat(20)}&xt.1=urn:btih:${'2b'.repeat(20)}&dn=Two`),
}
// THE CONTROL: a torrent nobody serves, which both pages wait on as before
const READABLE = legacy(`magnet:?xt=urn:btih:${'0123456789abcdef'.repeat(2)}01234567&dn=Film`)

/**
 * The player's line is measured in the device's own font (Noto Sans on this machine, DejaVu Sans on GitHub's runner),
 * in a monospace fallback, wider than both, and with a reader's own text spacing, as tests/stable-widths.spec.ts does.
 */
const FONTS: Record<string, string> = {
  'device font': '',
  'monospace fallback': 'body * { font-family: monospace !important }',
  'reader text spacing': 'body * { letter-spacing: 0.12em !important; word-spacing: 0.16em !important }',
}

test('the download page says a link it cannot read is not a valid one, and waits on one it can', async ({ page }) => {
  const card = page.locator('.card')
  for (const [kind, query] of Object.entries(UNREADABLE)) {
    await page.goto(`/download?${query}`)
    await expect(card.locator('.failure'), kind).toHaveText(BAD_LINK)
    await expect(card.locator('.cta'), kind).toHaveText('Nothing to download')
    await expect(card.locator('.cta'), kind).toBeDisabled()
    await expect(card, kind).not.toContainText('Reading the torrent from the network')
    await expect(card.locator('.share'), kind).toHaveCount(0)
  }

  await page.goto(`/download?${READABLE}`)
  await expect(card.locator('.cta')).toHaveText('Loading torrent…')
  await expect(card.locator('.subject .meta')).toHaveText('Reading the torrent from the network')
  await expect(card.locator('.share button')).toHaveCount(2)
  await expect(card.locator('.failure')).toHaveCount(0)
})

test('the download page says it in each of ripple\'s languages', async ({ page }) => {
  test.setTimeout(120_000)
  expect(OFFERED).toHaveLength(27)
  for (const language of OFFERED) {
    await page.goto(`/download?${UNREADABLE['two torrents']}&language=${language}`)
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    await expect(page.locator('.card .failure'), language).toHaveText(said(language))
  }
})

/** Opens `path` in a 900 by 520 frame of a page on another origin, as an embedding site shows it. */
const inAnotherSite = async (page: Page, baseURL: string, path: string) => {
  await page.goto(new URL('/legal', baseURL.replace('127.0.0.1', 'localhost')).href)
  await page.evaluate((src) => {
    document.body.append(Object.assign(document.createElement('iframe'), { id: 'embedded', src, style: 'width:900px;height:520px;border:0' }))
  }, new URL(path, baseURL).href)
  return page.frameLocator('#embedded')
}

test('the download page in another site\'s frame offers no way out to a link it cannot read', async ({ page, baseURL }) => {
  for (const [kind, query] of Object.entries(UNREADABLE)) {
    const frame = await inAnotherSite(page, baseURL!, `/download?${query}`)
    await expect(frame.locator('.card .failure'), kind).toHaveText(BAD_LINK)
    await expect(frame.locator('.note'), kind).toHaveCount(0)
  }

  // THE CONTROL: framed, a link it can read is offered in Ripple, since the site may not let the frame download
  const frame = await inAnotherSite(page, baseURL!, `/download?${READABLE}`)
  await expect(frame.locator('.note a')).toHaveCount(1)
})

test('the player says a link it cannot read is not a valid one, with no way out to it, and waits on one it can', async ({ page }) => {
  const line = page.locator('.loading-information')
  for (const [kind, query] of Object.entries(UNREADABLE)) {
    await page.goto(`/watch?${query}`)
    await expect(line, kind).toHaveText(BAD_LINK)
    await expect(page.getByTestId('open-in-ripple'), kind).toHaveCount(0)
    await expect(page.getByTestId('open-download-page'), kind).toHaveCount(0)
  }

  await page.goto(`/watch?${READABLE}`)
  await expect(page.getByTestId('open-in-ripple')).toBeVisible()
  await expect(page.getByTestId('open-download-page')).toBeVisible()
  await expect(line).toHaveText('Loading metadata…')
})

/**
 * Where the player's line is drawn in each of FONTS, against the screen and the readouts beside it. The readouts are
 * taken as their group's box: the VPN switch's own box is its 40 px pressable area, which reaches past the row.
 */
const measured = (shown: Page | Frame) => shown.evaluate((fonts) => {
  const line = document.querySelector<HTMLElement>('.loading-information')!
  const readouts = document.querySelector('.media-information')!
  const sheet = document.head.appendChild(document.createElement('style'))
  const out = Object.entries(fonts).map(([font, css]) => {
    sheet.textContent = css
    const box = line.getBoundingClientRect()
    const group = readouts.getBoundingClientRect()
    return {
      font,
      off: box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight,
      cut: line.scrollWidth > line.clientWidth + 0.5 || line.scrollHeight > line.clientHeight + 0.5,
      over: group.left < box.right - 0.5 && box.left < group.right - 0.5 && group.top < box.bottom - 0.5 && box.top < group.bottom - 0.5,
    }
  })
  sheet.remove()
  return out
}, FONTS)

const expectFits = async (shown: Page | Frame, where: string) => {
  for (const { font, off, cut, over } of await measured(shown)) {
    expect.soft({ off, cut, over }, `${where}, ${font}`).toEqual({ off: false, cut: false, over: false })
  }
}

test('the player\'s line fits a phone, a desktop and another site\'s frame, in each of ripple\'s languages', async ({ page, baseURL }) => {
  test.setTimeout(240_000)
  for (const language of OFFERED) {
    const watch = `/watch?${UNREADABLE['a malformed hash']}&language=${language}`
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(watch)
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    await expect(page.locator('.loading-information')).toHaveText(said(language))
    await expectFits(page, `${language} at 1280 px`)
    await page.setViewportSize({ width: 360, height: 720 })
    await expectFits(page, `${language} at 360 px`)

    await page.setViewportSize({ width: 1280, height: 720 })
    const frame = await inAnotherSite(page, baseURL!, watch)
    await expect(frame.locator('.loading-information')).toHaveText(said(language))
    await expectFits(page.frames().find((each) => each.url().includes('/watch?'))!, `${language} in a 900 by 520 frame`)
  }

  // THE CONTROL: a line too long for the row is seen
  await page.setViewportSize({ width: 360, height: 720 })
  await page.goto(`/watch?${UNREADABLE['a malformed hash']}`)
  await expect(page.locator('.loading-information')).toHaveText(BAD_LINK)
  await page.locator('.loading-information').evaluate((line) => { line.textContent = 'x'.repeat(120) })
  expect((await measured(page)).every(({ off, cut }) => off || cut)).toBe(true)
})
