import { readFile } from 'fs/promises'
import { describe, expect, it } from 'vitest'
import { readMagnet, readTorrentFile } from '../../src/torrent/torrent-file'

const REAL = {
  path: '/home/banou/downloads/single-file.torrent',
  infoHash: 'f00dfacef00dfacef00dfacef00dfacef00dface',
}
const bencode = (s: string) => new TextEncoder().encode(s)

describe('reading a share subject without the engine', () => {
  it('reads a real single-file torrent whole', async () => {
    const bytes = await readFile(REAL.path).catch(() => null)
    if (!bytes) { expect.soft(true, 'the owner\'s file is not on this machine').toBe(true); return }
    const s = await readTorrentFile(new Uint8Array(bytes))
    expect(s!.magnet).toContain(REAL.infoHash)
    expect(s!.name).toContain('Single File')
    expect(s!.files!.length).toBe(1)
    expect(s!.size).toBeGreaterThan(1_000_000_000)
    expect(s!.magnet).toContain('tr=')
  })

  it('reads a multi-file torrent, joining each path onto the name', async () => {
    const doc = bencode('d8:announce9:udp://a:14:infod5:filesld6:lengthi10e4:pathl1:a5:b.mkveed6:lengthi20e4:pathl5:c.srteee4:name4:packee')
    const s = await readTorrentFile(doc)
    expect(s!.files).toEqual([
      { name: 'pack/a/b.mkv', size: 10, index: 0 },
      { name: 'pack/c.srt', size: 20, index: 1 },
    ])
    expect(s!.size).toBe(30)
    expect(s!.name).toBe('pack')
    expect(s!.fileCount).toBe(2)
  })

  /*
   * A PAD between the two files, which is where the index and the position part company.
   *
   * A share link names files by ENGINE index, and this list drops the pads, so numbering it 0..n-1
   * pointed the link at the wrong file for everything after the first pad. The indices here are
   * deliberately NON-CONTIGUOUS, and `fileCount` counts the pad, because `compileFileSelection`
   * discards any index at or above the count it is given.
   */
  it('numbers the files it keeps by their engine index, not by their place in the list', async () => {
    const doc = bencode(
      'd8:announce9:udp://a:14:infod5:filesl'
      + 'd6:lengthi10e4:pathl1:a5:b.mkveed'
      + '6:lengthi16e4:attr1:p4:pathl4:.pad2:16eed'
      + '6:lengthi20e4:pathl5:c.srteee'
      + '4:name4:packee',
    )
    const s = await readTorrentFile(doc)
    expect(s!.files).toEqual([
      { name: 'pack/a/b.mkv', size: 10, index: 0 },
      { name: 'pack/c.srt', size: 20, index: 2 },
    ])
    // the pad is nobody's data, so it is out of the list and out of the total
    expect(s!.size).toBe(30)
    // but it is still a file the engine numbers, so an index can legitimately reach 2
    expect(s!.fileCount).toBe(3)
  })

  it('builds a magnet carrying the name and every tracker tier', async () => {
    const doc = bencode('d8:announce5:udp:a13:announce-listll5:udp:ael5:udp:bee4:infod6:lengthi5e4:name1:xee')
    const s = await readTorrentFile(doc)
    expect(s!.magnet).toMatch(/^magnet:\?xt=urn:btih:[0-9a-f]{40}&/)
    expect(s!.magnet).toContain('dn=x')
    // announce repeats the first tier, so three sources collapse to two trackers
    expect([...s!.magnet.matchAll(/tr=/g)].length).toBe(2)
    expect(s!.magnet).toContain('tr=udp%3Aa')
    expect(s!.magnet).toContain('tr=udp%3Ab')
  })

  it('returns null for anything that is not a torrent', async () => {
    for (const bad of [new Uint8Array(), bencode('l4:infoe'), bencode('d8:announce5:aaaaae'), bencode('<!doctype html>')]) {
      await expect(readTorrentFile(bad)).resolves.toBeNull()
    }
  })

  it('takes a magnet and says the file list is unknown rather than guessing', () => {
    const s = readMagnet('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel')
    expect(s!.name).toBe('Sintel')
    expect(s!.files).toBeNull()
    expect(s!.size).toBe(0)
  })

  it('falls back to the infohash when a magnet carries no name', () => {
    expect(readMagnet('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10')!.name)
      .toBe('08ada5a7a6183aae1e09d831df6748d566095a10')
  })

  it('refuses text that is not a magnet', () => {
    for (const bad of ['', 'hello', 'http://example.com', 'magnet:?dn=x']) expect(readMagnet(bad), bad).toBeNull()
  })

  /**
   * A pasted magnet is stored percent-encoded, because the link built from it is base64 and base64
   * of anything above U+00FF throws. Plenty of sites put the release name on the clipboard with its
   * own characters intact, so this is an ordinary paste rather than a hostile one.
   */
  it('normalizes a magnet whose display name is not ASCII', () => {
    const s = readMagnet('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=映画の題名')!
    expect(() => btoa(s.magnet)).not.toThrow()
    // and the name is still readable, because the reader decodes what the writer encoded
    expect(s.name).toBe('映画の題名')
  })

  it('leaves an already-encoded magnet as it found it', () => {
    const raw = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'
    expect(readMagnet(raw)!.magnet).toBe(raw)
  })
})
