// Copied by the build rather than bundled, so it cannot import. `scripts/build-sw.mjs` replaces the
// three @stamp lines below and refuses to ship a worker where any of them is still a placeholder.

const PREFIX = new URL('/__ripple-stream/', self.location.href).href

const live = new Map()

/* Stamped at build time. These are the dev defaults and must never reach production: a worker whose
   BUILD never changes is never reinstalled, so the update this feature announces would never fire. */
const MODE = 'dev'    // @stamp:mode
const BUILD = 'dev'   // @stamp:build
const MANIFEST = []   // @stamp:manifest

const CACHE = 'ripple-assets-' + BUILD

/**
 * Which requests this worker may answer from its cache, and the whole of it.
 *
 * ONLY hash-named JavaScript chunks. Never the document, never /index.js, never /sw.js. That
 * narrowness is the design, not a shortcut:
 *
 *  - A hashed path names its BYTES, so a hit from any build is correct by construction. There is no
 *    stale-content failure available here, only a hit or a miss.
 *  - Everything else stays on the network, which means a bad build is always replaceable by the next
 *    deploy. A worker that served the document from cache could pin somebody to a broken build with
 *    no page JavaScript left to run the update check, and nothing short of clearing site data would
 *    get them out.
 *
 * It exists because a deploy rotates these filenames and Cloudflare answers the old path with the
 * SPA fallback: 200, text/html, which the browser then runs as a module worker. Measured against
 * production, an earlier build's chunk is byte-identical to one that never existed.
 */
const HASHED = /^\/(?:assets\/)?[A-Za-z0-9_.$-]+-[A-Za-z0-9_-]{8,}\.js$/

self.addEventListener('install', (event) => {
  // PURGE is the remote kill switch: ship src/sw.mode as `purge` and the next deploy's worker takes
  // over at once, deletes every cache, and answers nothing. It needs no cooperation from the page.
  if (MODE === 'purge') { self.skipWaiting(); return }
  /*
   * No skipWaiting. A new worker installs and WAITS, so a page keeps the build it loaded with until
   * somebody presses Update. That is the opposite of what this worker used to do, and it is the
   * point: taking over immediately is what would swap the chunk set under a running engine.
   */
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(MANIFEST.map(([path]) => path)))
      // A failed precache must not fail the install. The worker still routes and still fills the
      // cache on demand; a rejected install would leave the origin with no worker at all, which is
      // strictly worse than one with a cold cache.
      .catch(() => undefined),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (MODE === 'purge') {
      for (const key of await caches.keys()) await caches.delete(key)
      await self.clients.claim()
      return
    }
    // every generation but this one: a hashed chunk is immutable, so old generations are only ever
    // wasted room, never wrong answers
    for (const key of await caches.keys()) {
      if (key.startsWith('ripple-assets-') && key !== CACHE) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data) return
  if (data.type === 'stream-open') {
    const port = event.ports[0]
    if (!port) return
    live.set(data.id, { name: data.name, size: data.size, port, resolvePull: null })
    port.postMessage({ type: 'stream-ready' })
    return
  }
  // Answered only while the download is still live: a worker killed mid-download comes back with an empty map.
  if (data.type === 'ping' && live.has(data.id) && event.source) {
    event.source.postMessage({ type: 'pong', id: data.id })
    return
  }
  // Pressed Update. Only a WAITING worker ever receives this, and taking over fires controllerchange
  // in every open page, which is what reloads them all together.
  if (data.type === 'take-over') self.skipWaiting()
  if (data.type === 'which-build' && event.source) {
    event.source.postMessage({ type: 'build', build: BUILD, mode: MODE })
  }
})

const disposition = (name) => {
  const safe = String(name || 'download').replace(/[\r\n"\\]/g, '_')
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name || 'download')}`
}

self.addEventListener('fetch', (event) => {
  const url = event.request.url

  /*
   * The cache route. Checked BEFORE the stream prefix bails out, and deliberately after nothing:
   * the two never overlap, since a stream URL is under /__ripple-stream/ and can never match a
   * hashed .js path.
   *
   * Cache first, network second, and a miss simply proxies, which is byte-identical to not
   * intercepting at all. Only same-origin GETs, so a request to any other host is untouched.
   */
  if (MODE !== 'purge' && event.request.method === 'GET' && !url.startsWith(PREFIX)) {
    const path = new URL(url).pathname
    if (new URL(url).origin === self.location.origin && HASHED.test(path)) {
      event.respondWith((async () => {
        const cache = await caches.open(CACHE)
        const hit = await cache.match(path)
        if (hit) return hit
        const fresh = await fetch(event.request)
        // An HTML answer here IS the bug this worker exists for: the chunk is gone and Cloudflare
        // served the SPA fallback with a 200. Never store that, or the cache would preserve the
        // failure across the very reload meant to cure it.
        const type = fresh.headers.get('content-type') || ''
        if (fresh.ok && type.includes('javascript')) await cache.put(path, fresh.clone())
        return fresh
      })())
      return
    }
  }

  if (!url.startsWith(PREFIX)) return

  const id = url.slice(PREFIX.length).split('/')[0]
  const entry = live.get(id)
  // Answered rather than left to fall through: an unclaimed synthetic URL would be served the app's own HTML.
  if (!entry) {
    event.respondWith(new Response('Unknown download', { status: 404 }))
    return
  }

  const finish = () => {
    if (entry.done) return
    entry.done = true
    live.delete(id)
    const resolve = entry.resolvePull
    entry.resolvePull = null
    if (resolve) resolve()
  }

  const body = new ReadableStream({
    start(controller) {
      entry.port.onmessage = (e) => {
        const msg = e.data
        if (!msg || entry.done) return
        if (msg.type === 'chunk') {
          controller.enqueue(msg.data)
          const resolve = entry.resolvePull
          entry.resolvePull = null
          if (resolve) resolve()
          return
        }
        if (msg.type === 'end') {
          controller.close()
          finish()
          return
        }
        if (msg.type === 'abort') {
          controller.error(new Error(msg.reason || 'aborted'))
          finish()
        }
      }
    },
    // Returning a promise that only settles once the chunk arrives is what creates the backpressure.
    pull() {
      return new Promise((resolve) => {
        entry.resolvePull = resolve
        entry.port.postMessage({ type: 'pull' })
      })
    },
    cancel(reason) {
      entry.port.postMessage({ type: 'cancel', reason: String(reason) })
      finish()
    },
  })

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': disposition(entry.name),
    'Cache-Control': 'no-store',
  }
  // Only when it is known exactly: a zip's length is not known until it has been written.
  if (entry.size > 0) headers['Content-Length'] = String(entry.size)

  event.respondWith(new Response(body, { headers }))
})
