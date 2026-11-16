import type { Page } from '@playwright/test'

/**
 * An init script that hides the service worker's control of a page while `window.__hidden` is set, which it is from
 * the start. A download link opened as its own page starts its save by itself only under a controller, so a test of a
 * page that waits for its button runs this.
 */
export const hideController = () => {
  const w = window as any
  w.__hidden = true
  // oxlint-disable-next-line typescript/unbound-method
  const controller = Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, 'controller')!.get!
  Object.defineProperty(ServiceWorkerContainer.prototype, 'controller', {
    configurable: true,
    get () { return w.__hidden ? null : controller.call(this) },
  })
}

/**
 * Gives a page under `hideController` its controller back, so a press takes the worker's arm. With no controllerchange
 * the page does not start a save by itself.
 */
export const showController = async (page: Page) => {
  await page.evaluate(() => { (window as any).__hidden = false })
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 })
}
