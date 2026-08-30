// The service worker sits in front of every request, so what it does NOT do is what matters

import { describe, expect, it } from 'vitest'

// Text rather than fs: node's fs is shimmed away in this browser-targeted vitest environment
import source from './sw.js?raw'

const ORIGIN = 'https://torrent.fkn.app'

type Handler = (event: any) => void

const boot = () => {
  const on: Record<string, Handler> = {}
  const self = {
    location: { href: `${ORIGIN}/sw.js` },
    addEventListener: (type: string, cb: Handler) => { on[type] = cb },
    skipWaiting: () => {},
    clients: { claim: () => Promise.resolve() },
  }
  new Function('self', source)(self)
  return on
}

const requestFor = (url: string) => {
  let response: Response | null = null
  const event = { request: { url }, respondWith: (r: Response) => { response = r } }
  return { event, taken: () => response }
}

const openStream = (on: Record<string, Handler>, id: string, name: string, size = 0) => {
  const channel = new MessageChannel()
  const source: { sent: any[], postMessage: (m: any) => void } = {
    sent: [],
    postMessage: (m: any) => { source.sent.push(m) },
  }
  on.message!({ data: { type: 'stream-open', id, name, size }, ports: [channel.port2], source })
  return { port: channel.port1, source }
}

describe('service worker', () => {
  it('leaves every request that is not a download on the network path', () => {
    const on = boot()
    const untouched = [
      `${ORIGIN}/`,
      `${ORIGIN}/index.js`,
      `${ORIGIN}/assets/index-Bx33zPvJ.js`,
      `${ORIGIN}/libav.wasm`,
      `${ORIGIN}/watch/abc`,
      `${ORIGIN}/legal?next=/__ripple-stream/1`,
      'https://other.example/__ripple-stream/1/x',
    ]
    for (const url of untouched) {
      const { event, taken } = requestFor(url)
      on.fetch!(event)
      expect(taken(), url).toBeNull()
    }
  })

  it('answers an unclaimed download rather than letting it fall through to the app', async () => {
    const on = boot()
    const { event, taken } = requestFor(`${ORIGIN}/__ripple-stream/nope/file.mkv`)
    on.fetch!(event)
    expect(taken()!.status).toBe(404)
  })

  it('streams the page bytes out byte-exact, one chunk in flight at a time', async () => {
    const on = boot()
    const { port } = openStream(on, 'abc', 'movie.mkv', 12)
    const ready = await new Promise<any>((resolve) => { port.onmessage = (e) => resolve(e.data) })
    expect(ready).toEqual({ type: 'stream-ready' })

    const chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8]), new Uint8Array([9, 10, 11, 12])]
    let outstanding = 0
    let peak = 0
    let next = 0
    port.onmessage = (event: MessageEvent) => {
      if (event.data?.type !== 'pull') return
      if (next < chunks.length) {
        outstanding++
        peak = Math.max(peak, outstanding)
        port.postMessage({ type: 'chunk', data: chunks[next++] })
      } else {
        port.postMessage({ type: 'end' })
      }
    }

    const { event, taken } = requestFor(`${ORIGIN}/__ripple-stream/abc/movie.mkv`)
    on.fetch!(event)
    const response = taken()!
    expect(response.headers.get('Content-Length')).toBe('12')
    expect(response.headers.get('Content-Disposition')).toContain('attachment')
    expect(response.headers.get('Content-Disposition')).toContain('movie.mkv')

    const reader = response.body!.getReader()
    const got: number[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      outstanding--
      got.push(...value)
    }
    expect(got).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(peak).toBe(1)
  })

  it('omits Content-Length when the size is not known, as for a zip', async () => {
    const on = boot()
    const { port } = openStream(on, 'zip1', 'library.zip')
    port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'pull') port.postMessage({ type: 'end' })
    }
    const { event, taken } = requestFor(`${ORIGIN}/__ripple-stream/zip1/library.zip`)
    on.fetch!(event)
    expect(taken()!.headers.get('Content-Length')).toBeNull()
    await taken()!.text()
  })

  it('answers a ping only while the download is live', () => {
    const on = boot()
    const { source } = openStream(on, 'abc', 'movie.mkv')
    on.message!({ data: { type: 'ping', id: 'abc' }, ports: [], source })
    expect(source.sent).toEqual([{ type: 'pong', id: 'abc' }])
    on.message!({ data: { type: 'ping', id: 'gone' }, ports: [], source })
    expect(source.sent).toHaveLength(1)
  })

  it('survives the page ending a download twice', async () => {
    const on = boot()
    const { port } = openStream(on, 'twice', 'movie.mkv')
    port.onmessage = (event: MessageEvent) => {
      if (event.data?.type !== 'pull') return
      port.postMessage({ type: 'end' })
      port.postMessage({ type: 'end' })
    }
    const { event, taken } = requestFor(`${ORIGIN}/__ripple-stream/twice/movie.mkv`)
    on.fetch!(event)
    expect(await taken()!.text()).toBe('')
  })

  it('tells the page when the user cancels the download', async () => {
    const on = boot()
    const { port } = openStream(on, 'abc', 'movie.mkv')
    const cancelled = new Promise<any>((resolve) => {
      port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'cancel') resolve(event.data)
      }
    })
    const { event, taken } = requestFor(`${ORIGIN}/__ripple-stream/abc/movie.mkv`)
    on.fetch!(event)
    await taken()!.body!.cancel('user cancelled')
    expect((await cancelled).type).toBe('cancel')
  })
})

/**
 * The caching half, booted from the STAMPED worker rather than the source.
 *
 * That distinction is the whole value of these tests. `src/sw.js` ships three placeholder lines that
 * the build replaces, and a stamp that silently failed to match would produce a worker with an empty
 * manifest and a BUILD that never changes: it would cache nothing and announce no updates, while
 * every test against the raw source still passed. So these run `stamp()` first, exactly as the build
 * does, and boot the result.
 */
const bootStamped = (opts: { mode: string, build: string, manifest: [string, string][] }, caches: any) => {
  const src = source
    .replace(/^const MODE = .*\/\/ @stamp:mode$/m, `const MODE = ${JSON.stringify(opts.mode)}    // @stamp:mode`)
    .replace(/^const BUILD = .*\/\/ @stamp:build$/m, `const BUILD = ${JSON.stringify(opts.build)}   // @stamp:build`)
    .replace(/^const MANIFEST = .*\/\/ @stamp:manifest$/m, `const MANIFEST = ${JSON.stringify(opts.manifest)} // @stamp:manifest`)
  // the marker must have MATCHED, or every assertion below would be measuring the dev defaults
  if (src.includes("= 'dev'")) throw new Error('the stamp did not replace the placeholders')
  const on: Record<string, Handler> = {}
  const skipped: boolean[] = []
  const self = {
    location: { href: `${ORIGIN}/sw.js`, origin: ORIGIN },
    addEventListener: (type: string, cb: Handler) => { on[type] = cb },
    skipWaiting: () => skipped.push(true),
    clients: { claim: () => Promise.resolve() },
    caches,
  }
  new Function('self', 'caches', 'fetch', 'URL', src)(
    self, caches, (self as any).__fetch ?? (() => Promise.reject(new Error('no fetch'))), URL,
  )
  return { on, skipped }
}

const fakeCaches = () => {
  const stores = new Map<string, Map<string, Response>>()
  const api = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name)!
      return {
        match: async (k: string) => store.get(k),
        put: async (k: string, v: Response) => { store.set(k, v) },
        addAll: async (keys: string[]) => { for (const k of keys) store.set(k, new Response('x')) },
      }
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    _stores: stores,
  }
  return api
}

describe('the caching half of the worker', () => {
  const MANIFEST: [string, string][] = [['/assets/worker-AAAA1111.js', 'h1'], ['/assets/libtorrent-BBBB2222.js', 'h2']]

  it('does not take over on install, so an open page keeps the build it loaded with', () => {
    const caches = fakeCaches()
    const { on, skipped } = bootStamped({ mode: 'cache', build: 'b1', manifest: MANIFEST }, caches)
    on.install?.({ waitUntil: () => {} })
    expect(skipped).toHaveLength(0)
  })

  it('takes over the moment a page presses Update, which is what reloads every tab', () => {
    const caches = fakeCaches()
    const { on, skipped } = bootStamped({ mode: 'cache', build: 'b1', manifest: MANIFEST }, caches)
    on.message?.({ data: { type: 'take-over' } })
    expect(skipped).toHaveLength(1)
  })

  /** the kill switch: one committed word, and the next deploy's worker stands aside at once */
  it('takes over immediately and caches nothing in purge mode', async () => {
    const caches = fakeCaches()
    const { on, skipped } = bootStamped({ mode: 'purge', build: 'b1', manifest: MANIFEST }, caches)
    on.install?.({ waitUntil: () => {} })
    expect(skipped).toHaveLength(1)
    const taken = requestFor(`${ORIGIN}/assets/worker-AAAA1111.js`)
    on.fetch?.(taken.event)
    expect(taken.taken(), 'purge mode must answer nothing from cache').toBeNull()
  })

  it('leaves everything that is not a hashed chunk on the network', () => {
    const caches = fakeCaches()
    const { on } = bootStamped({ mode: 'cache', build: 'b1', manifest: MANIFEST }, caches)
    for (const path of ['/', '/embed', '/index.js', '/sw.js', '/assets/logo.png', '/jassub-worker.js']) {
      const r = requestFor(ORIGIN + path)
      on.fetch?.({ ...r.event, request: { url: ORIGIN + path, method: 'GET' } })
      expect(r.taken(), `${path} must not be intercepted`).toBeNull()
    }
  })

  it('still serves a streamed download, which shares this worker', async () => {
    const caches = fakeCaches()
    const { on } = bootStamped({ mode: 'cache', build: 'b1', manifest: MANIFEST }, caches)
    openStream(on, 'abc', 'file.mkv', 10)
    const r = requestFor(`${ORIGIN}/__ripple-stream/abc`)
    on.fetch?.({ ...r.event, request: { url: `${ORIGIN}/__ripple-stream/abc`, method: 'GET' } })
    expect(r.taken(), 'the download path must still be answered').not.toBeNull()
  })

  it('names its cache after the build, so generations cannot collide', () => {
    const caches = fakeCaches()
    const { on } = bootStamped({ mode: 'cache', build: 'deadbeef', manifest: MANIFEST }, caches)
    on.install?.({ waitUntil: (p: Promise<unknown>) => p })
    expect(source).toContain("'ripple-assets-' + BUILD")
  })
})
