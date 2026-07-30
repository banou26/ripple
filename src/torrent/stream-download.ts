// Streams bytes to the user's disk through the service worker, for browsers that have no
// showSaveFilePicker. The page opens a synthetic same-origin URL, clicks it, and feeds the
// response body one chunk at a time; the browser writes each chunk straight out, so a 20 GB
// export never exists in memory. See src/sw.js for the other half. The two files cannot
// import from each other, so the prefix and the message names are duplicated deliberately
// and src/sw.test.ts drives them together.
//
// Every step down the fallback chain is bounded. Nothing here can hang: a service worker
// that is missing, still installing, not yet in control, or killed mid-transfer all end as
// a null return or a thrown error, and the caller drops to buffering into a Blob.

const PREFIX = '/__ripple-stream/'
// Long enough for a worker that is still starting up, short enough to stay inside the
// click's transient activation so the download is not treated as unsolicited.
const READY_MS = 3_000
// How long to wait for the browser to actually fetch the URL we just clicked.
const FIRST_PULL_MS = 15_000
// A service worker is killed when it looks idle, and chunk traffic over a MessagePort does
// not count as activity. A read can legitimately take up to READ_TIMEOUT in client.ts, so
// without this a slow torrent would lose its download to the idle timer.
const PING_MS = 10_000
const MISSED_PONGS = 3

export type Sink = {
  write: (chunk: Uint8Array) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
}

// A hidden iframe navigated at the URL, NOT an <a download> click. Chromium runs a download
// started by the download attribute outside the service worker entirely, so the click gets
// whatever the network returns for the synthetic path (the app's own index.html, saved
// under the file's name). A navigation goes through the worker, and Content-Disposition
// turns the response into a download.
//
// Sandboxed without allow-scripts: if the worker ever failed to claim the URL the frame
// would load the app instead, and a second copy of Ripple in the page would fight the first
// for the OPFS locks. With scripts blocked the worst case is an inert frame. allow-same-origin
// is not optional and is not a hole here: a sandbox without it gives the frame an opaque
// origin, which no service worker controls, so the request would skip the worker entirely and
// be answered by the network, which is the failure the sandbox is there to contain.
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
  // The name the save handlers already recognise as "the user changed their mind", so a
  // cancelled download does not raise a failure toast.
  error.name = 'AbortError'
  return error
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(null) })
  })

// Transferring costs nothing when the view owns its whole buffer, which is the case for
// both of this app's producers: reads come back as fresh structured clones and zip headers
// are freshly allocated. Anything else is copied, because transferring a shared buffer
// would detach bytes the caller still owns.
const detachable = (chunk: Uint8Array) =>
  chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength

export const openStreamSink = async (name: string, size = 0): Promise<Sink | null> => {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null

  const registration = await withTimeout(navigator.serviceWorker.ready, READY_MS)
  const worker = registration?.active
  // Without a controller the synthetic URL is a plain 404 from the network, so the
  // download would arrive as an error page rather than the file.
  if (!worker || !navigator.serviceWorker.controller) return null

  const id = crypto.randomUUID()
  const channel = new MessageChannel()
  const port = channel.port1

  // How many chunks the worker has asked for and not yet been given. The download's own
  // read loop blocks whenever this is zero, which is what keeps memory flat.
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

  // Keep the worker awake for as long as this download runs, and notice if it went away.
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

  // The first pull is the proof that the browser really fetched the URL. Until it lands
  // there is nothing to say the download started at all, so this is the last point at
  // which falling back to a Blob is still possible.
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
