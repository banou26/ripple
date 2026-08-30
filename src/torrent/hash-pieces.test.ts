import type { ReadFile } from './hash-pieces'
import type { SourceFile } from './make-torrent'

import { describe, expect, it, vi } from 'vitest'

import { HashCancelled, hashEta, hashPieces } from './hash-pieces'
import { PIECE_HASH_BYTES, plan } from './make-torrent'

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** An in-memory disk: the files a plan names, each holding known bytes. */
const disk = (contents: Record<string, Uint8Array>) => {
  const reads: Array<{ path: string, offset: number, length: number }> = []
  const read: ReadFile = async (file: SourceFile, offset: number, length: number) => {
    const path = file.path.join('/')
    const bytes = contents[path]
    if (!bytes) throw new Error(`no such file ${path}`)
    reads.push({ path, offset, length })
    return bytes.subarray(offset, offset + length)
  }
  return { read, reads }
}

const bytes = (...values: number[]) => new Uint8Array(values)
const filled = (length: number, value: number) => new Uint8Array(length).fill(value)

/** SHA-1 through the same API the code uses, over bytes the test assembles itself. */
const sha1 = async (data: Uint8Array) =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array(data).buffer as ArrayBuffer)))

const digestAt = (pieces: Uint8Array, index: number) =>
  hex(pieces.subarray(index * PIECE_HASH_BYTES, (index + 1) * PIECE_HASH_BYTES))

describe('hashing pieces', () => {
  /**
   * A known answer that comes from outside this repo: SHA-1 of the three bytes "abc" is
   * a9993e364706816aba3e25717850c26c9cd0d89d, one of the published test vectors.
   *
   * Every other case here compares against a digest the test computes, which proves the BOUNDARIES
   * are right and says nothing about whether the hash is the one the world uses. This one does.
   */
  it('produces the published digest for a single short piece', async () => {
    const contents = { 'a.txt': new TextEncoder().encode('abc') }
    const built = plan({ name: 'a.txt', files: [{ path: ['a.txt'], size: 3 }], single: true })
    const pieces = await hashPieces(built, disk(contents).read)
    expect(built.pieceCount).toBe(1)
    expect(digestAt(pieces, 0)).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })

  /**
   * The case the whole file exists for. Three 5-byte files with a 4-byte piece length: the pieces do
   * not line up with any file, so piece 1 is the tail of the first file plus the head of the second.
   * Hashing each file separately would produce four different digests and a torrent that works right
   * up until a peer asks for something.
   */
  it('hashes across file boundaries, not per file', async () => {
    const contents = {
      'a': filled(5, 0xa1),
      'b': filled(5, 0xb2),
      'c': filled(5, 0xc3),
    }
    const built = plan({
      name: 'Pack',
      files: [{ path: ['a'], size: 5 }, { path: ['b'], size: 5 }, { path: ['c'], size: 5 }],
      pieceLength: 1 << 14,
    })
    // the plan's own piece length is far larger than the data, so override the walk with a tiny one
    const small = { ...built, pieceLength: 4, pieceCount: 4 }
    const pieces = await hashPieces(small, disk(contents).read)

    const whole = new Uint8Array([...contents.a!, ...contents.b!, ...contents.c!])
    expect(digestAt(pieces, 0)).toBe(await sha1(whole.subarray(0, 4)))
    expect(digestAt(pieces, 1)).toBe(await sha1(whole.subarray(4, 8)))
    expect(digestAt(pieces, 2)).toBe(await sha1(whole.subarray(8, 12)))
    // the short last piece: three bytes, not padded to four
    expect(digestAt(pieces, 3)).toBe(await sha1(whole.subarray(12, 15)))
  })

  it('writes exactly one digest per piece, in order', async () => {
    const contents = { 'a': filled(10, 1) }
    const built = { ...plan({ name: 'P', files: [{ path: ['a'], size: 10 }] }), pieceLength: 4, pieceCount: 3 }
    const pieces = await hashPieces(built, disk(contents).read)
    expect(pieces.length).toBe(3 * PIECE_HASH_BYTES)
  })

  /** A file of zero bytes contributes nothing and is not skipped or mishandled. */
  it('walks past an empty file in the middle of a pack', async () => {
    const contents = { 'a': filled(4, 1), 'empty': new Uint8Array(0), 'b': filled(4, 2) }
    const built = {
      ...plan({ name: 'P', files: [{ path: ['a'], size: 4 }, { path: ['b'], size: 4 }, { path: ['empty'], size: 0 }] }),
      pieceLength: 4,
      pieceCount: 2,
    }
    // plan sorts, so the order is a, b, empty
    const pieces = await hashPieces(built, disk(contents).read)
    expect(digestAt(pieces, 0)).toBe(await sha1(filled(4, 1)))
    expect(digestAt(pieces, 1)).toBe(await sha1(filled(4, 2)))
  })

  it('hashes nothing at all for a torrent of only empty files', async () => {
    const built = plan({ name: 'P', files: [{ path: ['a'], size: 0 }] })
    const { read, reads } = disk({ 'a': new Uint8Array(0) })
    const pieces = await hashPieces(built, read)
    expect(built.pieceCount).toBe(0)
    expect(pieces.length).toBe(0)
    expect(reads).toHaveLength(0)
  })

  it('never asks for more than one read at a time allows', async () => {
    const contents = { 'a': filled(1000, 3) }
    const built = { ...plan({ name: 'P', files: [{ path: ['a'], size: 1000 }] }), pieceLength: 512, pieceCount: 2 }
    const { read, reads } = disk(contents)
    await hashPieces(built, read, { maxReadBytes: 100 })
    expect(Math.max(...reads.map((r) => r.length))).toBeLessThanOrEqual(100)
    // and it still covered every byte exactly once, in order
    expect(reads.reduce((sum, r) => sum + r.length, 0)).toBe(1000)
    expect(reads.map((r) => r.offset)).toEqual([...reads.map((r) => r.offset)].sort((a, b) => a - b))
  })

  it('never asks a read to cross a piece boundary', async () => {
    const contents = { 'a': filled(1000, 3) }
    const built = { ...plan({ name: 'P', files: [{ path: ['a'], size: 1000 }] }), pieceLength: 300, pieceCount: 4 }
    const { read, reads } = disk(contents)
    await hashPieces(built, read, { maxReadBytes: 4096 })
    for (const r of reads) {
      expect(Math.floor(r.offset / 300), `read at ${r.offset} for ${r.length} spans two pieces`)
        .toBe(Math.floor((r.offset + r.length - 1) / 300))
    }
  })
})

describe('progress', () => {
  it('reports once per finished piece, rising to the total', async () => {
    const contents = { 'a': filled(12, 1) }
    const built = { ...plan({ name: 'P', files: [{ path: ['a'], size: 12 }] }), pieceLength: 4, pieceCount: 3 }
    const onProgress = vi.fn()
    await hashPieces(built, disk(contents).read, { onProgress })
    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress.mock.calls.map((c) => c[0].pieces)).toEqual([1, 2, 3])
    expect(onProgress.mock.calls.at(-1)![0].hashedBytes).toBe(12)
    expect(onProgress.mock.calls.at(-1)![0].totalBytes).toBe(12)
  })

  it('names the file it is reading, so a progress line can say more than a percentage', async () => {
    const contents = { 'first': filled(4, 1), 'second': filled(4, 2) }
    const built = {
      ...plan({ name: 'P', files: [{ path: ['first'], size: 4 }, { path: ['second'], size: 4 }] }),
      pieceLength: 4,
      pieceCount: 2,
    }
    const onProgress = vi.fn()
    await hashPieces(built, disk(contents).read, { onProgress })
    expect(onProgress.mock.calls.map((c) => c[0].path)).toEqual(['first', 'second'])
  })
})

describe('stopping', () => {
  it('throws HashCancelled and stops reading once the signal aborts', async () => {
    const contents = { 'a': filled(4000, 1) }
    const built = { ...plan({ name: 'P', files: [{ path: ['a'], size: 4000 }] }), pieceLength: 400, pieceCount: 10 }
    const controller = new AbortController()
    const { read, reads } = disk(contents)
    const onProgress = vi.fn(() => { if (onProgress.mock.calls.length >= 2) controller.abort() })

    await expect(hashPieces(built, read, { signal: controller.signal, onProgress })).rejects.toThrow(HashCancelled)
    // the control for that rejection: it stopped EARLY rather than throwing at the end
    expect(reads.length).toBeLessThan(10)
  })

  it('does nothing at all when the signal is already aborted', async () => {
    const built = plan({ name: 'P', files: [{ path: ['a'], size: 4000 }] })
    const { read, reads } = disk({ 'a': filled(4000, 1) })
    await expect(hashPieces(built, read, { signal: AbortSignal.abort() })).rejects.toThrow(HashCancelled)
    expect(reads).toHaveLength(0)
  })
})

describe('when the files stop matching the plan', () => {
  /**
   * The person edited or replaced a file while the pass was running. Padding the gap would produce a
   * torrent whose hashes describe bytes that never existed, and nothing would notice until a peer
   * rejected every piece.
   */
  it('refuses a short read rather than padding it', async () => {
    const built = { ...plan({ name: 'P', files: [{ path: ['a'], size: 100 }] }), pieceLength: 50, pieceCount: 2 }
    const read: ReadFile = async (_file, offset, length) => new Uint8Array(Math.max(0, Math.min(length, 60 - offset)))
    await expect(hashPieces(built, read)).rejects.toThrow(/changed while it was being read/)
  })

  it('says so when the totals no longer add up', async () => {
    // a plan claiming more pieces than its own bytes can fill, which is what a stale size looks like
    const built = { ...plan({ name: 'P', files: [{ path: ['a'], size: 8 }] }), pieceLength: 4, pieceCount: 5 }
    await expect(hashPieces(built, disk({ 'a': filled(8, 1) }).read)).rejects.toThrow(/no longer add up/)
  })
})

describe('the estimate', () => {
  const progress = (hashedBytes: number, totalBytes: number) =>
    ({ hashedBytes, totalBytes, pieces: 1, pieceCount: 10, path: 'a' })

  it('says nothing until there is enough to divide by', () => {
    expect(hashEta(progress(0, 1000), 5_000)).toBeUndefined()
    expect(hashEta(progress(100, 1000), 500)).toBeUndefined()
  })

  it('divides the remainder by the rate so far', () => {
    // 100 bytes in 1 second, 900 left, so 9 seconds
    expect(hashEta(progress(100, 1000), 1_000)).toBe(9)
  })

  it('reaches zero rather than a negative at the end', () => {
    expect(hashEta(progress(1000, 1000), 2_000)).toBe(0)
  })
})
