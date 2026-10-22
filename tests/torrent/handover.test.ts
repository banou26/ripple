import type { Chunk } from '../../src/torrent/handover'

import { describe, expect, it } from 'vitest'

import { createPieceCheck, fits, layoutOf, resumeWith } from '../../src/torrent/handover'
import { bencode, raw } from '../../src/torrent/make-torrent'
import { decode } from '../../src/torrent/torrent-file'
import { infoFromResume } from '../../src/torrent/torrent-export'

/**
 * What Ripple's own tab does with what the embedded player hands it: every piece is checked against
 * the torrent's own hash as it lands, and only the pieces that pass go into the resume blob the tab
 * adds the torrent with. Small numbers, so a piece straddles a chunk, a file and a pad.
 */

const PIECE = 16
const CHUNK = 24

const pattern = (size: number, seed: number) => Uint8Array.from({ length: size }, (_, i) => (i * 7 + seed * 31) & 0xff)

const sha1 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array(bytes).buffer))

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

// the stream libtorrent hashes: every file in order, pads as zeros
type FileSpec = { size: number, pad?: boolean }
const torrent = async (files: FileSpec[]) => {
  const contents = files.map((f, i) => (f.pad ? new Uint8Array(f.size) : pattern(f.size, i)))
  const stream = concat(contents)
  const hashes: Uint8Array[] = []
  for (let at = 0; at < stream.length; at += PIECE) hashes.push(await sha1(stream.subarray(at, at + PIECE)))
  const info = bencode({
    files: files.map((f, i) => ({ length: f.size, path: [f.pad ? `.pad/${f.size}` : `f${i}`], ...(f.pad ? { attr: 'p' } : {}) })),
    name: 'pack',
    'piece length': PIECE,
    pieces: concat(hashes),
  })
  return { info, contents, pieces: hashes.length }
}

// the bytes of each chunk file, as the embed's storage keeps them
const chunksOf = (contents: Uint8Array[], files: FileSpec[]) =>
  files.flatMap((f, fileIndex) => f.pad
    ? []
    : Array.from({ length: Math.ceil(f.size / CHUNK) }, (_, chunk) => ({
      fileIndex, chunk, bytes: contents[fileIndex]!.slice(chunk * CHUNK, (chunk + 1) * CHUNK),
    })))

const land = async (files: FileSpec[], change: (c: Chunk & { bytes: Uint8Array<ArrayBuffer> }) => Uint8Array<ArrayBuffer> | null = (c) => c.bytes) => {
  const { info, contents, pieces } = await torrent(files)
  const layout = layoutOf(info)!
  const disk = new Map<string, Uint8Array<ArrayBuffer>>()
  const check = createPieceCheck(layout, CHUNK, async ({ fileIndex, chunk }, at, len) =>
    (disk.get(`${fileIndex}-${chunk}`) ?? new Uint8Array(0)).subarray(at, at + len))
  for (const c of chunksOf(contents, files)) {
    const bytes = change(c)
    if (!bytes) continue
    disk.set(`${c.fileIndex}-${c.chunk}`, bytes)
    await check.add(c)
  }
  return { have: [...check.have], pieces }
}

describe('the layout of a torrent the embed hands over', () => {
  it('reads files, pads and piece hashes from the info dictionary', async () => {
    const { info } = await torrent([{ size: 40 }, { size: 8, pad: true }, { size: 20 }])
    const layout = layoutOf(info)!
    expect(layout.pieceLength).toBe(PIECE)
    expect(layout.hashes.length).toBe(5 * 20)
    expect(layout.files).toEqual([
      { offset: 0, size: 40, pad: false },
      { offset: 40, size: 8, pad: true },
      { offset: 48, size: 20, pad: false },
    ])
  })

  it('reads a single file torrent', async () => {
    const layout = layoutOf(bencode({ length: 33, name: 'one', 'piece length': PIECE, pieces: new Uint8Array(60) }))
    expect(layout?.files).toEqual([{ offset: 0, size: 33, pad: false }])
  })

  // no v1 hashes to check a piece against, so nothing is taken
  it('refuses a v2 only torrent and one whose hashes do not cover it', () => {
    expect(layoutOf(bencode({ 'file tree': {}, 'meta version': 2, name: 'v2', 'piece length': PIECE }))).toBeNull()
    expect(layoutOf(bencode({ length: 33, name: 'one', 'piece length': PIECE, pieces: new Uint8Array(40) }))).toBeNull()
  })

  it('takes only chunks that belong to a real file of the torrent', async () => {
    const layout = layoutOf((await torrent([{ size: 40 }, { size: 8, pad: true }, { size: 20 }])).info)!
    expect(fits(layout, CHUNK, { fileIndex: 0, chunk: 1 })).toBe(true)
    expect(fits(layout, CHUNK, { fileIndex: 0, chunk: 2 })).toBe(false)
    expect(fits(layout, CHUNK, { fileIndex: 1, chunk: 0 })).toBe(false)
    expect(fits(layout, CHUNK, { fileIndex: 3, chunk: 0 })).toBe(false)
    expect(fits(layout, CHUNK, { fileIndex: 0.5, chunk: 0 })).toBe(false)
  })
})

describe('checking each piece as it lands', () => {
  const FILES = [{ size: 40 }, { size: 8, pad: true }, { size: 20 }, { size: 5 }, { size: 23 }]

  it('passes every piece of a whole copy, across chunks, files and pads', async () => {
    const { have, pieces } = await land(FILES)
    expect(pieces).toBe(6)
    expect(have).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('passes none of a piece whose bytes are wrong, and keeps the rest', async () => {
    // the first byte of file 2, which is in piece 3 alone
    const { have } = await land(FILES, (c) => {
      if (c.fileIndex !== 2 || c.chunk !== 0) return c.bytes
      const bad = c.bytes.slice()
      bad[0]! ^= 0xff
      return bad
    })
    expect(have).toEqual([1, 1, 1, 0, 1, 1])
  })

  it('passes no piece that touches a chunk the embed did not have', async () => {
    // chunk 1 of file 0 holds bytes 24 to 40: pieces 1 and 2
    const { have } = await land(FILES, (c) => (c.fileIndex === 0 && c.chunk === 1 ? null : c.bytes))
    expect(have).toEqual([1, 0, 0, 1, 1, 1])
  })

  it('reads a short chunk as zeros past its end, as the engine does', async () => {
    // the embed wrote only the head of the last chunk of file 4: piece 5 is missing its tail
    const { have } = await land(FILES, (c) => (c.fileIndex === 4 ? c.bytes.subarray(0, 4) : c.bytes))
    expect(have).toEqual([1, 1, 1, 1, 0, 0])
  })
})

describe('the resume blob the tab adds the torrent with', () => {
  const resume = (info: Uint8Array, pieces: Uint8Array) => bencode({
    'download_rate_limit': 16384,
    'file-format': 'libtorrent resume file',
    'file-version': 1,
    info: raw(info),
    'info-hash': new Uint8Array(20),
    paused: 1,
    pieces,
    unfinished: [{ bitmask: new Uint8Array([0xff]), piece: 2 }],
  })

  it('claims exactly the pieces that passed, unpaused, with no partial piece carried over', async () => {
    const { info } = await torrent([{ size: 64 }])
    const blob = resume(info, new Uint8Array([1, 1, 3, 0]))
    const out = resumeWith(blob, new Uint8Array([1, 0, 1, 1]))
    const [dict] = decode(out, 0) as [Map<string, unknown>, number]
    expect([...dict.get('pieces') as Uint8Array]).toEqual([1, 0, 3, 1])
    expect(dict.get('paused')).toBe(0)
    expect(dict.has('unfinished')).toBe(false)
    // everything else goes back as it was, the info dictionary to the byte
    expect(dict.get('download_rate_limit')).toBe(16384)
    expect(infoFromResume(out)).toEqual(info)
    expect([...dict.keys()]).toEqual(['download_rate_limit', 'file-format', 'file-version', 'info', 'info-hash', 'paused', 'pieces'])
  })

  it('writes the pieces in where a blob carries none', async () => {
    const { info } = await torrent([{ size: 32 }])
    const blob = bencode({ 'file-format': 'libtorrent resume file', info: raw(info), 'save_path': '/cache/x' })
    const [dict] = decode(resumeWith(blob, new Uint8Array([0, 1])), 0) as [Map<string, unknown>, number]
    expect([...dict.keys()]).toEqual(['file-format', 'info', 'paused', 'pieces', 'save_path'])
    expect([...dict.get('pieces') as Uint8Array]).toEqual([0, 1])
  })
})
