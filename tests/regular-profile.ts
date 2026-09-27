/**
 * `test` and `expect` for a spec whose app stores a FileSystemHandle, run in a REGULAR profile.
 *
 * Playwright's own `context` fixture is `browser.newContext()`, an off-the-record profile, the kind
 * an incognito window gets. On Chrome 153.0.8010.47 (measured 2026-09-27) reading a FileSystemHandle
 * back out of IndexedDB in such a profile takes the whole browser process down with SIGTRAP: the
 * `put` succeeds, and the next `get`, `getAll` or cursor that returns it crashes. File or directory,
 * OPFS or a real dropped folder, page or worker, all the same. A persistent profile on the same
 * build reads it back fine, and so does Chrome for Testing 149 in both. Chromium issue 562119515.
 *
 * Creating from a folder stores the pick's root and reads it back at once, so every spec that stubs
 * a picker with a real handle died at "Create and start sharing" on 153, with nothing wrong in the
 * app. `tests/regular-profile.test.ts` holds each of those specs to this import.
 *
 * Same launch options and device as the project, and a fresh temporary profile per test, removed on
 * close, so tests stay as isolated as they were. No automatic trace: that is tied to the stock
 * context fixture.
 */
import type { BrowserContext, Page } from '@playwright/test'
import { test as base } from '@playwright/test'

export { expect } from '@playwright/test'

export const test = base.extend<{ context: BrowserContext, page: Page }>({
  context: async ({
    playwright, browserName, launchOptions, headless, baseURL, viewport, userAgent, deviceScaleFactor,
    isMobile, hasTouch, acceptDownloads, contextOptions,
  }, use) => {
    // an empty path is a new temporary profile that Playwright deletes again on close
    const context = await playwright[browserName].launchPersistentContext('', {
      ...launchOptions,
      ...contextOptions,
      headless,
      baseURL,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      acceptDownloads,
    })
    await use(context)
    await context.close()
  },
  // a persistent context opens with one tab already, and the stock fixture would add a second
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? await context.newPage())
  },
})
