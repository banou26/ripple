/*
 * `test` and `expect` for the e2e:local specs, in a browser that reaches nothing off this machine. Every local spec
 * imports these but the few tests/lanes.test.ts names as needing the network; the swarm and rig lanes keep
 * Playwright's own.
 *
 * The published @fkn/lib has https://fkn.app built in as its broker, so the app under test loads fkn.app's frames
 * and reserves a port on a production relay like any visitor. A route() never sees the relay's WebTransport
 * session, so the block is Chromium's resolver: every name and address but loopback resolves to nothing, before a
 * socket opens. Measured 2026-11-15 on Chrome 156: fetch, WebSocket and WebTransport to a name, an IPv4 or an IPv6
 * literal all fail as net::ERR_NAME_NOT_RESOLVED. WebRTC sends to an address without asking the resolver, so a STUN
 * server named by its address is still reached; ripple names its STUN host, which the resolver refuses. With no
 * relay to reach, each engine start waits out its 8 s port reservation.
 */
import { test as base, expect } from '@playwright/test'

export { expect }

const OFFLINE = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'
// a run against a deployed origin (RIPPLE_TEST_BASE_URL in playwright.config.ts) is meant to reach it
const DEPLOYED = !!process.env.RIPPLE_TEST_BASE_URL

const isLocal = (url: string) => {
  const { protocol, hostname } = new URL(url)
  return !/^https?:$/.test(protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
}

export const test = base.extend<{ onlyLocal: void }>({
  // under whatever launchOptions a spec sets, and first, so a spec that names rules of its own replaces these
  browser: [async ({ playwright, browserName, launchOptions }, use) => {
    const browser = await playwright[browserName].launch(browserName === 'chromium' && !DEPLOYED ? { args: [OFFLINE, ...(launchOptions.args ?? [])] } : {})
    await use(browser)
    await browser.close()
  }, { scope: 'worker', timeout: 0 }],
  // the app still asks for fkn.app on every page and the block refuses it, so a response is a request that got past
  onlyLocal: [async ({ context }, use) => {
    const reached: string[] = []
    context.on('response', (response) => { if (!isLocal(response.url())) reached.push(response.url()) })
    await use()
    if (!DEPLOYED) expect(reached, 'a request reached past this machine').toEqual([])
  }, { auto: true }],
})
