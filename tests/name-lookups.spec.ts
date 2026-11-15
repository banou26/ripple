/*
 * Which hosts the browser reaches for an engine's name lookups, in each mode: none of its own.
 *
 * The engine looks up the names of trackers, web seeds and the DHT's first nodes. Left to itself it asks
 * https://1.1.1.1/dns-query from its worker, which shows Cloudflare the person's address beside each name. With
 * the VPN on the relay looks them up; with it off the engine looks nothing up, and the browser resolves the
 * WebSocket trackers' names as it resolves any site's.
 *
 * Every connection the browser makes off this machine goes to a proxy that refuses it and notes its host, so the
 * list is the page's, its workers' and the service worker's alike, and nothing leaves the machine.
 */
import type { Browser } from '@playwright/test'

import { expect, test } from './offline'

import { TRACKERS, WEBRTC_PEERS } from '../src/torrent/vpn-config'
import { startProxy } from './name-lookups/proxy.mjs'

test.use({ launchOptions: { executablePath: process.env.RIPPLE_CHROME || undefined, args: ['--mute-audio'] } })

const DNS_OVER_HTTPS = '1.1.1.1'
// two names only a lookup can turn into an address: a tracker over UDP and one over HTTP
const MAGNET = `magnet:?xt=urn:btih:${'b'.repeat(40)}&tr=${encodeURIComponent('udp://tracker.ripple-names.test:6969/announce')}&tr=${encodeURIComponent('http://tracker.ripple-names.test/announce')}`

let proxy: Awaited<ReturnType<typeof startProxy>>
test.beforeEach(async () => { proxy = await startProxy() })
test.afterEach(async () => { await proxy.close() })

/** Opens the library with the VPN as `vpn`, adds the magnet, and returns the hosts asked for once its engine has run. */
const hostsReached = async (browser: Browser, baseURL: string, vpn: 'on' | 'off') => {
  // playwright sends loopback through a proxy too unless told otherwise, and the app is served from it
  const context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '127.0.0.1' } })
  const page = await context.newPage()
  await page.addInitScript((choice) => {
    const seen: string[] = (window as any).__transports = []
    try {
      localStorage.setItem('ripple:demo-seeded', '1')
      if (choice === 'off') localStorage.setItem('ripple:vpn', 'off')
    } catch { /* a page with no storage starts no engine either */ }
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor (url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', ({ data }: MessageEvent) => { if (data?.type === 'state' && !seen.includes(data.transport)) seen.push(data.transport) })
      }
    }
  }, vpn)
  await page.goto(baseURL)
  await page.getByPlaceholder('Add a magnet link').fill(MAGNET)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.torrent')).toHaveCount(1, { timeout: 30_000 })
  // an engine behind a relay out of reach starts once its port reservation has given up
  await expect
    .poll(() => page.evaluate(() => (window as any).__transports as string[]), { timeout: 60_000, message: 'no engine said what it runs on' })
    .toEqual([vpn === 'off' && WEBRTC_PEERS ? 'direct' : 'relay'])
  // the engine asks for a tracker's name as it starts the torrent, and for the DHT's first nodes as it starts
  await page.waitForTimeout(10_000)
  const hosts = proxy.hosts()
  await context.close()
  return hosts
}

test('with the VPN on, the engine asks 1.1.1.1 for no name: the relay looks them up', async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const hosts = await hostsReached(browser, baseURL!, 'on')
  console.log(`[name-lookups] VPN on: ${hosts.join(', ')}`)
  // the proxy heard this browser: FKN's frame is the page's first request off the machine
  expect(hosts).toContain('fkn.app')
  expect(hosts).not.toContain(DNS_OVER_HTTPS)
})

test('with the VPN off, the engine looks no name up, and the browser reaches the trackers by name', async ({ browser, baseURL }) => {
  test.skip(!WEBRTC_PEERS, 'WebRTC peers are stopped in this build')
  test.setTimeout(120_000)
  const hosts = await hostsReached(browser, baseURL!, 'off')
  console.log(`[name-lookups] VPN off: ${hosts.join(', ')}`)
  // the proxy heard the engine's worker: the trackers' sockets are opened from it
  for (const tracker of TRACKERS) expect(hosts).toContain(new URL(tracker).hostname)
  expect(hosts).not.toContain(DNS_OVER_HTTPS)
  expect(hosts.filter((host) => host.endsWith('ripple-names.test')), 'a tracker only the engine could use was asked for').toEqual([])
})
