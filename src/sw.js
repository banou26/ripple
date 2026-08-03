// Copied verbatim by the copy-html script rather than bundled, so it cannot import. Every request that is not one of ours is left on the default network path.

const PREFIX = new URL('/__ripple-stream/', self.location.href).href

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
  // Answered only while the download is still live: a worker killed mid-download comes back with an empty map.
  if (data.type === 'ping' && live.has(data.id) && event.source) {
    event.source.postMessage({ type: 'pong', id: data.id })
  }
})

const disposition = (name) => {
  const safe = String(name || 'download').replace(/[\r\n"\\]/g, '_')
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name || 'download')}`
}

self.addEventListener('fetch', (event) => {
  const url = event.request.url
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
