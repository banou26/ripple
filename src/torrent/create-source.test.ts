import type { PickedFile } from './walk-source'

import { describe, expect, it } from 'vitest'

import { DEFAULT_TRACKERS, buildTorrent, normalizeWebSeeds, optionsError } from './create-source'
import { PIECE_HASH_BYTES, plan } from './make-torrent'
import { readTorrentFile } from './torrent-file'

const handle = (name: string) => ({ kind: 'file', name } as unknown as FileSystemFileHandle)

const picked = (path: string[], size: number): PickedFile =>
  ({ path, size, lastModified: 1_000, handle: handle(path.join('/')) })

const options = (over: Partial<Parameters<typeof optionsError>[0]> = {}) =>
  ({ name: 'Pack', trackers: [...DEFAULT_TRACKERS], private: false, ...over })

describe('what a created torrent is allowed to say', () => {
  it('accepts the defaults it ships with', () => {
    expect(optionsError(options())).toBeNull()
  })

  it('needs a name that can be a directory', () => {
    expect(optionsError(options({ name: '  ' }))).toMatch(/name/)
    expect(optionsError(options({ name: 'a/b' }))).toMatch(/slash/)
  })

  /**
   * Private turns off the DHT, peer exchange and local discovery, so private with no tracker is a
   * torrent that by construction nobody can find. Refused rather than allowed, because the result
   * looks exactly like a torrent that is merely unlucky and would be debugged as one.
   */
  it('refuses private with no tracker, and allows private with one', () => {
    expect(optionsError(options({ private: true, trackers: [] }))).toMatch(/private/)
    expect(optionsError(options({ private: true, trackers: ['udp://t.example:1337'] }))).toBeNull()
  })

  it('allows public with no tracker, which the DHT can still reach', () => {
    expect(optionsError(options({ trackers: [] }))).toBeNull()
  })

  it('refuses a bare hostname, which libtorrent would drop without saying so', () => {
    expect(optionsError(options({ trackers: ['tracker.example:1337'] }))).toMatch(/not a tracker address/)
    expect(optionsError(options({ trackers: ['http://t.example/announce'] }))).toBeNull()
    expect(optionsError(options({ trackers: ['wss://t.example/announce'] }))).toBeNull()
  })

  it('ignores blank lines in the tracker field', () => {
    expect(optionsError(options({ trackers: ['', '  ', 'udp://t.example:1337'] }))).toBeNull()
  })
})

const hashesFor = (files: PickedFile[], name: string, single = false) => {
  const built = plan({ name, files: files.map(({ path, size }) => ({ path, size })), single })
  return { built, pieces: new Uint8Array(built.pieceCount * PIECE_HASH_BYTES).fill(3) }
}

describe('assembling the torrent', () => {
  const files = [picked(['E01.mkv'], 700_000_000), picked(['Subs', 'E01.ass'], 40_000)]

  it('produces bytes another reader agrees with', async () => {
    const { pieces } = hashesFor(files, 'Pack')
    const out = await buildTorrent({ picked: files, pieces, options: options(), single: false })
    const read = await readTorrentFile(out.bytes)
    expect(read!.name).toBe('Pack')
    expect(read!.size).toBe(700_040_000)
    expect(out.magnet).toContain(`xt=urn:btih:${out.infoHash}`)
  })

  it('names its files the way the rest of the library does', async () => {
    const { pieces } = hashesFor(files, 'Pack')
    const out = await buildTorrent({ picked: files, pieces, options: options(), single: false })
    expect(out.files.map((f) => f.name)).toEqual(['Pack/E01.mkv', 'Pack/Subs/E01.ass'])
  })

  /**
   * The failure this exists to stop: reads are served by `fileIndex`, which is the position in the
   * TORRENT, while the walk collects handles in whatever order the platform iterated. A handle list
   * left in walk order serves one file's bytes for another, every piece fails its hash, and it only
   * happens for a folder whose iteration order differs from its sort order.
   */
  it('reorders the handles to the torrent order, not the order they were walked in', async () => {
    const walked = [picked(['z.mkv'], 10), picked(['a.mkv'], 10)]
    const { pieces } = hashesFor(walked, 'Pack')
    const out = await buildTorrent({ picked: walked, pieces, options: options(), single: false })
    expect(out.plan.files.map((f) => f.path.join('/'))).toEqual(['a.mkv', 'z.mkv'])
    expect(out.handles.map((h) => h.name)).toEqual(['a.mkv', 'z.mkv'])
  })

  it('carries the trackers into both the file and the magnet', async () => {
    const { pieces } = hashesFor(files, 'Pack')
    const out = await buildTorrent({ picked: files, pieces, options: options({ trackers: ['udp://t.example:1337'] }), single: false })
    expect(out.magnet).toContain(encodeURIComponent('udp://t.example:1337'))
    const read = await readTorrentFile(out.bytes)
    expect(read!.magnet).toContain(encodeURIComponent('udp://t.example:1337'))
  })

  it('gives a private torrent a different infohash from the same files public', async () => {
    const { pieces } = hashesFor(files, 'Pack')
    const open = await buildTorrent({ picked: files, pieces, options: options(), single: false })
    const closed = await buildTorrent({ picked: files, pieces, options: options({ private: true }), single: false })
    expect(open.infoHash).not.toBe(closed.infoHash)
  })

  it('says nothing about who made it or when', async () => {
    const { pieces } = hashesFor(files, 'Pack')
    const out = await buildTorrent({ picked: files, pieces, options: options(), single: false })
    const text = new TextDecoder().decode(out.bytes)
    expect(text).not.toContain('created by')
    expect(text).not.toContain('creation date')
    expect(text).not.toContain('comment')
  })

  it('builds the single-file shape for one picked file', async () => {
    const one = [picked(['Movie.mkv'], 5_000_000)]
    const { pieces } = hashesFor(one, 'Movie.mkv', true)
    const out = await buildTorrent({ picked: one, pieces, options: options({ name: 'Movie.mkv' }), single: true })
    const read = await readTorrentFile(out.bytes)
    expect(read!.files!.map((f) => f.name)).toEqual(['Movie.mkv'])
    expect(out.plan.single).toBe(true)
  })

  /** The read-back is a real check, so it has to be able to fail: a wrong piece count is refused. */
  it('refuses a piece list that does not describe these files', async () => {
    const { pieces } = hashesFor(files, 'Pack')
    await expect(buildTorrent({
      picked: files,
      pieces: pieces.subarray(0, pieces.length - PIECE_HASH_BYTES),
      options: options(),
      single: false,
    })).rejects.toThrow(/piece hashes/)
  })
})

/**
 * The fields qBittorrent's creator offers, and the one that changes the torrent's identity.
 */
describe('the rest of the metainfo', () => {
  const files = [picked(['E01.mkv'], 700_000_000)]

  /*
   * The pieces have to be hashed at the SAME piece length the build will use, or the count will not
   * match and the encoder refuses it. That refusal is correct and is tested elsewhere; here it would
   * just be the helper being wrong.
   */
  const build = async (over: Partial<Parameters<typeof optionsError>[0]> = {}, single = false) => {
    const built = plan({
      name: 'Pack',
      files: files.map(({ path, size }) => ({ path, size })),
      single,
      pieceLength: over.pieceLength,
    })
    const pieces = new Uint8Array(built.pieceCount * PIECE_HASH_BYTES).fill(3)
    return buildTorrent({ picked: files, pieces, options: options(over), single })
  }

  it('carries a comment, and omits the key entirely when empty', async () => {
    expect(new TextDecoder().decode((await build({ comment: 'ripped from the disc' })).bytes)).toContain('ripped from the disc')
    expect(new TextDecoder().decode((await build()).bytes)).not.toContain('comment')
  })

  /**
   * `source` is INSIDE the info dict, which is its entire purpose: the same files with a different
   * source are a different torrent, so a private tracker can keep its swarm to itself. It follows
   * that it must reach the encoding that gets HASHED, and this file previously encoded the info dict
   * twice, which is exactly the shape where a new field reaches one and not the other.
   */
  it('makes source change the infohash, not just the file', async () => {
    const plain = await build()
    const tagged = await build({ source: 'SOMETRACKER' })
    expect(tagged.infoHash).not.toBe(plain.infoHash)
    expect(new TextDecoder().decode(tagged.bytes)).toContain('SOMETRACKER')
  })

  /** The read-back check is what proves the hashed bytes and the shipped bytes are the same ones. */
  it('still reads back as the torrent it claims to be with a source set', async () => {
    const tagged = await build({ source: 'SOMETRACKER' })
    const read = await readTorrentFile(tagged.bytes)
    expect(read!.magnet).toContain(`xt=urn:btih:${tagged.infoHash}`)
  })

  it('writes web seeds as url-list, and refuses one that is not http', async () => {
    expect(new TextDecoder().decode((await build({ webSeeds: ['https://example.test/files'] })).bytes)).toContain('url-list')
    expect(optionsError(options({ webSeeds: ['udp://example.test'] }))).toMatch(/web seed/)
    expect(optionsError(options({ webSeeds: ['https://example.test/files'] }))).toBeNull()
  })

  it('takes a piece size and refuses one no torrent can use', async () => {
    expect((await build({ pieceLength: 1 << 22 })).plan.pieceLength).toBe(1 << 22)
    expect(optionsError(options({ pieceLength: 1_500_000 }))).toMatch(/piece size/)
  })
})

/**
 * BEP 19 makes a web seed url mean different things in the two torrent shapes, and getting it wrong
 * fails silently: the client builds a url nobody serves and the seed contributes nothing, which
 * looks exactly like a seed that is down.
 */
describe('web seed urls', () => {
  it('gives a multi-file torrent a trailing slash, since the name is appended to it', () => {
    expect(normalizeWebSeeds(['https://e.test/files'], false)).toEqual(['https://e.test/files/'])
    expect(normalizeWebSeeds(['https://e.test/files/'], false)).toEqual(['https://e.test/files/'])
  })

  it('takes the slash OFF a single-file torrent, where the url names the file itself', () => {
    expect(normalizeWebSeeds(['https://e.test/movie.mkv/'], true)).toEqual(['https://e.test/movie.mkv'])
    expect(normalizeWebSeeds(['https://e.test/movie.mkv'], true)).toEqual(['https://e.test/movie.mkv'])
  })

  it('drops blank lines', () => {
    expect(normalizeWebSeeds(['', '  ', 'https://e.test/a'], true)).toEqual(['https://e.test/a'])
  })
})
