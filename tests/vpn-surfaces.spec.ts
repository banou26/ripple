/*
 * Each surface keeps its own choice of the VPN, because each has its own browser storage: ripple's own tabs share
 * one (the library, a share link's download page, a player opened in a tab), and a player another site frames has
 * the storage the browser keeps apart for that site, as stub frames it. "Remember this decision" stays with the
 * storage it was ticked in too.
 *
 * No torrent here finds anybody and no engine reaches anything: every name but this machine's resolves to nothing.
 */
import type { Frame, Page } from '@playwright/test'

import { expect, test } from './offline'

import { WEBRTC_PEERS } from '../src/torrent/vpn-config'
import { PARTITIONED } from './partitioned'

// the one constant that stops WebRTC peers takes the switch away, and nothing here to drive
test.skip(!WEBRTC_PEERS, 'WebRTC peers are stopped in this build')

test.use({
  launchOptions: {
    executablePath: process.env.RIPPLE_CHROME || undefined,
    args: ['--mute-audio', ...PARTITIONED.args],
    ignoreDefaultArgs: PARTITIONED.ignoreDefaultArgs,
  },
})

const SENTENCE = 'Peers and trackers of every running torrent will see your IP address.'
const WATCH = `/watch?magnet=${encodeURIComponent(btoa(`magnet:?xt=urn:btih:${'f'.repeat(40)}&dn=Film`))}`

const stored = (scope: Page | Frame) =>
  scope.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('ripple:vpn'))))
const vpnOf = (scope: Pick<Page, 'getByRole'>) => scope.getByRole('switch', { name: /^VPN/ })

test('the choice and its Remember this decision stay with the storage they were made in', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const ripple = new URL(baseURL!).origin
  // a device in no listed country, so the warning is its one sentence wherever this runs
  const context = await browser.newContext({ timezoneId: 'Europe/Stockholm' })
  await context.addInitScript(() => { try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* a frame refused storage */ } })

  // a player in a tab of ripple's own: off, and not to be asked again
  const own = await context.newPage()
  await own.goto(WATCH)
  await expect(vpnOf(own)).toHaveAttribute('aria-checked', 'true')
  await vpnOf(own).click()
  const asked = own.getByRole('dialog')
  await expect(asked.locator('p')).toHaveText([SENTENCE])
  await asked.getByRole('checkbox', { name: 'Remember this decision' }).check()
  await asked.getByRole('button', { name: 'Turn off' }).click()
  await expect(vpnOf(own)).toHaveAttribute('aria-checked', 'false')
  expect(await stored(own)).toEqual({ 'ripple:vpn': 'off', 'ripple:vpn-off-remembered': '1' })

  // a share link's download page and the library read that storage too: off, and nothing asked
  const download = await context.newPage()
  await download.goto(WATCH.replace('/watch', '/download'))
  await expect(vpnOf(download)).toHaveAttribute('aria-checked', 'false')
  const library = await context.newPage()
  await library.goto('/')
  await expect(vpnOf(library)).toHaveAttribute('aria-checked', 'false')
  await vpnOf(library).click()
  await expect(vpnOf(library)).toHaveAttribute('aria-checked', 'true')
  // the other tabs follow a change one of them made
  await expect(vpnOf(own)).toHaveAttribute('aria-checked', 'true')
  await expect(vpnOf(download)).toHaveAttribute('aria-checked', 'true')
  await vpnOf(library).click()
  await expect(library.getByRole('dialog'), 'asked again although the decision was remembered').toHaveCount(0)
  await expect(vpnOf(own)).toHaveAttribute('aria-checked', 'false')

  // the same player framed by another site: this server under another name is another site
  const host = await context.newPage()
  const top = new URL('/README.md', ripple)
  top.hostname = 'localhost'
  await host.goto(top.href)
  await host.evaluate((src) => {
    const iframe = document.createElement('iframe')
    iframe.src = src
    iframe.allow = 'autoplay; fullscreen'
    iframe.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0'
    document.body.append(iframe)
  }, `${ripple}${WATCH}`)
  await expect.poll(() => host.frames().find((frame) => frame !== host.mainFrame() && frame.url().startsWith(ripple))).toBeTruthy()
  const framed = host.frames().find((frame) => frame !== host.mainFrame() && frame.url().startsWith(ripple))!
  const player = host.frameLocator('iframe')
  await expect(vpnOf(player)).toBeVisible({ timeout: 30_000 })
  // THE CONTROL: the frame's storage is not the one ripple's tabs just wrote to
  expect(await stored(framed), 'the frame is not partitioned, so this proves nothing').toEqual({})
  await expect(vpnOf(player)).toHaveAttribute('aria-checked', 'true')

  // so it asks, inside the player, and what is answered there stays there
  await vpnOf(player).click()
  const framedWarning = player.getByRole('dialog')
  await expect(framedWarning.locator('p')).toHaveText([SENTENCE])
  await framedWarning.getByRole('button', { name: 'Turn off' }).click()
  await expect(vpnOf(player)).toHaveAttribute('aria-checked', 'false')
  expect(await stored(framed)).toEqual({ 'ripple:vpn': 'off' })

  await vpnOf(library).click()
  await expect(vpnOf(library)).toHaveAttribute('aria-checked', 'true')
  expect(await stored(library)).toEqual({ 'ripple:vpn-off-remembered': '1' })
  await expect(vpnOf(player)).toHaveAttribute('aria-checked', 'false')
  // and it asks again there, having remembered nothing
  await vpnOf(player).click()
  await expect(vpnOf(player)).toHaveAttribute('aria-checked', 'true')
  await vpnOf(player).click()
  await expect(framedWarning.locator('p')).toHaveText([SENTENCE])
  await framedWarning.getByRole('button', { name: 'Cancel' }).click()
  await expect(vpnOf(player)).toHaveAttribute('aria-checked', 'true')
  expect(await stored(framed)).toEqual({})
  expect(await stored(library)).toEqual({ 'ripple:vpn-off-remembered': '1' })
})

// a fullscreen element shows nothing outside itself, and a player is where a person is most often fullscreen
test('a player in fullscreen shows the warning, drawn inside it, and stays fullscreen once it is answered', async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ timezoneId: 'Europe/Stockholm' })
  const page = await context.newPage()
  await page.goto(WATCH)
  await expect(vpnOf(page)).toBeVisible({ timeout: 30_000 })
  await page.locator('button.full-screen').click()
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)

  await vpnOf(page).click()
  const warning = page.getByRole('dialog')
  await expect(warning.locator('p')).toHaveText([SENTENCE])
  expect(await page.evaluate(() => document.fullscreenElement!.contains(document.querySelector('[role="dialog"]')))).toBe(true)
  // a real click: the action is on screen and nothing of the player covers it
  await warning.getByRole('button', { name: 'Turn off' }).click()
  await expect(warning).toHaveCount(0)
  await expect(vpnOf(page)).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => !!document.fullscreenElement), 'answering took the player out of fullscreen').toBe(true)
})
