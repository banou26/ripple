/*
 * The guard in tests/offline.ts fails a test whose browser got an answer from off this machine, so each of these is
 * expected to fail. The answer is a route's, so nothing leaves the machine, and nothing in a body may throw: the
 * guard is then the only thing that can fail it.
 */
import { test } from './offline'

const OUTSIDE = 'http://outside.test/'

test.skip(!!process.env.RIPPLE_TEST_BASE_URL, 'the guard is off in a run against a deployed origin')

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
