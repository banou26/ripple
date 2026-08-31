/**
 * The BEP 52 merkle tree: what a v2 torrent says about one file.
 *
 * A v1 torrent hashes a fixed window over the concatenation of every file, so a piece happily
 * straddles a file boundary. A v2 torrent does the opposite: each file is hashed on its own, into a
 * binary tree of SHA-256 over 16 KiB blocks, and the torrent carries that tree's root. Nothing about
 * one shape carries over to the other, which is why this is its own module rather than an option on
 * `hash-pieces.ts`.
 *
 * EVERY RULE HERE WAS CHECKED AGAINST NATIVE LIBTORRENT 2.0.13 rather than read off the BEP alone.
 * Nine reference torrents were built with libtorrent's own creator over fixtures chosen so each rule
 * runs at least once, and each rule was then broken on purpose to confirm the reference catches it:
 * a leaf fill of `SHA-256(zeros)` rather than zeros is caught 12 times, a piece-level fill of zeros
 * rather than the pad hash 5 times, a zero-padded last block 26 times, and either padding rule
 * applied unconditionally 6 and 13 times. `merkle.test.ts` carries those vectors.
 *
 * That mattered, because the two padding values below are DIFFERENT and using one where the other
 * belongs produces a root that looks perfectly plausible and matches nothing.
 */

/**
 * A leaf is 16 KiB of file, whatever the piece length is.
 *
 * Fixed by BEP 52 and not derived from anything: a 16 MiB piece is 1024 leaves and a 16 KiB piece is
 * one. It is also the block size a peer requests, which is the point of choosing it.
 */
export const V2_BLOCK_BYTES = 16 * 1024

export const V2_HASH_BYTES = 32

/** Thirty-two zero bytes. The LEAF fill, and the seed the piece-level fill is grown from. */
const ZERO_HASH = new Uint8Array(V2_HASH_BYTES)

export const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  // sliced into its own buffer for the same reason torrent-file.ts does it: ripple is cross-origin
  // isolated, so a view can sit on a SharedArrayBuffer, which is not a BufferSource
  new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer as ArrayBuffer))

const pair = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const out = new Uint8Array(V2_HASH_BYTES * 2)
  out.set(left, 0)
  out.set(right, V2_HASH_BYTES)
  return out
}

/** How many 16 KiB blocks fit in a piece. One at the smallest piece length, 1024 at the largest. */
export const blocksPerPiece = (pieceLength: number): number => Math.max(1, Math.floor(pieceLength / V2_BLOCK_BYTES))

const nextPowerOfTwo = (value: number): number => {
  let size = 1
  while (size < value) size *= 2
  return size
}

/**
 * How many leaves a file's tree holds once padded, which is NOT one rule but two.
 *
 * A file no larger than one piece is padded to the next power of two of its own leaf count, so a
 * 1000-byte file has a tree of exactly one leaf and its root IS that leaf's hash. A larger file is
 * padded to a whole number of PIECES instead, so the tree has a layer where each node covers exactly
 * one piece, which is the layer `piece layers` publishes.
 *
 * Applying either rule to both cases is caught by the reference vectors, 6 times one way and 13 the
 * other, which is the only reason to trust the distinction rather than the reading that produced it.
 */
export const paddedLeafCount = (size: number, pieceLength: number): number => {
  const leaves = Math.ceil(size / V2_BLOCK_BYTES)
  if (leaves <= 0) return 0
  if (size <= pieceLength) return nextPowerOfTwo(leaves)
  return Math.ceil(size / pieceLength) * blocksPerPiece(pieceLength)
}

/**
 * The value that fills an unused slot at the PIECE layer and above: 32 zero bytes carried up
 * `levels` times, where each step is `SHA-256(h || h)`.
 *
 * It is the root of a subtree of nothing, and that is exactly why it differs from the leaf fill. A
 * missing leaf is 32 zero bytes; a missing PIECE is what a piece of 32-zero-byte leaves hashes to.
 * At the smallest piece length the two coincide, because `levels` is 0 and the loop never runs,
 * which is precisely why a fixture at 16 KiB pieces cannot tell a correct implementation from a
 * wrong one.
 */
export const padHashFor = async (levels: number): Promise<Uint8Array> => {
  let hash: Uint8Array = ZERO_HASH
  for (let i = 0; i < levels; i++) hash = await sha256(pair(hash, hash))
  return hash
}

const layerUp = async (nodes: Uint8Array[]): Promise<Uint8Array[]> => {
  const out: Uint8Array[] = []
  for (let i = 0; i < nodes.length; i += 2) out.push(await sha256(pair(nodes[i]!, nodes[i + 1]!)))
  return out
}

export type FileHashes = {
  /** The `pieces root` this file gets in the file tree. Null for a zero-length file, which gets none. */
  root: Uint8Array | null
  /**
   * One hash per piece of this file, for the top-level `piece layers` dictionary.
   *
   * EMPTY for any file of one piece or less, which is a rule rather than an optimisation: a torrent
   * carrying an entry no file's root matches is rejected outright, while one MISSING an entry for a
   * multi-piece file loads, looks healthy and can never verify. Only one of those two mistakes says
   * anything, so the emptiness is asserted rather than assumed.
   */
  layer: Uint8Array[]
}

/**
 * The tree for one file, given the hashes of its blocks in order.
 *
 * Takes leaf hashes rather than bytes so the walk that reads a disk stays in one place. The caller
 * hashes each 16 KiB block as it streams past, and the LAST block of a file is hashed SHORT, never
 * zero-filled to 16 KiB. That distinction is worth more than it looks: filling it produces a root
 * for a file that nobody else computes, and the reference vectors catch it 26 times.
 */
export const merkleTree = async (
  leaves: Uint8Array[], size: number, pieceLength: number,
): Promise<FileHashes> => {
  // A zero-length file has no tree and no `pieces root`. libtorrent writes its `length` and nothing
  // else, and it takes part in no piece.
  if (size <= 0 || !leaves.length) return { root: null, layer: [] }

  const wanted = paddedLeafCount(size, pieceLength)
  if (leaves.length > wanted) {
    throw new Error(`merkle: ${leaves.length} leaves for a file of ${size} bytes that wants at most ${wanted}`)
  }
  let nodes = [...leaves]
  while (nodes.length < wanted) nodes.push(ZERO_HASH)

  // up to the layer where one node covers one piece, counting the levels so the fill above knows
  // how tall a subtree it is standing in for
  const perPiece = blocksPerPiece(pieceLength)
  let levels = 0
  while (nodes.length > 1 && (1 << levels) < perPiece) {
    nodes = await layerUp(nodes)
    levels += 1
  }
  const layer = size > pieceLength ? [...nodes] : []

  // and on to the root, filling an odd level with a whole missing PIECE rather than a missing leaf
  let filler = await padHashFor(levels)
  while (nodes.length > 1) {
    if (nodes.length % 2) nodes = [...nodes, filler]
    nodes = await layerUp(nodes)
    filler = await sha256(pair(filler, filler))
  }
  return { root: nodes[0]!, layer }
}

/** The whole tree for one file's BYTES, for a caller that already holds them. */
export const merkleTreeOf = async (
  content: Uint8Array, pieceLength: number,
): Promise<FileHashes> => {
  const leaves: Uint8Array[] = []
  for (let at = 0; at < content.length; at += V2_BLOCK_BYTES) {
    leaves.push(await sha256(content.subarray(at, Math.min(at + V2_BLOCK_BYTES, content.length))))
  }
  return merkleTree(leaves, content.length, pieceLength)
}
