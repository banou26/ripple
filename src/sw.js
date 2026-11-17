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
/** Holds the name of the generation that activated last, so the next activation can keep it. */
const ACTIVE = 'ripple-active'

/**
 * Which requests this worker may answer from its cache, and the whole of it.
 *
 * ONLY hash-named JavaScript chunks, the entry among them, and the engine's wasm. Never the document,
 * never /sw.js, never the WebRTC stack's 3 MB of wasm. That narrowness is the design, not a shortcut:
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
const HASHED = /^\/(?:(?:assets\/)?[A-Za-z0-9_.$-]+-[A-Za-z0-9_-]{8}\.js|assets\/libtorrent-[A-Za-z0-9_-]{8}\.wasm)$/

// An HTML answer for a chunk path is Cloudflare's SPA fallback for a chunk that is gone, not the chunk.
const isChunk = (response) => response.ok && /javascript|wasm/.test(response.headers.get('content-type') || '')

const PRECACHE_ATTEMPTS = 3

/** Resolves once every manifest chunk is stored, asking again only for the ones that failed. */
const precache = async () => {
  const cache = await caches.open(CACHE)
  let missing = MANIFEST.map(([path]) => path)
  for (let attempt = 0; attempt < PRECACHE_ATTEMPTS && missing.length > 0; attempt++) {
    const failed = await Promise.all(missing.map(async (path) => {
      try {
        const response = await fetch(path)
        if (!isChunk(response)) return path
        await cache.put(path, response)
        return null
      } catch {
        return path
      }
    }))
    missing = failed.filter((path) => path !== null)
  }
  if (missing.length > 0) throw new Error('precache incomplete: ' + missing.join(', '))
}

self.addEventListener('install', (event) => {
  // PURGE is the remote kill switch: ship src/sw.mode as `purge` and the next deploy's worker takes
  // over at once, deletes every cache, and answers nothing. It needs no cooperation from the page.
  if (MODE === 'purge') { self.skipWaiting(); return }
  /*
   * No skipWaiting: a new worker installs and WAITS, and the page decides when it takes over.
   *
   * An installed worker is what the page reads as "the update is downloaded", so with a worker
   * already active an incomplete precache fails the install: the browser drops this worker and
   * installs it again at its next update check, while the active one keeps serving. The first
   * install never fails on it, because an origin with no worker at all is worse than one whose
   * cache fills on demand.
   */
  event.waitUntil(precache().catch((error) => {
    if (self.registration.active) throw error
  }))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (MODE === 'purge') {
      for (const key of await caches.keys()) await caches.delete(key)
      await self.clients.claim()
      return
    }
    /*
     * Every generation but this one and the one active before it. A page the update gate leaves on
     * the previous build (held by a save or a video, or framed by another page) still loads its lazy
     * chunks, the torrent engine's included, and this worker controls it from the claim below. Older
     * generations are only wasted room: a hashed chunk is immutable, so none of them is ever wrong.
     * With no record yet (the first activation that keeps one) nothing is deleted.
     */
    const record = await caches.open(ACTIVE)
    const previous = await (await record.match('/'))?.text()
    if (previous !== undefined) {
      for (const key of await caches.keys()) {
        if (key.startsWith('ripple-assets-') && key !== CACHE && key !== previous) await caches.delete(key)
      }
    }
    await record.put('/', new Response(CACHE))
    await self.clients.claim()
  })())
})

/*
 * Chrome keeps a page that left mid-save in its back-forward cache for up to 10 minutes, and one brought back goes on
 * pinging every 10 s and feeding the save. Evicted, it says nothing, and Chrome keeps this worker and the download in
 * progress for good (Chromium 156: still in progress 13 minutes later). So a save whose page has not pinged for 11
 * minutes is failed. Counted in minutes rather than timed, so a machine waking from sleep is not taken for a page gone.
 */
const SILENT_MINUTES = 11

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data) return
  if (data.type === 'stream-open') {
    const port = event.ports[0]
    if (!port) return
    live.set(data.id, { name: data.name, size: data.size, port, resolvePull: null, silent: 0 })
    port.postMessage({ type: 'stream-ready' })
    return
  }
  // Answered only while the download is still live: a worker killed mid-download comes back with an empty map.
  if (data.type === 'ping' && live.has(data.id) && event.source) {
    live.get(data.id).silent = 0
    event.source.postMessage({ type: 'pong', id: data.id })
    return
  }
  // From a page's update gate. Only a WAITING worker ever receives this, and taking over fires
  // controllerchange in every open page, each of which then reloads at its own safe moment.
  if (data.type === 'take-over') self.skipWaiting()
  if (data.type === 'which-build' && event.source) {
    event.source.postMessage({ type: 'build', build: BUILD, mode: MODE })
  }
})

/*
 * Chromium 156 cancels a save named 250 UTF-8 bytes or more and Firefox 157 one of 244 or more, with no word to the
 * page (measured on Linux, whose names hold 255 bytes: each browser writes under a longer temporary name first). So a
 * longer name is cut, keeping its extension.
 */
const MAX_NAME_BYTES = 200
const utf8Bytes = (text) => new TextEncoder().encode(text).length
const fitName = (name) => {
  if (utf8Bytes(name) <= MAX_NAME_BYTES) return name
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : ''
  let stem = ''
  for (const char of name.slice(0, name.length - extension.length)) {
    if (utf8Bytes(stem + char + extension) > MAX_NAME_BYTES) break
    stem += char
  }
  return stem + extension
}

// A header value holds no character above U+00FF, so the quoted name is ASCII and the browsers save under filename*
// (RFC 6266), which carries the real one.
const disposition = (asked) => {
  const name = fitName(String(asked || 'download'))
  const safe = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`
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
        // any generation: a page still on the previous build asks for that build's chunks
        const hit = await caches.match(path)
        if (hit) return hit
        const fresh = await fetch(event.request)
        // An HTML answer here IS the bug this worker exists for: the chunk is gone and Cloudflare
        // served the SPA fallback with a 200. Never store that, or the cache would preserve the
        // failure across the very reload meant to cure it.
        if (isChunk(fresh)) await (await caches.open(CACHE)).put(path, fresh.clone())
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

  let headers
  try {
    headers = new Headers({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': disposition(entry.name),
      'Cache-Control': 'no-store',
    })
  } catch {
    // Unanswered, the frame would get the app's page and the page would wait for bytes forever.
    live.delete(id)
    entry.port.postMessage({ type: 'error' })
    event.respondWith(new Response('Download failed', { status: 500 }))
    return
  }
  // Only when it is known exactly: a zip's length is not known until it has been written.
  if (entry.size > 0) headers.set('Content-Length', String(entry.size))

  const finish = () => {
    if (entry.done) return
    entry.done = true
    clearInterval(entry.watch)
    live.delete(id)
    const resolve = entry.resolvePull
    entry.resolvePull = null
    if (resolve) resolve()
  }

  const body = new ReadableStream({
    start(controller) {
      entry.watch = setInterval(() => {
        if (++entry.silent <= SILENT_MINUTES) return
        controller.error(new Error('the page is gone'))
        entry.port.postMessage({ type: 'error' })
        finish()
      }, 60_000)
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

  event.respondWith(new Response(body, { headers }))
})
