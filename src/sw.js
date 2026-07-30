// Service worker. Two jobs, and it stays out of the way for everything else.
//
// 1. Being registered at all is what makes the app installable, which is what lets the OS
//    route .torrent files and magnet links to it.
// 2. It turns a stream of postMessage chunks into a real HTTP download, so a browser
//    without showSaveFilePicker (Firefox, Safari) can save a 20 GB file without holding it
//    in memory first. See src/torrent/stream-download.ts for the other half of this
//    protocol; the two files cannot import from each other, so src/sw.test.ts loads this
//    one and drives it to keep them in step.
//
// Every request that is not one of ours returns from the fetch handler without calling
// respondWith, which leaves it on the default network path: streaming range requests and
// the worker and OPFS loads are untouched, exactly as when this file did nothing at all.
//
// Copied verbatim by the copy-html script rather than bundled, so it cannot import.

const PREFIX = new URL('/__ripple-stream/', self.location.href).href

// Downloads the page has opened but the browser has not finished fetching, by id.
const live = new Map()

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

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
  // Answered only while the download is still live. A worker that was killed mid-download
  // and started again comes back with an empty map, and the page needs to hear that
  // silence rather than wait out a transfer nothing is carrying any more.
  if (data.type === 'ping' && live.has(data.id) && event.source) {
    event.source.postMessage({ type: 'pong', id: data.id })
  }
})

// A filename for Content-Disposition. The quoted form cannot carry a quote or a line
// break, and the RFC 5987 form beside it is what actually gets used for anything non-ASCII.
const disposition = (name) => {
  const safe = String(name || 'download').replace(/[\r\n"\\]/g, '_')
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name || 'download')}`
}

self.addEventListener('fetch', (event) => {
  const url = event.request.url
  if (!url.startsWith(PREFIX)) return

  const id = url.slice(PREFIX.length).split('/')[0]
  const entry = live.get(id)
  // Answered rather than left to fall through: an unclaimed synthetic URL would be served
  // the app's own HTML, which the browser would then save under the file's name.
  if (!entry) {
    event.respondWith(new Response('Unknown download', { status: 404 }))
    return
  }

  // The page owns the other end of this port, so a duplicate or late end/abort is always
  // possible, and closing an already-closed controller throws inside the message handler.
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
    // Returning a promise that only settles once the chunk arrives is what creates the
    // backpressure: the stream will not ask again until the browser has taken the last
    // one, so one chunk is ever in flight and the page's read loop waits on the disk
    // rather than running ahead of it into memory.
    pull() {
      return new Promise((resolve) => {
        entry.resolvePull = resolve
        entry.port.postMessage({ type: 'pull' })
      })
    },
    // The user cancelled the download in the browser's own UI.
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
  // Only when it is known exactly. A zip's length is not known until it has been written,
  // and a Content-Length the body then misses would break the download.
  if (entry.size > 0) headers['Content-Length'] = String(entry.size)

  event.respondWith(new Response(body, { headers }))
})
