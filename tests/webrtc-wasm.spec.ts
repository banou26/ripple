/*
 * The WebRTC stack of the VPN on mode is 3 MB of wasm that the engine worker fetches as a file of its own, by a
 * path only the worker's bytes name. A file that is missing answers the app's HTML with a 200 here and on the
 * site, so nothing but compiling it tells: on ripple's own site, and under the fkn.app tenant's policy
 * (fkn-client `sandbox/src/shared/tenant.ts`), the strictest host ripple runs on.
 */
import { expect, test } from '@playwright/test'

import { WEBRTC_PEERS } from '../src/torrent/vpn-config'

// with the one constant that stops WebRTC peers, the bundler leaves the stack out of the worker: nothing names it
test.skip(!WEBRTC_PEERS, 'WebRTC peers are stopped in this build')

const TENANT_CSP = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'self'"

for (const tenant of [false, true]) {
  test(`the WebRTC stack the engine worker fetches is served and compiles${tenant ? ' under the tenant policy' : ''}`, async ({ browser, baseURL, request }) => {
    const entry = await (await request.get('/index.js')).text()
    const worker = /\/assets\/worker-[\w-]+\.js/.exec(entry)?.[0]
    expect(worker, 'the entry names no engine worker').toBeDefined()
    const wasm = /\/assets\/webrtc-[\w-]+\.wasm/.exec(await (await request.get(worker!)).text())?.[0]
    expect(wasm, 'the engine worker names no WebRTC wasm').toBeDefined()

    // no service worker, so the policy below lands on the document that is drawn
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    if (tenant) {
      await page.route((url) => url.origin === new URL(baseURL!).origin, async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': TENANT_CSP } })
      })
    }
    await page.goto('/')

    const got = await page.evaluate(async (path) => {
      const response = await fetch(path)
      const bytes = await response.arrayBuffer()
      const exports = await WebAssembly.compile(bytes).then((module) => WebAssembly.Module.exports(module).length, () => -1)
      // the control for the policy: it refuses eval and lets wasm through
      let evaluated = true
      try { new Function('return 1')() } catch { evaluated = false }
      return { status: response.status, bytes: bytes.byteLength, exports, evaluated }
    }, wasm!)

    expect(got.evaluated, tenant ? 'the tenant policy is not in force' : 'the page has a policy nobody set').toBe(!tenant)
    expect(got.status).toBe(200)
    expect(got.bytes).toBeGreaterThan(1_000_000)
    expect(got.exports, 'what the path answers is not wasm').toBeGreaterThan(0)
    // requests of the page still under way are not this test's
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await context.close()
  })
}
