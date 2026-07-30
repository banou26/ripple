import { describe, expect, it } from 'vitest'

import { writeZip } from './zip'

const U32_MAX = 0xFFFFFFFF
const LOCAL_HEADER = 0x04034B50
const CENTRAL_HEADER = 0x02014B50

const entry = (path: string, size: number) => ({
  path,
  size,
  read: async (offset: number, len: number) =>
    new Uint8Array(len).map((_, i) => (offset + i) % 251),
})

// Collects the archive, optionally taking ownership of every chunk the way the streaming
// sink does. Returns the bytes plus the offsets the central directory recorded.
const build = async (entries: ReturnType<typeof entry>[], transfer: boolean) => {
  const parts: Uint8Array[] = []
  await writeZip(entries, async (chunk) => {
    parts.push(chunk.slice())
    // structuredClone with a transfer list detaches the caller's view exactly as
    // postMessage does, so `chunk.length` reads 0 from here on.
    if (transfer) structuredClone(chunk.buffer, { transfer: [chunk.buffer] })
  })
  const total = parts.reduce((n, p) => n + p.length, 0)
  const bytes = new Uint8Array(total)
  let at = 0
  for (const p of parts) { bytes.set(p, at); at += p.length }
  const view = new DataView(bytes.buffer)
  const offsets: number[] = []
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (view.getUint32(i, true) !== CENTRAL_HEADER) continue
    offsets.push(view.getUint32(i + 42, true))
  }
  return { bytes, view, offsets }
}

describe('writeZip', () => {
  it('records a local header offset for every entry', async () => {
    const { view, offsets } = await build([entry('a.mkv', 4_096), entry('b/c.srt', 128)], false)
    expect(offsets).toHaveLength(2)
    expect(offsets[0]).toBe(0)
    for (const offset of offsets) {
      expect(offset).toBeLessThan(U32_MAX)
      expect(view.getUint32(offset, true)).toBe(LOCAL_HEADER)
    }
  })

  // The streaming sink transfers each chunk's buffer, which detaches the view it was handed.
  // Anything that measured a chunk after awaiting the write would read 0 from that point on,
  // freezing the running offset and pointing every entry after the first at byte 0.
  it('stays correct when the sink takes ownership of each chunk', async () => {
    const plain = await build([entry('a.mkv', 4_096), entry('b/c.srt', 128)], false)
    const transferred = await build([entry('a.mkv', 4_096), entry('b/c.srt', 128)], true)
    expect(transferred.offsets).toEqual(plain.offsets)
    expect(transferred.offsets[1]).toBeGreaterThan(0)
    for (const offset of transferred.offsets) {
      expect(transferred.view.getUint32(offset, true)).toBe(LOCAL_HEADER)
    }
    expect([...transferred.bytes]).toEqual([...plain.bytes])
  })
})
