/*
 * `test` and `expect` for the e2e:local specs, in a browser that reaches nothing off this machine. Every local spec
 * imports these (tests/lanes.test.ts checks it); the swarm and rig lanes keep Playwright's own.
 *
 * The published @fkn/lib has https://fkn.app built in as its broker, so the app under test loads fkn.app's frames
 * and reserves a port on a production relay like any visitor. A route() never sees the relay's WebTransport
 * session, so Chromium blocks at its resolver, Firefox routes non-local hosts to a dead loopback SOCKS5 proxy, and
 * WebKit routes non-local hosts to a dead loopback HTTP proxy (tests/offline-launch.ts). Measured 2026-11-15 on
 * Chrome 156, 2026-11-22 on Firefox 1555, and 2026-11-28 on WebKit 26.5 (build 2311): fetch to a name, an IPv4 or an
 * IPv6 literal, WebSocket, and cross-origin iframes fail in 1 to 50 ms before leaving the machine. WebRTC sends to an address
 * without asking the resolver, so a STUN server named by its address is still reached; ripple names its STUN host,
 * which the block refuses. With no relay to reach, an engine with the VPN on starts only once its 8 s port
 * reservation has given up, so every page starts with the VPN off, whose engine reserves no port, except in the specs
 * VPN_ON names.
 */
import type { BrowserContext } from '@playwright/test'
import { test as base, expect } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { offlineLaunchOptions } from './offline-launch'

export { expect }

/**
 * Grants clipboard permissions suited to the engine: WebKit allows clipboard writes natively, rejects `clipboard-write`
 * as an unknown permission name, and accepts `clipboard-read`.
 */
export const grantClipboard = (context: BrowserContext, browserName: string, options?: { origin?: string }) =>
  context.grantPermissions(browserName === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write'], options)

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

const definedEnv = (entries: NodeJS.ProcessEnv | Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> =>
  Object.fromEntries(Object.entries(entries ?? {}).filter((pair): pair is [string, string | number | boolean] => pair[1] !== undefined))

export const test = base.extend<{ onlyLocal: void }>({
  // under whatever launchOptions a spec sets, and first, so a spec that names rules or prefs of its own replaces these
  browser: [async ({ playwright, browserName, launchOptions }, use) => {
    const effectiveLaunch = offlineLaunchOptions(browserName, launchOptions, DEPLOYED)
    const offline = !DEPLOYED && (browserName === 'chromium' || browserName === 'firefox' || browserName === 'webkit')
    const browser = await playwright[browserName].launch(effectiveLaunch)
    // every context a spec opens, and the default one, which Playwright opens through this too
    const newContext = browser.newContext.bind(browser)
    const persistent = new Set<{ context: BrowserContext, dir: string }>()
    browser.newContext = async (options) => {
      let context: BrowserContext
      if (browserName === 'webkit') {
        const dir = mkdtempSync(join(tmpdir(), 'ripple-wk-'))
        // macOS WebKit's ephemeral browser.newContext() rejects navigator.storage.getDirectory(), while a persistent
        // context shares OPFS under ~/Library/WebKit/org.webkit.Playwright unless CFFIXED_USER_HOME isolates it per context
        const env = process.platform === 'darwin'
          ? { ...definedEnv(process.env), ...definedEnv(effectiveLaunch.env), CFFIXED_USER_HOME: dir }
          : effectiveLaunch.env
        context = await playwright.webkit.launchPersistentContext(dir, {
          ...effectiveLaunch,
          ...options,
          ...(env ? { env } : {}),
        })
        const entry = { context, dir }
        persistent.add(entry)
        const close = context.close.bind(context)
        context.close = async (closeOptions) => {
          persistent.delete(entry)
          try { await close(closeOptions) } finally { rmSync(dir, { recursive: true, force: true }) }
        }
        const openPage = context.newPage.bind(context)
        let initialUsed = false
        context.newPage = async () => {
          if (!initialUsed) {
            initialUsed = true
            const initial = context.pages()[0]
            if (initial && !initial.isClosed() && initial.url() === 'about:blank') return initial
          }
          return openPage()
        }
      } else {
        context = await newContext(options)
      }
      context.on('response', (response) => { if (!isLocal(response.url())) reached.push(response.url()) })
      if (offline && !VPN_ON.includes(basename(base.info().file))) {
        await context.addInitScript(() => { try { localStorage.setItem('ripple:vpn', 'off') } catch { /* a frame with no storage */ } })
      }
      return context
    }
    try {
      await use(browser)
    } finally {
      for (const entry of [...persistent]) {
        try { await entry.context.close() } catch { rmSync(entry.dir, { recursive: true, force: true }) }
      }
      await browser.close()
    }
  }, { scope: 'worker', timeout: 0 }],
  // the app still asks for fkn.app on every page and the block refuses it, so a response is a request that got past
  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies off this pattern
  onlyLocal: [async ({}, use) => {
    reached.length = 0
    await use()
    if (!DEPLOYED) expect(reached, 'a request reached past this machine').toEqual([])
  }, { auto: true }],
})
