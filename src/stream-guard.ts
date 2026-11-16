/** The path the service worker answers a save under. src/sw.js names it too, since it cannot import. */
export const STREAM_PREFIX = '/__ripple-stream/'

/*
 * Imported first by index.tsx, so the throw stops every module after it. The save frame runs scripts, which WebKit
 * needs before it sends a frame to the service worker, so a save address the worker did not claim gets this app
 * from the server, and a second copy in that frame would fight the page's for the storage locks. Opened as a page
 * of its own, an expired save address goes on to the library like any other unknown one.
 */
if (globalThis.location?.pathname.startsWith(STREAM_PREFIX) && globalThis.top !== globalThis.self) {
  throw new Error(`Ripple does not start under ${STREAM_PREFIX}`)
}
