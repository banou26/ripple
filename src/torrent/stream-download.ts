// src/sw.js is the other half. The two files cannot import from each other, so the prefix and the message names are duplicated deliberately.

const PREFIX = '/__ripple-stream/'
// Short enough to stay inside the click's transient activation so the download is not treated as unsolicited.
const READY_MS = 3_000
const FIRST_PULL_MS = 15_000
// A service worker is killed when it looks idle, and chunk traffic over a MessagePort does not count as activity.
const PING_MS = 10_000
const MISSED_PONGS = 3

export type Sink = {
  write: (chunk: Uint8Array) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
}

// A hidden iframe navigated at the URL, NOT an <a download> click: Chromium runs a download started by the download attribute outside the service worker entirely.
// Sandboxed without allow-scripts on purpose: if the worker ever fails to claim the URL the frame loads the app itself, and a second copy of Ripple in the page would fight the first for the OPFS locks. With scripts blocked the worst case is an inert frame.
// allow-same-origin is not optional: without it the frame gets an opaque origin, which no service worker controls, so the request would skip the worker.
const openDownloadFrame = (url: string): HTMLIFrameElement => {
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.setAttribute('sandbox', 'allow-downloads allow-same-origin')
  frame.src = url
  document.body.appendChild(frame)
  return frame
}

const aborted = (message: string) => {
  const error = new Error(message)
  // The name the save handlers already recognise as "the user changed their mind" (home.tsx isSaveCancelled), so no failure toast; covers closing the save dialog and cancelling in the browser's own download UI (sw.js cancel()).
  error.name = 'AbortError'
  return error
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(null) })
  })

// May transfer only when the view owns its whole buffer, which holds for both producers here (reads come back as fresh structured clones, zip headers are freshly allocated); anything else must be copied, because transferring a shared buffer detaches bytes the caller still owns.
const detachable = (chunk: Uint8Array) =>
  chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength

export const openStreamSink = async (name: string, size = 0): Promise<Sink | null> => {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null

  const registration = await withTimeout(navigator.serviceWorker.ready, READY_MS)
  const worker = registration?.active
  // Without a controller the synthetic URL is a plain 404 from the network.
  if (!worker || !navigator.serviceWorker.controller) return null

  const id = crypto.randomUUID()
  const channel = new MessageChannel()
  const port = channel.port1

  let credits = 0
  let failure: Error | null = null
  let wake: (() => void) | null = null
  const changed = () => new Promise<void>((resolve) => { wake = resolve })
  const notify = () => { const w = wake; wake = null; w?.() }

  const fail = (error: Error) => { failure ??= error; notify() }

  const ready = new Promise<void>((resolve) => {
    let first = true
    port.onmessage = (event) => {
      const msg = event.data
      if (!msg) return
      if (msg.type === 'pull') {
        credits++
        if (first) { first = false; resolve() }
        notify()
        return
      }
      if (msg.type === 'cancel') fail(aborted('The download was cancelled'))
    }
  })

  worker.postMessage({ type: 'stream-open', id, name, size }, [channel.port2])

  const frame = openDownloadFrame(PREFIX + id + '/' + encodeURIComponent(name))

  let missed = 0
  const heartbeat = setInterval(() => {
    if (++missed > MISSED_PONGS) fail(new Error('The download was interrupted'))
    else worker.postMessage({ type: 'ping', id })
  }, PING_MS)
  const onWorkerMessage = (event: MessageEvent) => {
    if (event.data?.type === 'pong' && event.data.id === id) missed = 0
  }
  navigator.serviceWorker.addEventListener('message', onWorkerMessage)

  const teardown = () => {
    clearInterval(heartbeat)
    navigator.serviceWorker.removeEventListener('message', onWorkerMessage)
    port.onmessage = null
    port.close()
    frame.remove()
  }

  const started = await Promise.race([
    ready.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), FIRST_PULL_MS)),
  ])
  if (failure) { teardown(); throw failure }
  if (!started) { teardown(); return null }

  return {
    write: async (chunk) => {
      while (credits <= 0 && !failure) await changed()
      if (failure) throw failure
      credits--
      const owned = detachable(chunk)
      const data = owned ? chunk : chunk.slice()
      port.postMessage({ type: 'chunk', data }, [data.buffer])
    },
    close: async () => {
      if (failure) { teardown(); throw failure }
      port.postMessage({ type: 'end' })
      teardown()
    },
    abort: async () => {
      try { port.postMessage({ type: 'abort', reason: 'cancelled' }) } catch { /* already gone */ }
      teardown()
    },
  }
}
