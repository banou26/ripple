/*
 * The guard in tests/offline.ts fails a test whose browser got an answer from off this machine, so each test.fail
 * here is expected to fail. The answer is a route's, so nothing leaves the machine, and nothing in a body may throw:
 * the guard is then the only thing that can fail it.
 */
import { expect, test } from './offline'

import { WEBRTC_PEERS } from '../src/torrent/vpn-config'

const OUTSIDE = 'http://outside.test/'

test.skip(!!process.env.RIPPLE_TEST_BASE_URL, 'the guard is off in a run against a deployed origin')

test('a page starts with the VPN off, in the default context and in one the test opens', async ({ page, browser }) => {
  test.skip(!WEBRTC_PEERS, 'WebRTC peers are stopped in this build, and the VPN with them can be nothing but on')
  const opened = await (await browser.newContext()).newPage()
  for (const each of [page, opened]) {
    await each.goto('/')
    await expect(each.getByRole('switch', { name: /^VPN/ })).toHaveAttribute('aria-checked', 'false')
  }
  await opened.context().close()
})

test.fail('an answer from off the machine fails the test', async ({ page }) => {
  await page.route(OUTSIDE, (route) => route.fulfill({ body: 'outside' }))
  await page.goto(OUTSIDE).catch(() => {})
})

test.fail('so does one in a context the test opens itself', async ({ browser }) => {
  const context = await browser.newContext()
  await context.route(OUTSIDE, (route) => route.fulfill({ body: 'outside' }))
  await (await context.newPage()).goto(OUTSIDE).catch(() => {})
  await context.close()
})
