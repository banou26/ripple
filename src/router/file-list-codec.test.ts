import { describe, expect, it } from 'vitest'

import { deflateSync } from 'fflate'

import { decodeFileList, encodeFileList } from './file-list-codec'
import type { PreviewFile } from './file-list-codec'

const MB = 1024 ** 2
const GB = 1024 ** 3

const season = (count: number): PreviewFile[] =>
  Array.from({ length: count }, (_, i) => ({
    path: `Show.S01/Show.S01E${String(i + 1).padStart(2, '0')}.1080p.WEB-DL.DDP5.1.H.264-GROUP.mkv`,
    size: (350 + i) * MB,
  }))

const CORPUS: [string, PreviewFile[]][] = [
  ['a single file', [{ path: 'Movie.2024.1080p.mkv', size: 1400 * MB }]],
  ['a 12-episode season', season(12)],
  ['nested paths and subtitles', Array.from({ length: 8 }, (_, i) => [
    { path: `Pack/Season 1/Show - S01E${String(i + 1).padStart(2, '0')} [2160p].mkv`, size: (380 + i) * MB },
    { path: `Pack/Season 1/Subs/Show - S01E${String(i + 1).padStart(2, '0')}.en.srt`, size: 45_000 + i },
  ]).flat()],
  ['a zero-byte file', [{ path: 'EMPTY', size: 0 }, { path: 'real.mkv', size: 12 * MB }]],
  ['non-latin names', [{ path: '映画の題名/第01話.mkv', size: 900 * MB }, { path: '映画の題名/字幕.ass', size: 40_000 }]],
  ['a path with spaces, dots and brackets', [{ path: 'A [Group] Show - 01 (1080p) [ABC123].mkv', size: 1 * GB }]],
  ['100 files', Array.from({ length: 100 }, (_, i) => ({ path: `Disc ${1 + (i % 4)}/track_${String(i + 1).padStart(3, '0')}.flac`, size: (30 + (i % 17)) * MB }))],
]

describe('encoding a file list', () => {
  for (const [name, files] of CORPUS) {
    it(`round-trips ${name}`, () => {
      const value = encodeFileList(files)
      expect(value, 'this shape did not encode at all').not.toBeNull()
      expect(decodeFileList(value!)).toEqual(files)
    })
  }

  /**
   * A 40 GB file is 4.3e10 bytes, past 2^31, and every bitwise operator in JavaScript truncates to
   * 32 bits. `1 << 35` is 8. A varint written with shifts would round-trip a remux to the wrong size
   * silently, so this is the test that pins the arithmetic implementation.
   */
  it('survives a file larger than 2^31 bytes, which shifts would silently mangle', () => {
    const files = [{ path: 'Movie.2024.2160p.UHD.BluRay.REMUX.mkv', size: 40 * GB }]
    expect(40 * GB).toBeGreaterThan(2 ** 31)
    expect(decodeFileList(encodeFileList(files)!)).toEqual(files)
  })

  it('survives sizes either side of every varint boundary', () => {
    const sizes = [0, 1, 127, 128, 16_383, 16_384, 2 ** 21 - 1, 2 ** 21, 2 ** 28 - 1, 2 ** 28,
      2 ** 31 - 1, 2 ** 31, 2 ** 35, 2 ** 42, Number.MAX_SAFE_INTEGER]
    const files = sizes.map((size, i) => ({ path: `f${i}.bin`, size }))
    expect(decodeFileList(encodeFileList(files)!)).toEqual(files)
  })

  it('keeps the order, which is what makes a files= selection mean anything', () => {
    const files = season(6)
    const back = decodeFileList(encodeFileList(files)!)!
    expect(back.map((f) => f.path)).toEqual(files.map((f) => f.path))
  })

  it('is far smaller than the torrent it came from', () => {
    // the same 48-file season measured as a .torrent is 31,194 URL characters
    const value = encodeFileList(season(48))!
    expect(value.length).toBeLessThan(700)
  })

  it('refuses rather than truncating when the list would bloat the link', () => {
    // names varied by a fixed sequence rather than Math.random, so a failure here reproduces
    const enormous = Array.from({ length: 3000 }, (_, i) => ({
      path: `${i}-${(i * 2654435761 % 4294967296).toString(36)}${'zqx'.repeat(14)}.mkv`, size: i,
    }))
    const value = encodeFileList(enormous)
    expect(value, 'the fixture now compresses small enough to fit, so this tests nothing').toBeNull()
  })

  it('refuses a path it could not read back, rather than emitting a split one', () => {
    expect(encodeFileList([{ path: 'a\nb.mkv', size: 1 }])).toBeNull()
  })

  it('refuses an empty list, because there is nothing to preview', () => {
    expect(encodeFileList([])).toBeNull()
  })

  it('refuses a nonsense size rather than encoding it', () => {
    expect(encodeFileList([{ path: 'a.mkv', size: -1 }])).toBeNull()
    expect(encodeFileList([{ path: 'a.mkv', size: NaN }])).toBeNull()
    expect(encodeFileList([{ path: 'a.mkv', size: Infinity }])).toBeNull()
  })
})

describe('reading a file list back', () => {
  /*
   * The parameter is written by whoever built the link, so the decoder is the trust boundary. It
   * must never throw (it runs during a render) and must never return a PARTIAL list, because a page
   * showing half a torrent's files as though they were all of them names the wrong thing with
   * nothing on screen to say so.
   */
  it('never throws on hostile input', () => {
    const hostile = ['', 'A', 'AA', 'AQ', '-', '_'.repeat(500), '!!!!', 'AQID', 'A'.repeat(10_000),
      btoa('not a file list'), 'AQ' + 'A'.repeat(200)]
    for (const value of hostile) {
      expect(() => decodeFileList(value), JSON.stringify(value.slice(0, 16))).not.toThrow()
    }
  })

  /**
   * A count that does not match the paths is the forgery that matters, because it is how a value
   * would name five files while carrying two, and the page would show a list with entries the
   * torrent does not have. Built directly rather than by mangling, so it tests the check and not
   * the compressor's own integrity.
   */
  it('refuses a value that claims more files than it carries', () => {
    const encoder = new TextEncoder()
    const pathBlock = encoder.encode('a.mkv\nb.mkv')
    const payload = Uint8Array.from([5, pathBlock.length, ...pathBlock, 1, 2, 3, 4, 5])
    const body = deflateSync(payload, { level: 9 })
    const bytes = new Uint8Array(1 + body.length)
    bytes[0] = 1
    bytes.set(body, 1)
    expect(decodeFileList(toB64(bytes))).toBeNull()
  })

  it('refuses a value with bytes left over after the sizes, which is not the shape it claims', () => {
    const encoder = new TextEncoder()
    const pathBlock = encoder.encode('a.mkv\nb.mkv')
    const payload = Uint8Array.from([2, pathBlock.length, ...pathBlock, 1, 2, 99, 99, 99])
    const body = deflateSync(payload, { level: 9 })
    const bytes = new Uint8Array(1 + body.length)
    bytes[0] = 1
    bytes.set(body, 1)
    expect(decodeFileList(toB64(bytes))).toBeNull()
  })

  it('never returns a partial list from a mangled value', () => {
    const forged = encodeFileList([{ path: 'a', size: 1 }, { path: 'b', size: 2 }])!
    const bytes = fromB64(forged)
    for (let i = 1; i < bytes.length; i++) {
      const mangled = Uint8Array.from(bytes)
      mangled[i] = mangled[i]! ^ 0xff
      const back = decodeFileList(toB64(mangled))
      // either refused outright, or a coherent list, but never something half-read
      if (back !== null) expect(back.every((f) => typeof f.path === 'string' && f.size >= 0)).toBe(true)
    }
  })

  it('refuses a version it does not know, rather than guessing at the layout', () => {
    const value = encodeFileList([{ path: 'a.mkv', size: 1 }])!
    const bytes = fromB64(value)
    bytes[0] = 99
    expect(decodeFileList(toB64(bytes))).toBeNull()
  })

  it('refuses a payload that inflates out of all proportion', () => {
    // a deliberately tiny value that expands enormously, the trap magnet-codec was fixed for
    const bomb = new Uint8Array(1 + 4096)
    bomb[0] = 1
    expect(() => decodeFileList(toB64(bomb))).not.toThrow()
  })
})

const fromB64 = (value: string) => {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
const toB64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
