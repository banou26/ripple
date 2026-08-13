import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { writeZip } from './zip'

const U32_MAX = 0xFFFFFFFF
const LOCAL_HEADER = 0x04034B50
const CENTRAL_HEADER = 0x02014B50
const EOCD64 = 0x06064B50
const EOCD64_LOCATOR = 0x07064B50

const entry = (path: string, size: number) => ({
  path,
  size,
  read: async (offset: number, len: number) =>
    new Uint8Array(len).map((_, i) => (offset + i) % 251),
})

const build = async (entries: ReturnType<typeof entry>[], transfer: boolean) => {
  const parts: Uint8Array[] = []
  await writeZip(entries, async (chunk) => {
    parts.push(chunk.slice())
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

  // The streaming sink transfers each chunk's buffer (structuredClone does the same here), which detaches the view it was handed
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

  /**
   * A real zip reader, because everything above only checks two four-byte signatures.
   *
   * `writeZip` emits the STREAMING shape: general purpose flag 0x0808, sizes and CRC deferred to a
   * data descriptor after each payload. That is the shape lenient readers accept and strict ones
   * reject, so a hand-rolled parser agreeing with itself proves nothing about whether the archive
   * opens. `testzip()` recomputes every CRC, which is the one thing no test here could fake.
   *
   * python3 is the only zip reader on this machine (no unzip, 7z or bsdtar), so a run without it
   * skips rather than fails.
   */
  it('produces an archive a real zip reader accepts, with the right bytes in it', async () => {
    let python: string
    try {
      python = execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim()
      if (!python) throw new Error('missing')
    } catch {
      // eslint-disable-next-line no-console
      console.warn('skipped: python3 is needed to validate the zip with a real reader')
      return
    }

    const { bytes } = await build([entry('a.mkv', 4_096), entry('b/c.srt', 128)], false)
    const dir = mkdtempSync(join(tmpdir(), 'ripple-zip-'))
    try {
      const archive = join(dir, 'out.zip')
      writeFileSync(archive, bytes)
      const report = execFileSync(python, ['-c', `
import json, zipfile
z = zipfile.ZipFile(${JSON.stringify(archive)})
# testzip() returns the first entry whose recomputed CRC disagrees with the stored one, else None
print(json.dumps({
  'bad': z.testzip(),
  'names': z.namelist(),
  'sizes': [i.file_size for i in z.infolist()],
  'payload': list(z.read('a.mkv')[:8]),
}))
`], { encoding: 'utf8' })
      const result = JSON.parse(report)

      expect(result.bad, 'every entry must pass its own CRC').toBeNull()
      expect(result.names).toEqual(['a.mkv', 'b/c.srt'])
      expect(result.sizes).toEqual([4_096, 128])
      // the payload is the fixture's own generator, so this catches an off-by-one in the framing
      expect(result.payload).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * The ZIP64 branch, which is dead code to every other test here and live code for every real
   * torrent: one file at or over 4 GiB flips it, and a season pack of 1080p video clears that alone.
   *
   * The payload is written but never kept. A sink that measures instead of storing lets a 4 GiB
   * entry run in about a second and a few MB of memory, so the branch that only appears at that size
   * can actually be asserted rather than reasoned about.
   */
  it('switches to ZIP64 for an entry at or over 4 GiB', async () => {
    const size = U32_MAX + 1
    const zeros = new Uint8Array(8 * 1024 * 1024)
    const big = {
      path: 'huge.mkv',
      size,
      // reused rather than allocated per call: writeZip only reads these bytes to CRC them
      read: async (_offset: number, len: number) => (len === zeros.length ? zeros : zeros.subarray(0, len)),
    }

    let offset = 0
    const tail: { at: number, bytes: Uint8Array }[] = []
    await writeZip([big], async (chunk) => {
      // the payload is discarded; only the framing around it is kept, and it all sits past the data
      if (chunk.length < 4096) tail.push({ at: offset, bytes: chunk.slice() })
      offset += chunk.length
    })

    const local = tail[0]!
    expect(local.at, 'the local header comes first').toBe(0)
    const lv = new DataView(local.bytes.buffer, local.bytes.byteOffset, local.bytes.byteLength)
    expect(lv.getUint32(0, true)).toBe(LOCAL_HEADER)
    expect(lv.getUint16(4, true), 'version needed to extract says 4.5').toBe(45)
    // 0xFFFFFFFF in both size fields is what tells a reader to look in the zip64 extra field
    expect(lv.getUint32(18, true)).toBe(U32_MAX)
    expect(lv.getUint32(22, true)).toBe(U32_MAX)
    const nameLen = lv.getUint16(26, true)
    const extraLen = lv.getUint16(28, true)
    expect(extraLen, 'a 0x0001 header plus two 64 bit sizes').toBe(20)
    const extra = 30 + nameLen
    expect(lv.getUint16(extra, true), 'the zip64 extra field id').toBe(0x0001)
    expect(lv.getUint16(extra + 2, true)).toBe(16)
    expect(Number(lv.getBigUint64(extra + 4, true)), 'uncompressed size, 64 bit').toBe(size)
    expect(Number(lv.getBigUint64(extra + 12, true)), 'compressed size, 64 bit').toBe(size)

    const rest = tail.slice(1)
    const flat = new Uint8Array(rest.reduce((n, p) => n + p.bytes.length, 0))
    let at = 0
    for (const p of rest) { flat.set(p.bytes, at); at += p.bytes.length }
    const fv = new DataView(flat.buffer)
    const signatures: number[] = []
    for (let i = 0; i + 4 <= flat.length; i++) signatures.push(fv.getUint32(i, true))

    // the data descriptor carries 64 bit sizes too, or the entry's own trailer contradicts its header
    const dd = signatures.indexOf(0x08074B50)
    expect(dd, 'a data descriptor follows the payload').toBeGreaterThanOrEqual(0)
    expect(Number(fv.getBigUint64(dd + 8, true))).toBe(size)
    expect(Number(fv.getBigUint64(dd + 16, true))).toBe(size)

    // and the archive ends with a zip64 end-of-central-directory record plus its locator
    expect(signatures).toContain(EOCD64)
    expect(signatures).toContain(EOCD64_LOCATOR)
    const central = signatures.indexOf(CENTRAL_HEADER)
    expect(central).toBeGreaterThanOrEqual(0)
    expect(fv.getUint32(central + 20, true), 'the central sizes defer to the extra field as well').toBe(U32_MAX)
    expect(fv.getUint32(central + 24, true)).toBe(U32_MAX)
  }, 120_000)
})
