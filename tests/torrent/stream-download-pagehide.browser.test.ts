import { afterEach, expect, it, vi } from 'vitest'

import { openStreamSink } from '../../src/torrent/stream-download'

/** A worker that answers `stream-open` the way sw.js does. Returns what the page then sends it over the port. */
const fakeWorker = () => {
  const got: string[] = []
  const worker = {
    postMessage: (data: { type: string }, transfer?: Transferable[]) => {
      if (data.type !== 'stream-open') return
      const port = transfer![0] as MessagePort
      port.onmessage = (event) => {
        got.push(event.data?.type)
        if (event.data?.type === 'chunk') port.postMessage({ type: 'pull' })
      }
      port.postMessage({ type: 'stream-ready' })
      port.postMessage({ type: 'pull' })
    },
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({ active: worker }),
      controller: worker,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  })
  return got
}

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
})

const pageHide = (persisted: boolean) => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted }))
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

/** A page closed mid-save otherwise leaves Chrome's download in progress forever and Firefox's short and listed as finished. */
it('tells the worker to abort when the page goes away mid-save', async () => {
  const got = fakeWorker()
  const sink = await openStreamSink('a.bin', 8)
  await sink!.write(new Uint8Array(4))
  pageHide(false)
  await settle()
  expect(got).toEqual(['chunk', 'abort'])
})

/** Chrome keeps a page that is mid-save in its back-forward cache, and brought back the save carries on (measured). */
it('keeps the save when the page only goes into the back-forward cache', async () => {
  const got = fakeWorker()
  const sink = await openStreamSink('a.bin', 8)
  await sink!.write(new Uint8Array(4))
  pageHide(true)
  await settle()
  expect(got).toEqual(['chunk'])
  await sink!.abort()
})

it('does nothing when the page goes away after the save has ended', async () => {
  fakeWorker()
  const sink = await openStreamSink('a.bin', 8)
  await sink!.abort()
  const post = vi.spyOn(MessagePort.prototype, 'postMessage')
  pageHide(false)
  expect(post).not.toHaveBeenCalled()
  post.mockRestore()
})
