import { describe, expect, it } from 'vitest'

import {
  MAX_PIECE_LENGTH,
  MIN_PIECE_LENGTH,
  PIECE_HASH_BYTES,
  bencode,
  compareSourceFiles,
  encodeInfo,
  encodeTorrent,
  infoHashOf,
  isValidPieceLength,
  magnetFor,
  pieceLengthFor,
  plan,
} from './make-torrent'
import { readTorrentFile } from './torrent-file'

const ascii = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/**
 * The encoder, against answers that come from the specification rather than from itself.
 *
 * Every one of these decides an infohash. Bencode has exactly one valid encoding of a given value,
 * and the infohash is the SHA-1 of the encoded `info`, so a difference anywhere below produces a
 * number no other client computes and a torrent that connects to nothing.
 */
describe('bencode', () => {
  it('writes the four types the way BEP 3 defines them', () => {
    expect(ascii(bencode(42))).toBe('i42e')
    expect(ascii(bencode(0))).toBe('i0e')
    expect(ascii(bencode('spam'))).toBe('4:spam')
    expect(ascii(bencode(''))).toBe('0:')
    expect(ascii(bencode(['spam', 42]))).toBe('l4:spami42ee')
    expect(ascii(bencode({ bar: 'spam', foo: 42 }))).toBe('d3:bar4:spam3:fooi42ee')
    expect(ascii(bencode([]))).toBe('le')
    expect(ascii(bencode({}))).toBe('de')
  })

  it('sorts dictionary keys however they were given', () => {
    expect(ascii(bencode({ b: 1, a: 2 }))).toBe('d1:ai2e1:bi1ee')
    // the real ordering that decides an info dict, asserted because getting it wrong is silent
    expect(ascii(bencode({ pieces: 'x', 'piece length': 1, name: 'n' })))
      .toBe('d4:name1:n12:piece lengthi1e6:pieces1:xe')
  })

  it('measures a string in bytes rather than characters', () => {
    // three characters, nine bytes: a length prefix taken from String.length would be unreadable
    expect(ascii(bencode('日本語'))).toBe('9:日本語')
  })

  /**
   * JavaScript compares strings by UTF-16 code unit, which is NOT byte order once a character sits
   * outside the basic plane: U+FFFD is one unit 0xFFFD and U+10000 is the pair 0xD800 0xDC00, so
   * `<` puts U+10000 first while its UTF-8 bytes (F0 90 ...) sort after U+FFFD's (EF BF ...).
   *
   * No torrent key is ever going to be an emoji. It is here because it is the one case that tells a
   * byte comparison apart from the convenient one, so it is the only case that proves which is
   * implemented.
   */
  it('orders keys as raw bytes, not as UTF-16 code units', () => {
    const encoded = ascii(bencode({ '\u{10000}': 1, '�': 2 }))
    expect(encoded.indexOf('�')).toBeLessThan(encoded.indexOf('\u{10000}'))
  })

  it('refuses what bencode cannot express', () => {
    expect(() => bencode(1.5)).toThrow(/integer/)
    expect(() => bencode(Number.MAX_SAFE_INTEGER + 2)).toThrow(/exact integer range/)
  })

  it('leaves out a key whose value is undefined rather than encoding it', () => {
    expect(ascii(bencode({ a: 1, b: undefined }))).toBe('d1:ai1ee')
  })
})

describe('choosing a piece length', () => {
  it('aims at a piece count in the low thousands', () => {
    for (const size of [50e6, 700e6, 4e9, 15e9]) {
      const length = pieceLengthFor(size)
      const pieces = Math.ceil(size / length)
      expect(pieces, `${size} bytes gave ${pieces} pieces of ${length}`).toBeGreaterThan(200)
      expect(pieces, `${size} bytes gave ${pieces} pieces of ${length}`).toBeLessThan(4000)
    }
  })

  it('always returns a power of two inside the range clients accept', () => {
    for (const size of [0, 1, 1e3, 1e6, 1e9, 1e12, 1e15]) {
      expect(isValidPieceLength(pieceLengthFor(size)), `${size} gave ${pieceLengthFor(size)}`).toBe(true)
    }
  })

  it('holds both ends: a tiny file and one far past the ceiling', () => {
    expect(pieceLengthFor(1)).toBe(MIN_PIECE_LENGTH)
    expect(pieceLengthFor(1e15)).toBe(MAX_PIECE_LENGTH)
  })

  it('rejects a length that is not a power of two, in range', () => {
    expect(isValidPieceLength(1_500_000)).toBe(false)
    expect(isValidPieceLength(1024)).toBe(false)
    expect(isValidPieceLength(MAX_PIECE_LENGTH * 2)).toBe(false)
    expect(isValidPieceLength(MIN_PIECE_LENGTH)).toBe(true)
  })
})

/**
 * File order fixes every file's offset in the torrent, so it is part of the content.
 *
 * The pair below is the case that tells the two candidate rules apart. Compared segment by segment,
 * `a` sorts before `a.mkv` because the first segment decides it. Compared on the joined string,
 * `a.mkv` wins, because `.` (0x2E) sorts before `/` (0x2F). A torrent built on the second rule has
 * every offset after the first divergence shifted, and no peer agrees with it.
 */
describe('file order', () => {
  it('compares segment by segment rather than on the joined path', () => {
    const nested = { path: ['a', 'b.mkv'], size: 1 }
    const sibling = { path: ['a.mkv'], size: 1 }
    expect(compareSourceFiles(nested, sibling)).toBeLessThan(0)
    expect('a/b.mkv' < 'a.mkv').toBe(false)
  })

  it('puts a directory before its own deeper contents', () => {
    const shallow = { path: ['pack', 'a.mkv'], size: 1 }
    const deep = { path: ['pack', 'a.mkv', 'nope'], size: 1 }
    expect(compareSourceFiles(shallow, deep)).toBeLessThan(0)
  })

  it('sorts what plan() returns, whatever order it was handed', () => {
    const built = plan({
      name: 'Pack',
      files: [
        { path: ['c.mkv'], size: 1 },
        { path: ['a', 'inner.mkv'], size: 1 },
        { path: ['b.mkv'], size: 1 },
      ],
    })
    expect(built.files.map((f) => f.path.join('/'))).toEqual(['a/inner.mkv', 'b.mkv', 'c.mkv'])
  })
})

describe('planning a torrent', () => {
  const files = [{ path: ['E01.mkv'], size: 700_000_000 }, { path: ['E02.mkv'], size: 700_000_000 }]

  it('totals the sizes and counts the pieces from them', () => {
    const built = plan({ name: 'Pack', files })
    expect(built.totalBytes).toBe(1_400_000_000)
    expect(built.pieceCount).toBe(Math.ceil(1_400_000_000 / built.pieceLength))
  })

  /**
   * A folder holding one file stays a multi-file torrent. Collapsing it would extract as a bare file
   * and silently lose the directory the person picked, and `single` is about what was PICKED.
   */
  it('keeps the folder shape for a folder that happens to hold one file', () => {
    expect(plan({ name: 'Pack', files: [files[0]!] }).single).toBe(false)
    expect(plan({ name: 'E01.mkv', files: [files[0]!], single: true }).single).toBe(true)
  })

  it('takes a valid piece length override and refuses an invalid one', () => {
    expect(plan({ name: 'Pack', files, pieceLength: 1 << 20 }).pieceLength).toBe(1 << 20)
    expect(() => plan({ name: 'Pack', files, pieceLength: 1_500_000 })).toThrow(/piece length/)
  })

  it('refuses a name or a path that would escape the torrent on extraction', () => {
    expect(() => plan({ name: 'a/b', files })).toThrow(/not usable/)
    expect(() => plan({ name: '..', files })).toThrow(/not usable/)
    expect(() => plan({ name: '   ', files })).toThrow(/needs a name/)
    expect(() => plan({ name: 'Pack', files: [{ path: ['..', 'x'], size: 1 }] })).toThrow(/not a usable path/)
    expect(() => plan({ name: 'Pack', files: [{ path: [], size: 1 }] })).toThrow(/no path/)
  })

  it('refuses an empty torrent, and a single-file one carrying more than one file', () => {
    expect(() => plan({ name: 'Pack', files: [] })).toThrow(/at least one file/)
    expect(() => plan({ name: 'Pack', files, single: true })).toThrow(/exactly one file/)
  })

  /** A folder of empty files is a real thing to pick, and has no pieces rather than being an error. */
  it('handles a total of zero bytes without inventing a piece', () => {
    const built = plan({ name: 'Empty', files: [{ path: ['a'], size: 0 }] })
    expect(built.totalBytes).toBe(0)
    expect(built.pieceCount).toBe(0)
  })
})

const hashes = (count: number) => new Uint8Array(count * PIECE_HASH_BYTES).fill(7)

describe('encoding the info dictionary', () => {
  it('refuses a piece list that does not match the piece count', () => {
    const built = plan({ name: 'Pack', files: [{ path: ['a.mkv'], size: 5_000_000 }] })
    expect(() => encodeInfo({ plan: built, pieces: hashes(built.pieceCount - 1) })).toThrow(/piece hashes/)
    expect(() => encodeInfo({ plan: built, pieces: hashes(built.pieceCount) })).not.toThrow()
  })

  /**
   * The two shapes differ by where `length` sits, not by whether it appears: a multi-file torrent
   * carries one per entry inside `files`, so the thing that tells them apart is a length at the TOP
   * of the info dict. Asserting on the substring alone passes for the wrong reason.
   */
  it('uses a top-level length for a picked file and files for a picked folder', () => {
    const one = plan({ name: 'a.mkv', files: [{ path: ['a.mkv'], size: 5_000_000 }], single: true })
    const many = plan({ name: 'Pack', files: [{ path: ['a.mkv'], size: 5_000_000 }] })
    const single = ascii(encodeInfo({ plan: one, pieces: hashes(one.pieceCount) }))
    const folder = ascii(encodeInfo({ plan: many, pieces: hashes(many.pieceCount) }))
    // the info dict opens with `d`, and its keys are sorted, so a top-level length is the first key
    expect(single.startsWith('d6:lengthi5000000e')).toBe(true)
    expect(single).not.toContain('5:files')
    expect(folder.startsWith('d5:filesl')).toBe(true)
    expect(folder).toContain('6:lengthi5000000e')
  })

  /**
   * A public torrent carries NO `private` key, rather than `private: 0`.
   *
   * Both are legal and they are different info dicts, so they hash differently. Two people making
   * the same public torrent from the same files should get the same infohash, and would not if this
   * emitted a zero.
   */
  it('omits private entirely rather than writing a zero', async () => {
    const built = plan({ name: 'Pack', files: [{ path: ['a.mkv'], size: 5_000_000 }] })
    const pieces = hashes(built.pieceCount)
    const open = encodeInfo({ plan: built, pieces })
    const closed = encodeInfo({ plan: built, pieces, private: true })
    expect(ascii(open)).not.toContain('private')
    expect(ascii(closed)).toContain('7:privatei1e')
    expect(await infoHashOf(open)).not.toBe(await infoHashOf(closed))
  })
})

/**
 * The loop closed against the OTHER implementation.
 *
 * `readTorrentFile` is the decoder the share dialog already uses on strangers' files. It walks the
 * root dictionary itself, finds the `info` range in the raw bytes, and hashes THAT to get the
 * infohash. So passing it something this file produced checks the encoding against a reader that
 * shares no code with it, and the infohash it reports is an independent computation rather than a
 * repeat of the same call.
 */
describe('what another reader makes of it', () => {
  const built = plan({
    name: 'Some.Pack',
    files: [
      { path: ['E01.mkv'], size: 700_000_000 },
      { path: ['Subs', 'E01.ass'], size: 40_000 },
    ],
  })
  const trackers = ['udp://tracker.example:1337/announce', 'udp://other.example:6969/announce']
  const bytes = encodeTorrent({ plan: built, pieces: hashes(built.pieceCount), trackers, createdAt: 1_756_000_000, createdBy: 'Ripple' })

  it('reads back the name, the total and every file', async () => {
    const read = await readTorrentFile(bytes)
    expect(read).not.toBeNull()
    expect(read!.name).toBe('Some.Pack')
    expect(read!.size).toBe(700_040_000)
    /*
     * The name is PREFIXED onto every path, which is the convention rather than this decoder's
     * quirk: a multi-file torrent's `path` list is relative to `name`, and everything downstream
     * reads the joined form. `worker.ts`'s rootEntriesOf takes the first segment of exactly this to
     * find what a torrent occupies on disk, and `hybrid-storage.ts` resolves the whole of it against
     * the granted folder. Anything seeding a created torrent from its source directory therefore has
     * to drop that first segment, because the source handle IS that directory.
     */
    expect(read!.files!.map((f) => f.name)).toEqual(['Some.Pack/E01.mkv', 'Some.Pack/Subs/E01.ass'])
  })

  it('agrees on the infohash, computed from the bytes rather than from the builder', async () => {
    const read = await readTorrentFile(bytes)
    const mine = await infoHashOf(encodeInfo({ plan: built, pieces: hashes(built.pieceCount) }))
    expect(read!.magnet).toContain(`xt=urn:btih:${mine}`)
  })

  it('carries every tracker through, with the first one also in announce', async () => {
    const read = await readTorrentFile(bytes)
    for (const url of trackers) expect(read!.magnet).toContain(encodeURIComponent(url))
    expect(ascii(bytes)).toContain(`8:announce${trackers[0]!.length}:${trackers[0]}`)
  })

  it('reads back a single picked file too', async () => {
    const one = plan({ name: 'Movie.mkv', files: [{ path: ['Movie.mkv'], size: 5_000_000 }], single: true })
    const read = await readTorrentFile(encodeTorrent({ plan: one, pieces: hashes(one.pieceCount) }))
    expect(read!.name).toBe('Movie.mkv')
    expect(read!.size).toBe(5_000_000)
    expect(read!.files!.map((f) => f.name)).toEqual(['Movie.mkv'])
  })

  it('leaves out the optional fields that were not asked for', () => {
    const bare = ascii(encodeTorrent({ plan: built, pieces: hashes(built.pieceCount) }))
    expect(bare).not.toContain('creation date')
    expect(bare).not.toContain('created by')
    expect(bare).not.toContain('comment')
    expect(bare).not.toContain('announce')
  })
})

describe('the magnet for something already held', () => {
  it('names the torrent and carries its trackers', () => {
    const link = magnetFor({ infoHash: 'abc123', name: 'Some Pack', trackers: ['udp://t.example:1337'] })
    expect(link).toContain('xt=urn:btih:abc123')
    expect(link).toContain('dn=Some%20Pack')
    expect(link).toContain(`tr=${encodeURIComponent('udp://t.example:1337')}`)
  })
})

/**
 * WHERE THE PADS GO, and the one case where hybrid and v2 disagree.
 *
 * Every number below was read off libtorrent's own PARSER, `torrent_info(...).files()`, over the
 * reference torrents, not off its source and not off the specification. That matters because the
 * disagreement is invisible in the metainfo: a v2 info dict carries no file list at all, so Ripple's
 * bytes are identical either way, and the difference only shows up one layer down where reads are
 * served by index into libtorrent's parsed list.
 *
 * Getting it wrong is not subtle once it happens. A v2 torrent of a folder holding one file died
 * with `hybrid storage: /source/... has 1 handles for 2 files`, an I/O error and no progress.
 */
describe('where the pads go', () => {
  const padsFor = (files: { path: string[], size: number }[], format: 'v1' | 'hybrid' | 'v2') =>
    plan({ name: 'Pack', files, pieceLength: 65536, format }).files.filter((f) => f.pad).map((f) => f.size)

  const ONE_UNALIGNED = [{ path: ['only.mkv'], size: 100_000 }]

  it('puts none in a v1 torrent, whatever it holds', () => {
    expect(padsFor(ONE_UNALIGNED, 'v1')).toEqual([])
    expect(padsFor([{ path: ['a'], size: 1000 }, { path: ['b'], size: 2000 }], 'v1')).toEqual([])
  })

  it('follows every unaligned file, the LAST one included', () => {
    // 1000 -> 64536, then 2000 -> 63536: libtorrent emits the trailing pad since 2.0.8
    expect(padsFor([{ path: ['a'], size: 1000 }, { path: ['b'], size: 2000 }], 'hybrid'))
      .toEqual([64536, 63536])
  })

  it('emits none after a file that already ends on a boundary', () => {
    expect(padsFor([{ path: ['a'], size: 65536 }, { path: ['b'], size: 65536 }], 'hybrid')).toEqual([])
  })

  it('emits none after an EMPTY file, which cannot move the offset', () => {
    expect(padsFor([{ path: ['a-empty'], size: 0 }, { path: ['z'], size: 100_000 }], 'hybrid'))
      .toEqual([31_072])
  })

  /**
   * THE ONE THAT DIFFERS. A hybrid's file list is read straight out of the v1 `files` key, which
   * libtorrent's creator leaves unpadded for a single file; a v2 torrent has no such key, so the
   * parser builds the list itself and pads unconditionally.
   */
  it('pads a lone unaligned file for v2 and NOT for hybrid', () => {
    expect(padsFor(ONE_UNALIGNED, 'hybrid')).toEqual([])
    expect(padsFor(ONE_UNALIGNED, 'v2')).toEqual([31_072])
  })

  it('pads a lone file for neither when it already lands on a boundary', () => {
    const aligned = [{ path: ['exact.bin'], size: 65536 }]
    expect(padsFor(aligned, 'hybrid')).toEqual([])
    expect(padsFor(aligned, 'v2')).toEqual([])
  })

  /** Padding fills a piece to its boundary, so it can never add one. The screen shows the same count. */
  it('never changes the piece count', () => {
    for (const format of ['hybrid', 'v2'] as const) {
      expect(plan({ name: 'Pack', files: ONE_UNALIGNED, pieceLength: 65536, format }).pieceCount)
        .toBe(plan({ name: 'Pack', files: ONE_UNALIGNED, pieceLength: 65536, format: 'v1' }).pieceCount)
    }
  })
})

/**
 * A SINGLE-FILE torrent renamed in the dialog, which is one gesture away and used to be refused.
 *
 * The name box is free text and its own comment says a later edit is the person's. In the v1 form
 * that renames the file, because `name` IS the filename. A hybrid describes the same file twice, so
 * the v2 file tree has to be keyed by the same string or libtorrent compares the two lists index by
 * index, finds different names and refuses the whole torrent with `torrent_inconsistent_files`,
 * after the entire file has been hashed.
 */
describe('renaming a single-file torrent', () => {
  const build = async (name: string) => {
    const p = plan({ name, files: [{ path: ['one.bin'], size: 40 }], single: true, pieceLength: 65536, format: 'hybrid' })
    const pieces = new Uint8Array(p.pieceCount * PIECE_HASH_BYTES).fill(7)
    const fileHashes = [{ root: new Uint8Array(32).fill(9), layer: [] }]
    return new TextDecoder('latin1').decode(encodeTorrent({ plan: p, pieces, fileHashes }))
  }

  it('names the file tree entry after the torrent, not after the file that was picked', async () => {
    const renamed = await build('Renamed.bin')
    // once as `name`, once as the file tree's only key
    expect(renamed.split('11:Renamed.bin').length - 1).toBe(2)
    expect(renamed).not.toContain('one.bin')
  })

  it('leaves an unedited name describing the same file it always did', async () => {
    const same = await build('one.bin')
    expect(same.split('7:one.bin').length - 1).toBe(2)
  })

  /** A multi-file torrent has no such constraint: its tree is relative to the name. */
  it('does not rewrite paths in a multi-file torrent', async () => {
    const p = plan({
      name: 'Renamed',
      files: [{ path: ['a.bin'], size: 40 }, { path: ['b.bin'], size: 40 }],
      pieceLength: 65536,
      format: 'hybrid',
    })
    const pieces = new Uint8Array(p.pieceCount * PIECE_HASH_BYTES).fill(7)
    const fileHashes = [0, 1].map(() => ({ root: new Uint8Array(32).fill(9), layer: [] }))
    const text = new TextDecoder('latin1').decode(encodeTorrent({ plan: p, pieces, fileHashes }))
    expect(text).toContain('a.bin')
    expect(text).toContain('b.bin')
  })
})

