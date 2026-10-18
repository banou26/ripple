import { expect, it } from 'vitest'

/**
 * What the origin is charged for a chunked torrent, read off the browser's own estimate.
 *
 * A write at the end of chunk 40 of 4 MiB costs that one chunk, where the same write into one file
 * the length of the torrent's file costs all 41 chunks before it (the control, which is what shows
 * the estimate can tell the two apart), and dropping the chunk gives its room back.
 */
const C = 4 * 1024 * 1024

it('charges a write one chunk, and gives the room back when the chunk is dropped', async () => {
  const worker = new Worker(new URL('./chunked-storage.probe.ts', import.meta.url), { type: 'module' })
  type Probe = { base: number, chunked: number, dropped: number, before: number, whole: number, error?: string }
  const result = await new Promise<Probe>((resolve) => {
    worker.onmessage = (event) => resolve(event.data)
    worker.postMessage('run')
  })
  worker.terminate()
  expect(result.error).toBeUndefined()
  const { base, chunked, dropped, before, whole } = result
  expect(whole - before, 'the control: one file is charged up to its furthest write').toBeGreaterThan(40 * C)
  expect(chunked - base).toBeGreaterThanOrEqual(C)
  expect(chunked - base).toBeLessThan(2 * C)
  expect(dropped - base).toBeLessThan(C / 2)
})
