import { describe, expect, it } from 'vitest'

import { makeReadWindowStore } from './read-window-store'

/** a window whose every byte encodes its absolute file offset, so a wrong slice cannot read as a right one */
const windowAt = (start: number, length: number) => {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = (start + i) % 251
  return bytes.buffer
}

/** scans in plain code and asserts once: an expect() per byte is millions of calls and hangs the run */
const expectBytesAt = (buffer: ArrayBuffer | null, start: number) => {
  expect(buffer).not.toBeNull()
  const bytes = new Uint8Array(buffer as ArrayBuffer)
  let firstWrong = -1
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== (start + i) % 251) { firstWrong = i; break }
  }
  expect({ firstWrong, length: bytes.length }).toEqual({ firstWrong: -1, length: bytes.length })
}

describe('makeReadWindowStore', () => {
  it('misses before anything is held, and hits inside a window afterwards', () => {
    const store = makeReadWindowStore()
    expect(store.get(0, 100)).toBeNull()

    store.put(0, windowAt(0, 1000))
    const hit = store.get(200, 100)
    expect(hit?.byteLength).toBe(100)
    expectBytesAt(hit, 200)
  })

  it('serves the prefix when the window ends before the request does', () => {
    // the short read is the point: ffmpeg accepts one, so a partial overlap is a hit rather than a refetch
    const store = makeReadWindowStore()
    store.put(1000, windowAt(1000, 500))

    const hit = store.get(1400, 300)
    expect(hit?.byteLength).toBe(100)
    expectBytesAt(hit, 1400)
    expect(store.stats.partial).toBe(1)
    expect(store.stats.hits).toBe(0)
  })

  it('never answers for an offset no window covers', () => {
    const store = makeReadWindowStore()
    store.put(1000, windowAt(1000, 500))

    expect(store.get(999, 10)).toBeNull()
    expect(store.get(1500, 10)).toBeNull()
    expect(store.get(50_000, 10)).toBeNull()
  })

  it('keeps the windows a two-region walk alternates between', () => {
    // the workload this exists for: video near the front, audio far away, each advancing a little a visit.
    // Scaled down from the real 5 MB windows and 2.5 MB reads, because the ratios are what is under test.
    const store = makeReadWindowStore()
    store.put(20_000, windowAt(20_000, 50_000))
    store.put(96_000, windowAt(96_000, 50_000))

    for (let step = 0; step < 40; step++) {
      expectBytesAt(store.get(20_000 + step * 40, 25_000), 20_000 + step * 40)
      expectBytesAt(store.get(96_000 + step * 40, 25_000), 96_000 + step * 40)
    }
    expect(store.stats.misses).toBe(0)
  })

  it('evicts the coldest window, not the oldest one still in use', () => {
    const store = makeReadWindowStore({ windowCount: 2 })
    store.put(0, windowAt(0, 1000))
    store.put(10_000, windowAt(10_000, 1000))

    // touching the first makes the second the coldest
    expectBytesAt(store.get(0, 10), 0)
    store.put(20_000, windowAt(20_000, 1000))

    expectBytesAt(store.get(0, 10), 0)
    expectBytesAt(store.get(20_000, 10), 20_000)
    expect(store.get(10_000, 10)).toBeNull()
  })

  it('holds nothing after a clear', () => {
    const store = makeReadWindowStore()
    store.put(0, windowAt(0, 1000))
    expect(store.get(0, 10)).not.toBeNull()

    store.clear()
    expect(store.get(0, 10)).toBeNull()
    expect(store.stats.hits).toBe(0)
  })

  it('ignores an empty window and a zero-length request', () => {
    const store = makeReadWindowStore()
    store.put(0, new ArrayBuffer(0))
    expect(store.get(0, 10)).toBeNull()

    store.put(0, windowAt(0, 1000))
    expect(store.get(0, 0)).toBeNull()
  })
})
