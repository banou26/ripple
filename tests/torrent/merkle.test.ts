import { describe, expect, it } from 'vitest'

import { REFERENCE_CASES } from '../../src/torrent/reference-torrents'
import { referenceBytes } from '../../src/torrent/reference-content'
import { V2_BLOCK_BYTES, blocksPerPiece, merkleTree, merkleTreeOf, padHashFor, paddedLeafCount, sha256 } from '../../src/torrent/merkle'

/**
 * The merkle rules, against torrents NATIVE libtorrent built.
 *
 * This is the one part of a v2 torrent where a wrong answer is indistinguishable from a right one by
 * inspection: every candidate rule produces 32 plausible bytes. So nothing here asserts a property,
 * it asserts agreement with somebody else's implementation over fixtures picked so each rule runs.
 * `reference-torrents.ts` says how they were made and what each case is for.
 */

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('how many leaves a file gets', () => {
  it('pads a file no bigger than one piece to the next power of two of its own blocks', () => {
    expect(paddedLeafCount(1, 65536)).toBe(1)
    expect(paddedLeafCount(V2_BLOCK_BYTES, 65536)).toBe(1)
    expect(paddedLeafCount(V2_BLOCK_BYTES + 1, 65536)).toBe(2)
    expect(paddedLeafCount(V2_BLOCK_BYTES * 3, 65536)).toBe(4)
    expect(paddedLeafCount(65536, 65536)).toBe(4)
  })

  /** The other rule, and the whole reason this function is not one line. */
  it('pads a larger file to a whole number of PIECES instead', () => {
    expect(paddedLeafCount(65537, 65536)).toBe(8)
    expect(paddedLeafCount(65536 * 3 + 1, 65536)).toBe(16)
  })

  it('gives a zero length file no tree at all', () => {
    expect(paddedLeafCount(0, 65536)).toBe(0)
  })

  it('counts blocks per piece from the piece length, never below one', () => {
    expect(blocksPerPiece(V2_BLOCK_BYTES)).toBe(1)
    expect(blocksPerPiece(65536)).toBe(4)
    expect(blocksPerPiece(16 * 1024 * 1024)).toBe(1024)
  })
})

describe('the two padding values, which are not the same value', () => {
  it('leaves the pad hash as 32 zero bytes when a piece is one block', async () => {
    expect(hex(await padHashFor(0))).toBe('0'.repeat(64))
  })

  /**
   * The mistake this catches: using 32 zero bytes where a whole missing PIECE belongs. It produces a
   * root that looks right and matches nothing, and at a 16 KiB piece length the two coincide, so a
   * fixture at the default piece size cannot tell them apart.
   */
  it('grows it by one SHA-256 of itself doubled per level, so it is not the leaf fill', async () => {
    const zero = new Uint8Array(32)
    const once = await padHashFor(1)
    expect(hex(once)).toBe(hex(await sha256(new Uint8Array([...zero, ...zero]))))
    expect(hex(once)).not.toBe(hex(zero))
    expect(hex(await padHashFor(2))).toBe(hex(await sha256(new Uint8Array([...once, ...once]))))
  })
})

describe('against torrents libtorrent itself built', () => {
  for (const reference of REFERENCE_CASES) {
    describe(`${reference.name}: ${reference.why}`, () => {
      for (const file of reference.files) {
        /*
         * An explicit timeout, because the biggest of these sits ON the default one.
         *
         * `big.bin` is 2,097,157 bytes and hashing it into a full merkle tree took 5006 ms against
         * vitest's 5000 ms default: it passes run alone and fails in a full suite, where the workers
         * share a machine. Measured three times before this was read as a timeout rather than as a
         * wrong hash, and it would have been an intermittent red in the CI gate this suite is about
         * to become. The number is generous on purpose; what is being bought is a stable verdict, not
         * a fast one.
         */
        it(`${file.path.join('/')} at ${file.size} bytes`, async () => {
          const content = await referenceBytes(file.seed, file.size)
          const tree = await merkleTreeOf(content, reference.pieceLength)
          expect(tree.root === null ? null : hex(tree.root)).toBe(file.root)
          expect(tree.layer.map(hex)).toEqual(file.layer)
        }, 60_000)
      }
    })
  }

  /**
   * A count, so a fixture that silently stopped describing anything cannot pass by describing
   * nothing. Both numbers were read off the reference and both have to move together with it.
   */
  it('covers every rule at least once, which is what makes the greens above mean anything', () => {
    const files = REFERENCE_CASES.flatMap((c) => c.files)
    expect(files.length).toBe(30)
    // a piece layer only exists above one piece, and it is where the piece-level pad hash is used
    expect(files.filter((f) => f.layer.length).length).toBe(10)
    // an odd piece count is what forces an incomplete level to be filled
    expect(files.some((f) => f.layer.length % 2 === 1 && f.layer.length > 1)).toBe(true)
    expect(files.some((f) => f.size === 0)).toBe(true)
    expect(REFERENCE_CASES.some((c) => c.pieceLength === V2_BLOCK_BYTES)).toBe(true)
    expect(REFERENCE_CASES.some((c) => c.pieceLength >= 1024 * 1024)).toBe(true)
    expect(REFERENCE_CASES.some((c) => c.single)).toBe(true)
  })
})

describe('what merkleTree refuses', () => {
  it('will not build a tree from more leaves than the file can have', async () => {
    const leaf = await sha256(new Uint8Array(1))
    await expect(merkleTree([leaf, leaf, leaf], 100, 65536)).rejects.toThrow(/leaves/)
  })

  it('answers a zero length file with no root and no layer', async () => {
    expect(await merkleTree([], 0, 65536)).toEqual({ root: null, layer: [] })
  })
})
