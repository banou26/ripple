import { afterEach, expect, it, vi } from 'vitest'

import { openStreamSink } from '../../src/torrent/stream-download'

/** page work in flight, counted here rather than through the lock, which other test files share */
const work = vi.hoisted(() => ({ running: 0 }))
vi.mock('../../src/utils/page-work', () => ({
  pageWork: async <T,>(fn: () => Promise<T>): Promise<T> => {
    work.running++
    try { return await fn() } finally { work.running-- }
  },
}))

/** A worker that answers `stream-open` the way sw.js does and asks for chunks without end. */
const fakeWorker = () => {
  const worker = {
    postMessage: (data: { type: string }, transfer?: Transferable[]) => {
      if (data.type !== 'stream-open') return
      const port = transfer![0] as MessagePort
      port.postMessage({ type: 'stream-ready' })
      port.onmessage = (event) => { if (event.data?.type === 'chunk') port.postMessage({ type: 'pull' }) }
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
}

afterEach(() => {
  vi.useRealTimers()
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
})

/** Ripple's update gate waits for page work: the worker still streams the last bytes after `close`. */
it('holds updates until the download has had its grace after the last byte', async () => {
  fakeWorker()
  const sink = await openStreamSink('a.bin', 4)
  expect(sink).not.toBeNull()
  await sink!.write(new Uint8Array(4))

  vi.useFakeTimers()
  await sink!.close()
  expect(work.running, 'let go at the last byte').toBe(1)
  await vi.advanceTimersByTimeAsync(9_000)
  expect(work.running).toBe(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(work.running).toBe(0)
})
