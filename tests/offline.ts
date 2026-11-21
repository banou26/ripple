/*
 * `test` and `expect` for the e2e:local specs, in a browser that reaches nothing off this machine. Every local spec
 * imports these (tests/lanes.test.ts checks it); the swarm and rig lanes keep Playwright's own.
 *
 * The published @fkn/lib has https://fkn.app built in as its broker, so the app under test loads fkn.app's frames
 * and reserves a port on a production relay like any visitor. A route() never sees the relay's WebTransport
 * session, so Chromium blocks at its resolver and Firefox routes non-local hosts to a dead loopback SOCKS5 proxy
 * (tests/offline-launch.ts). Measured 2026-11-15 on Chrome 156 and 2026-11-22 on Firefox 1555: fetch, WebSocket and
 * WebTransport to a name, an IPv4 or an IPv6 literal all fail before leaving the machine. WebRTC sends to an address
 * without asking the resolver, so a STUN server named by its address is still reached; ripple names its STUN host,
 * which the block refuses. With no relay to reach, an engine with the VPN on starts only once its 8 s port
 * reservation has given up, so every page starts with the VPN off, whose engine reserves no port, except in the specs
 * VPN_ON names.
 */
import { test as base, expect } from '@playwright/test'
import { basename } from 'node:path'

import { offlineLaunchOptions } from './offline-launch'

export { expect }

// a run against a deployed origin (RIPPLE_TEST_BASE_URL in playwright.config.ts) is meant to reach it
const DEPLOYED = !!process.env.RIPPLE_TEST_BASE_URL

/**
 * The specs that keep the VPN on: those that test the VPN, the relay, inbound peers, the transport or FKN's quota,
 * and handover-rows.spec.ts, which samples a promoted tab's rows for the seconds its engine takes to start.
 */
const VPN_ON = [
  'create-torrent.spec.ts', 'handover-rows.spec.ts', 'home-language.spec.ts', 'name-lookups.spec.ts',
  'vpn-off.spec.ts', 'vpn-surfaces.spec.ts',
]

const isLocal = (url: string) => {
  const { protocol, hostname } = new URL(url)
  return !/^https?:$/.test(protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
}

const reached: string[] = []

export const test = base.extend<{ onlyLocal: void }>({
  // under whatever launchOptions a spec sets, and first, so a spec that names rules or prefs of its own replaces these
  browser: [async ({ playwright, browserName, launchOptions }, use) => {
    const offline = !DEPLOYED && (browserName === 'chromium' || browserName === 'firefox')
    const browser = await playwright[browserName].launch(offlineLaunchOptions(browserName, launchOptions, DEPLOYED))
    // every context a spec opens, and the default one, which Playwright opens through this too
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async (options) => {
      const context = await newContext(options)
      context.on('response', (response) => { if (!isLocal(response.url())) reached.push(response.url()) })
      if (offline && !VPN_ON.includes(basename(base.info().file))) {
        await context.addInitScript(() => { try { localStorage.setItem('ripple:vpn', 'off') } catch { /* a frame with no storage */ } })
      }
      return context
    }
    await use(browser)
    await browser.close()
  }, { scope: 'worker', timeout: 0 }],
  // the app still asks for fkn.app on every page and the block refuses it, so a response is a request that got past
  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies off this pattern
  onlyLocal: [async ({}, use) => {
    reached.length = 0
    await use()
    if (!DEPLOYED) expect(reached, 'a request reached past this machine').toEqual([])
  }, { auto: true }],
})
