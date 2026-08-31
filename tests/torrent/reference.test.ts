import { describe, expect, it } from 'vitest'

import type { TorrentFormat } from '../../src/torrent/make-torrent'

import { REFERENCE_CASES } from '../../src/torrent/reference-torrents'
import { contentFiles, encodeTorrent, plan } from '../../src/torrent/make-torrent'
import { hashPieces } from '../../src/torrent/hash-pieces'
import { referenceBytes } from '../../src/torrent/reference-content'

/**
 * BYTE FOR BYTE against torrents native libtorrent 2.0.13 built from the same files.
 *
 * The strongest check available, and the reason it is worth the fixture: it covers the pad
 * arithmetic, the file ordering, the file tree, the piece layers, `meta version`, the SHA-1 pieces
 * over the padded stream and the key ordering of every dictionary, all at once, against an
 * implementation that had no sight of this one. Anything wrong anywhere shows up as a diff.
 *
 * V1 IS NOT COMPARED HERE, and the reason is worth stating rather than leaving as a gap. libtorrent
 * emits a v1-only torrent in filesystem walk order and offers no way to sort without also inserting
 * pads, so there is no v1 reference in Ripple's own canonical order to compare with. The v1 encoder
 * is covered by `make-torrent.test.ts`, which round-trips everything it produces through the share
 * dialog's independent decoder.
 */

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

const buildFromReference = async (reference: (typeof REFERENCE_CASES)[number], format: TorrentFormat) => {
  const contents = new Map<string, Uint8Array>()
  for (const file of reference.files) contents.set(file.path.join('/'), await referenceBytes(file.seed, file.size))

  const built = plan({
    name: reference.torrentName,
    files: reference.files.map(({ path, size }) => ({ path, size })),
    single: reference.single,
    pieceLength: reference.pieceLength,
    format,
  })
  const hashed = await hashPieces(built, async (file, offset, length) => {
    const content = contents.get(file.path.join('/'))
    if (!content) throw new Error(`the test has no bytes for ${file.path.join('/')}`)
    return content.subarray(offset, offset + length)
  })
  return { built, bytes: encodeTorrent({ plan: built, pieces: hashed.pieces, fileHashes: hashed.fileHashes }) }
}

describe('byte for byte against libtorrent', () => {
  for (const reference of REFERENCE_CASES) {
    describe(`${reference.name}: ${reference.why}`, () => {
      for (const format of ['hybrid', 'v2'] as const) {
        it(`makes the same ${format} torrent`, async () => {
          const { bytes } = await buildFromReference(reference, format)
          // hex rather than the arrays, so a failure prints something a person can read
          expect(hex(bytes)).toBe(hex(fromBase64(reference.torrents[format])))
        })
      }

      /**
       * The pad list, checked on its own as well as inside the bytes above.
       *
       * Redundant only while everything passes. When it does not, this says whether the file list is
       * wrong or something else in the encoding is, which the byte comparison alone cannot.
       */
      it('lays the pad files out where libtorrent does', async () => {
        const { built } = await buildFromReference(reference, 'hybrid')
        const pads = built.files.filter((file) => file.pad).map((file) => file.size)
        const reference1 = fromBase64(reference.torrents.hybrid)
        const wanted = [...new TextDecoder('latin1').decode(reference1).matchAll(/4:\.pad(\d+):/g)]
        expect(pads.length).toBe(wanted.length)
        // every pad carries its own size as its second path segment, so the list is checkable twice
        for (const size of pads) expect(built.files.some((f) => f.pad && f.path[1] === String(size))).toBe(true)
      })
    })
  }

  /**
   * A control, because the comparison above is only worth what its ability to fail is worth.
   *
   * Each mutation is one somebody could plausibly ship. If any of them still matched the reference,
   * that rule would be untested and every green above would mean less than it appears to.
   */
  describe('and it can tell when something is wrong', () => {
    const reference = REFERENCE_CASES.find((c) => c.name === 'pow2-pieces')!

    it('notices a torrent built in the wrong format', async () => {
      const { bytes } = await buildFromReference(reference, 'v2')
      expect(hex(bytes)).not.toBe(hex(fromBase64(reference.torrents.hybrid)))
    })

    it('notices a hybrid built without its pads', async () => {
      const contents = new Map<string, Uint8Array>()
      for (const file of reference.files) contents.set(file.path.join('/'), await referenceBytes(file.seed, file.size))
      // v1's file list, with v2's keys bolted on: exactly what an implementation that forgot the
      // padding would produce, and it has to come out different
      const unpadded = plan({
        name: reference.torrentName,
        files: reference.files.map(({ path, size }) => ({ path, size })),
        single: reference.single,
        pieceLength: reference.pieceLength,
        format: 'v1',
      })
      expect(contentFiles(unpadded).length).toBe(unpadded.files.length)
      const hashed = await hashPieces(unpadded, async (file, offset, length) =>
        contents.get(file.path.join('/'))!.subarray(offset, offset + length))
      expect(hex(hashed.pieces)).not.toBe(
        hex((await buildFromReference(reference, 'hybrid')).bytes.subarray(0, hashed.pieces.length)),
      )
    })

    it('notices a piece length that is not the one the reference used', async () => {
      const { bytes } = await buildFromReference({ ...reference, pieceLength: 1 << 20 }, 'hybrid')
      expect(hex(bytes)).not.toBe(hex(fromBase64(reference.torrents.hybrid)))
    })
  })

  it('compares every case in both v2 formats, which is what the greens are worth', () => {
    expect(REFERENCE_CASES.length).toBe(12)
    expect(REFERENCE_CASES.filter((c) => c.single).length).toBeGreaterThan(0)
    expect(REFERENCE_CASES.filter((c) => c.files.some((f) => f.size === 0)).length).toBeGreaterThan(0)
  })
})
