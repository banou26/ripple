import { afterEach, expect, it, vi } from 'vitest'

import { openStreamSink } from '../../src/torrent/stream-download'
import { showEnglish, showIn } from '../i18n/show-in'

import de from '../../src/locales/de.json'

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

afterEach(async () => {
  vi.useRealTimers()
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
  await showEnglish()
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

/** The worker above never answers a ping, so the fourth unanswered one ends the download. */
it('says the download was interrupted in the page\'s language', async () => {
  const interrupted = async () => {
    fakeWorker()
    vi.useFakeTimers()
    const sink = await openStreamSink('a.bin', 4)
    await vi.advanceTimersByTimeAsync(40_000)
    const error = await sink!.write(new Uint8Array(4)).catch((e: unknown) => e as Error)
    await sink!.abort()
    vi.useRealTimers()
    return error?.message
  }
  expect(await interrupted()).toBe('The download was interrupted')
  await showIn('de', de, 'de-DE')
  expect(await interrupted()).toBe('Der Download wurde unterbrochen')
})
