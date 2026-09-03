import type { FileHashes } from './merkle'
import type { SourceFile, TorrentPlan } from './make-torrent'

import { PIECE_HASH_BYTES, contentFiles, hasV1, hasV2 } from './make-torrent'
import { V2_BLOCK_BYTES, merkleTree, sha256 } from './merkle'

/**
 * Hashing the picked files into a torrent's `pieces`.
 *
 * A piece is a fixed-size window over the CONCATENATION of every file in plan order, so it happily
 * straddles a file boundary and the last piece of a torrent is usually short. That is the whole of
 * the difficulty here, and it is why this walks a single cursor over all the files rather than
 * hashing each file on its own.
 *
 * Reading is injected. The rule is the same whether the bytes come from a picker-granted directory,
 * from OPFS, or from an array in a test, and the rule is the part that can be wrong in ways nobody
 * notices: a wrong boundary produces a torrent whose hashes match nothing, which looks exactly like
 * a torrent that works until a peer asks for a piece. So the walk is testable without a disk.
 */

/** Reads exactly `length` bytes at `offset` from one file, or throws. */
export type ReadFile = (file: SourceFile, offset: number, length: number) => Promise<Uint8Array>

export type HashProgress = {
  hashedBytes: number
  totalBytes: number
  /** How many pieces are finished. */
  pieces: number
  pieceCount: number
  /** The file being read, for a progress line that says something more useful than a percentage. */
  path: string
}

export type HashOptions = {
  signal?: AbortSignal
  onProgress?: (progress: HashProgress) => void
  /**
   * Largest single read. Bounds peak memory to this plus one piece, which matters because a piece
   * can be 16 MiB and a folder can be hundreds of gigabytes.
   *
   * Not smaller: `hybrid-storage.ts` measured a picker-granted read at 39 to 48 MB/s for 16 KiB
   * blocks, about 390 microseconds each, and that cost is per call rather than per byte. Reading in
   * megabytes makes the per-call overhead disappear instead of paying it a million times.
   */
  maxReadBytes?: number
}

const DEFAULT_MAX_READ = 4 * 1024 * 1024

export class HashCancelled extends Error {
  constructor() {
    super('hashing cancelled')
    this.name = 'HashCancelled'
  }
}

const sha1 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  // sliced into its own buffer for the same reason torrent-file.ts does it: ripple is cross-origin
  // isolated, so a view can sit on a SharedArrayBuffer, which is not a BufferSource
  new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array(bytes).buffer))

/**
 * What one pass over the picked bytes produces, for whichever formats the plan asked for.
 *
 * ONE pass, not two, and that is the whole reason these live in the same return value. A hybrid
 * torrent needs a SHA-1 over a fixed window of the concatenated stream and a SHA-256 tree per file,
 * over the same bytes, and reading a folder twice to compute them separately would double the only
 * expensive part of creating a torrent. It would also give the two halves two chances to disagree
 * about what they read, which is the failure that publishes cleanly and fails every piece.
 */
export type HashedContent = {
  /** The v1 `pieces`, over the PADDED stream. Empty for a v2-only torrent, which carries none. */
  pieces: Uint8Array
  /** One merkle tree per CONTENT file, in plan order. Empty for a v1 torrent. */
  fileHashes: FileHashes[]
}

/**
 * One pass over the picked bytes, producing whatever the plan's format asks for.
 *
 * Progress is reported per piece rather than per read, so a caller gets a steady stream on a big
 * torrent and exactly one report on a tiny one. A cancel is checked at the same points, which bounds
 * how long a cancel takes to one piece plus one read rather than to the whole pass.
 *
 * PAD FILES ARE NEVER READ. They are zeroes by definition, so they are written straight into the
 * piece buffer and the read callback never hears about them, which is what lets the same callback
 * serve a plan of any format. They also contribute nothing to the merkle side: a pad is not one of
 * the person's files, has no tree, and appears in no file tree.
 */
export const hashPieces = async (
  plan: TorrentPlan,
  read: ReadFile,
  { signal, onProgress, maxReadBytes = DEFAULT_MAX_READ }: HashOptions = {},
): Promise<HashedContent> => {
  const wantV1 = hasV1(plan.format)
  const wantV2 = hasV2(plan.format)
  const out = new Uint8Array(wantV1 ? plan.pieceCount * PIECE_HASH_BYTES : 0)
  const fileHashes: FileHashes[] = []

  // A torrent of nothing but empty files has no pieces and is not an error, and neither has any
  // file a tree. Returning here also keeps the loop below from describing a cursor over zero bytes.
  if (!plan.pieceCount) {
    // still one entry per file, so the encoder's count check stays a real check
    if (wantV2) for (let i = 0; i < contentFiles(plan).length; i++) fileHashes.push({ root: null, layer: [] })
    return { pieces: out, fileHashes }
  }

  const piece = new Uint8Array(wantV1 ? plan.pieceLength : 0)
  let filled = 0
  let done = 0
  let hashedBytes = 0
  let path = plan.files[0]!.path.join('/')

  const stop = () => { if (signal?.aborted) throw new HashCancelled() }
  const report = () => onProgress?.({ hashedBytes, totalBytes: plan.totalBytes, pieces: done, pieceCount: plan.pieceCount, path })

  const finish = async (length: number) => {
    if (wantV1) {
      const digest = await sha1(piece.subarray(0, length))
      out.set(digest, done * PIECE_HASH_BYTES)
    }
    done += 1
    filled = 0
    report()
  }

  /**
   * A v2 leaf is 16 KiB of ONE FILE, so this buffer resets at every file boundary rather than
   * running with the piece cursor. The last leaf of a file is hashed SHORT, never zero-filled.
   */
  const block = new Uint8Array(wantV2 ? V2_BLOCK_BYTES : 0)
  let blockFilled = 0
  let leaves: Uint8Array[] = []

  const takeBlocks = async (chunk: Uint8Array) => {
    let at = 0
    while (at < chunk.length) {
      const take = Math.min(V2_BLOCK_BYTES - blockFilled, chunk.length - at)
      block.set(chunk.subarray(at, at + take), blockFilled)
      blockFilled += take
      at += take
      if (blockFilled === V2_BLOCK_BYTES) { leaves.push(await sha256(block)); blockFilled = 0 }
    }
  }

  stop()
  for (const file of plan.files) {
    path = file.path.join('/')

    if (file.pad) {
      // zeroes, with no read and no leaf. The piece buffer is reused between pieces, so this has to
      // WRITE the zeroes rather than merely skip past them.
      let left = file.size
      while (left > 0) {
        stop()
        const take = Math.min(plan.pieceLength - filled, left)
        if (wantV1) piece.fill(0, filled, filled + take)
        filled += take
        left -= take
        if (filled === plan.pieceLength) await finish(plan.pieceLength)
      }
      continue
    }

    leaves = []
    blockFilled = 0
    let at = 0
    while (at < file.size) {
      stop()
      // exactly what this piece still wants, capped so one read cannot be 16 MiB on top of the
      // piece buffer that is already held
      const want = Math.min(wantV1 ? plan.pieceLength - filled : maxReadBytes, file.size - at, maxReadBytes)
      const chunk = await read(file, at, want)
      /*
       * A short read is a hard error rather than something to zero-fill.
       *
       * It means the file on disk is smaller than the size this plan was built from, which happens
       * for an ordinary reason: the person edited, replaced or truncated it while the pass was
       * running. Padding would produce a torrent whose hashes describe bytes that were never there,
       * and the failure would surface much later as a peer rejecting every piece.
       */
      if (chunk.length !== want) {
        throw new Error(`${path} gave ${chunk.length} bytes of the ${want} at ${at}: the file changed while it was being read`)
      }
      if (wantV1) piece.set(chunk, filled)
      if (wantV2) await takeBlocks(chunk)
      filled += want
      at += want
      hashedBytes += want
      if (wantV1 && filled === plan.pieceLength) await finish(plan.pieceLength)
      else if (!wantV1) report()
    }

    if (wantV2) {
      if (blockFilled > 0) leaves.push(await sha256(block.subarray(0, blockFilled)))
      fileHashes.push(await merkleTree(leaves, file.size, plan.pieceLength))
    }
  }

  // the last piece of almost every torrent, and the only piece of a small one. A v2-aware torrent
  // whose last file needed a pad has already landed exactly on a boundary, so this is a no-op there.
  if (wantV1 && filled > 0) await finish(filled)

  if (wantV1 && done !== plan.pieceCount) {
    throw new Error(`hashed ${done} pieces where the plan wanted ${plan.pieceCount}: the files no longer add up to ${plan.paddedBytes} bytes`)
  }
  if (wantV2 && fileHashes.length !== contentFiles(plan).length) {
    throw new Error(`built ${fileHashes.length} merkle trees for ${contentFiles(plan).length} files`)
  }
  return { pieces: out, fileHashes }
}

/**
 * Seconds remaining, from the bytes done so far. Undefined until there is enough to divide by.
 *
 * Its own function because a progress dialog that shows a wrong estimate is worse than one that
 * shows none, and "enough to divide by" is the rule worth testing rather than inlining.
 */
export const hashEta = (progress: HashProgress, elapsedMs: number): number | undefined => {
  if (elapsedMs < 1_000 || progress.hashedBytes <= 0) return undefined
  const rate = progress.hashedBytes / (elapsedMs / 1_000)
  if (rate <= 0) return undefined
  return Math.round((progress.totalBytes - progress.hashedBytes) / rate)
}
