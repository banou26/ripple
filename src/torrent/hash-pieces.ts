import type { SourceFile, TorrentPlan } from './make-torrent'

import { PIECE_HASH_BYTES } from './make-torrent'

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
  new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array(bytes).buffer as ArrayBuffer))

/**
 * Every piece hash, concatenated, ready to be the info dict's `pieces`.
 *
 * Progress is reported per piece rather than per read, so a caller gets a steady stream on a big
 * torrent and exactly one report on a tiny one. A cancel is checked at the same points, which bounds
 * how long a cancel takes to one piece plus one read rather than to the whole pass.
 */
export const hashPieces = async (
  plan: TorrentPlan,
  read: ReadFile,
  { signal, onProgress, maxReadBytes = DEFAULT_MAX_READ }: HashOptions = {},
): Promise<Uint8Array> => {
  const out = new Uint8Array(plan.pieceCount * PIECE_HASH_BYTES)
  // A torrent of nothing but empty files has no pieces and is not an error. Returning here also
  // keeps the loop below from having to describe a cursor over zero bytes.
  if (!plan.pieceCount) return out

  const piece = new Uint8Array(plan.pieceLength)
  let filled = 0
  let done = 0
  let hashedBytes = 0
  let path = plan.files[0]!.path.join('/')

  const stop = () => { if (signal?.aborted) throw new HashCancelled() }
  const report = () => onProgress?.({ hashedBytes, totalBytes: plan.totalBytes, pieces: done, pieceCount: plan.pieceCount, path })

  const finish = async (length: number) => {
    const digest = await sha1(piece.subarray(0, length))
    out.set(digest, done * PIECE_HASH_BYTES)
    done += 1
    filled = 0
    report()
  }

  stop()
  for (const file of plan.files) {
    path = file.path.join('/')
    let at = 0
    while (at < file.size) {
      stop()
      // exactly what this piece still wants, capped so one read cannot be 16 MiB on top of the
      // piece buffer that is already held
      const want = Math.min(plan.pieceLength - filled, file.size - at, maxReadBytes)
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
      piece.set(chunk, filled)
      filled += want
      at += want
      hashedBytes += want
      if (filled === plan.pieceLength) await finish(plan.pieceLength)
    }
  }

  // the last piece of almost every torrent, and the only piece of a small one
  if (filled > 0) await finish(filled)

  if (done !== plan.pieceCount) {
    throw new Error(`hashed ${done} pieces where the plan wanted ${plan.pieceCount}: the files no longer add up to ${plan.totalBytes} bytes`)
  }
  return out
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
