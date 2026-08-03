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
