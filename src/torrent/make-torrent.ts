/**
 * Building a `.torrent` from files the user picked, with no engine involved.
 *
 * `libtorrent-wasm` exposes no torrent-creation call: the three add functions take a magnet, a
 * `.torrent` or a resume blob, and nothing builds metainfo. So the metainfo is assembled here, in
 * JavaScript, and handed to `addTorrentFile` like any other torrent.
 *
 * Everything in this file is pure. The reading and hashing live in `hash-pieces.ts`, which is the
 * part that needs a disk and a clock; the rules that decide what the torrent SAYS are here so they
 * can be tested on their own, which is how the rest of this directory is arranged.
 *
 * The encoder is deliberately separate from the decoder in `torrent-file.ts` rather than sharing a
 * value type with it. The decoder's job is to survive whatever a stranger's file contains, so it is
 * permissive; an encoder's job is to emit exactly one canonical form. Merging them would mean one
 * of the two giving up its reason for existing. `make-torrent.test.ts` closes the loop by decoding
 * everything this produces with the OTHER file's decoder, which is worth more than shared code.
 */

import type { FileHashes } from './merkle'

const encoder = new TextEncoder()

/**
 * Bytes that are ALREADY bencoded and get spliced in exactly as they are.
 *
 * This exists for one value, `info`, and it is what keeps the torrent honest. The infohash is the
 * SHA-1 of the encoded `info`, and the reader on the other side does not re-encode anything: it
 * finds that value's byte range in the file and hashes what is there. So the bytes that were hashed
 * and the bytes that were embedded have to be the same bytes, not two encodings of one object that
 * ought to agree.
 *
 * Without it a `Uint8Array` holding an encoded dict is indistinguishable from a byte string, and
 * gets a length prefix: `4:info306:d5:files...`, a torrent whose `info` is a string rather than a
 * dictionary. Every reader rejects it. `make-torrent.test.ts` caught exactly that by decoding the
 * output with the share dialog's decoder, which is the whole reason that test decodes rather than
 * comparing strings.
 */
const RAW = Symbol('already bencoded')
export type Raw = { [RAW]: Uint8Array }
export const raw = (encoded: Uint8Array): Raw => ({ [RAW]: encoded })

export type Bencodable =
  | number
  | string
  | Uint8Array
  | Raw
  | Bencodable[]
  | { [key: string]: Bencodable | undefined }
  /**
   * A dictionary whose keys are BYTES rather than text, which `piece layers` needs and no v1 field
   * does: its keys are raw 32-byte SHA-256 roots, and putting one through `TextEncoder` would mangle
   * every byte above 0x7f into a replacement character.
   */
  | Map<string | Uint8Array, Bencodable | undefined>

const INT = encoder.encode('i')
const END = encoder.encode('e')
const LIST = encoder.encode('l')
const DICT = encoder.encode('d')
const COLON = encoder.encode(':')

/**
 * Dictionary keys are ordered as RAW BYTE STRINGS, which is not the same as a locale comparison and
 * not always the same as JavaScript's `<` on strings either.
 *
 * It matters more than a formatting detail. The infohash is the SHA-1 of the bencoded `info` value,
 * so a single pair in the wrong order produces a different infohash for the same content: every
 * peer computes one number and this client another, and the torrent simply never connects to
 * anything. Comparing the encoded bytes is the definition, so that is what this does.
 */
const compareKeys = (a: Uint8Array, b: Uint8Array): number => {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const d = a[i]! - b[i]!
    if (d !== 0) return d
  }
  return a.length - b.length
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

const bytes = (value: string | Uint8Array): Uint8Array =>
  typeof value === 'string' ? encoder.encode(value) : value

const string = (value: string | Uint8Array): Uint8Array => {
  const raw = bytes(value)
  // the length prefix counts BYTES, not characters, which is the whole reason this goes through
  // TextEncoder rather than String.length
  return concat([encoder.encode(String(raw.length)), COLON, raw])
}

const integer = (value: number): Uint8Array => {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`bencode: ${value} is not an integer, and bencode has no float`)
  }
  // A torrent over 9 petabytes is not the case worth handling; a SILENT wrong length is. Above
  // 2^53 an ordinary number stops being able to hold a file size exactly, and the encoded value
  // would be quietly off.
  if (!Number.isSafeInteger(value)) throw new Error(`bencode: ${value} is past exact integer range`)
  return concat([INT, encoder.encode(String(value)), END])
}

export const bencode = (value: Bencodable): Uint8Array => {
  if (typeof value === 'number') return integer(value)
  if (typeof value === 'string' || value instanceof Uint8Array) return string(value)
  if (Array.isArray(value)) return concat([LIST, ...value.map(bencode), END])
  // before the dictionary branch, since a Raw is an object and its one entry is not a key to encode
  if (RAW in value) return (value as Raw)[RAW]

  if (value instanceof Map) {
    const binary = [...value.entries()]
      .filter((entry): entry is [string | Uint8Array, Bencodable] => entry[1] !== undefined)
      .map(([key, item]) => ({ key: bytes(key), item }))
      .sort((a, b) => compareKeys(a.key, b.key))
    return concat([DICT, ...binary.flatMap((entry) => [string(entry.key), bencode(entry.item)]), END])
  }

  // undefined entries are dropped rather than encoded, so an optional field is expressed by simply
  // not passing it and every caller does not need its own conditional spread
  const pairs = Object.entries(value)
    .filter((entry): entry is [string, Bencodable] => entry[1] !== undefined)
    .map(([key, item]) => ({ key: encoder.encode(key), item }))
    .sort((a, b) => compareKeys(a.key, b.key))

  return concat([DICT, ...pairs.flatMap((pair) => [string(pair.key), bencode(pair.item)]), END])
}

/** A file to put in the torrent: its path BELOW the chosen folder, and its size. */
export type SourceFile = {
  /** Path segments below the picked directory. One segment for a file sitting directly in it. */
  path: string[]
  size: number
  /**
   * A PAD FILE: not the person's data, but zeroes a v2-aware torrent inserts to push the next file
   * onto a piece boundary. Nothing reads it, nothing shows it, and nobody downloads it.
   *
   * Carried in the same list as real files rather than kept apart, because it occupies a real range
   * of the byte stream the v1 piece hashes cover, and because libtorrent reports it as an ordinary
   * file with an ordinary index. A separate list would mean two orderings that have to agree, which
   * is the shape that silently serves one file's bytes for another.
   */
  pad?: true
}

/**
 * Which of the two metainfo formats a torrent speaks.
 *
 * `v1` is BEP 3, SHA-1 over pieces that straddle file boundaries, and what every client understands.
 * `v2` is BEP 52: SHA-256 merkle trees per file, so a file can be verified on its own and identical
 * files are recognised across torrents. `hybrid` carries both, in one file, with one set of bytes,
 * and is what qBittorrent creates by default.
 *
 * Hybrid costs padding. Each file is pushed to a piece boundary so the two views agree on where
 * pieces fall, which adds up to one piece per file, so a pick of many small files pays real overhead
 * and the dialog says so before anybody agrees to it.
 */
export type TorrentFormat = 'v1' | 'hybrid' | 'v2'

/** Both v2 formats carry `meta version`, `file tree` and `piece layers`; only `v2` drops the v1 half. */
export const hasV2 = (format: TorrentFormat): boolean => format !== 'v1'
export const hasV1 = (format: TorrentFormat): boolean => format !== 'v2'

export const MIN_PIECE_LENGTH = 16 * 1024
/**
 * The largest piece a torrent may declare here, matching what qBittorrent's creator offers.
 *
 * This was 16 MiB, with a comment saying anything larger is refused outright by enough clients to be
 * a ceiling rather than a preference. That was wrong on both counts. libtorrent's own limit is
 * `file_storage::max_piece_size`, `((1 << 15) - 1) * 0x4000`, which is about 512 MiB, and
 * qBittorrent has offered 32, 64 and 128 MiB for years.
 *
 * MEASURED before raising it, because the real question is not what the format permits but what
 * Ripple's engine can hold: `disk_io` allocates a whole piece per hash job and libtorrent submits
 * several at once while checking, against a 2 GiB wasm heap. A 128 MiB-piece torrent of two full
 * pieces plus a tail, built by native libtorrent, verified to 100 per cent in 1.1 seconds as v1 and
 * 2.1 as hybrid, with the whole node process under 1 GiB resident.
 *
 * It is a real choice rather than a free one, and the dialog says so: a piece is the smallest thing
 * a peer can give you, so a 128 MiB piece means a stream waits 128 MiB for its first frame and a
 * failed hash costs 128 MiB of re-download.
 */
export const MAX_PIECE_LENGTH = 128 * 1024 * 1024

/**
 * Around this many pieces, which is the count other clients aim for too.
 *
 * The tradeoff runs both ways and neither end is free. Larger pieces make a smaller `.torrent`,
 * because `pieces` is 20 bytes per piece and nothing compresses it, and they make hashing and
 * verification cheaper. Smaller pieces make a stream start sooner: `stream-plan.ts` sizes its
 * deadline window from the piece length, so the first frame waits on one piece arriving, and they
 * also waste less on a piece that fails its hash.
 */
const TARGET_PIECES = 1500

const nextPowerOfTwo = (value: number): number => {
  let size = MIN_PIECE_LENGTH
  while (size < value && size < MAX_PIECE_LENGTH) size *= 2
  return size
}

/**
 * The piece length for a torrent of this size: a power of two, in range, aiming at TARGET_PIECES.
 *
 * A power of two is not required by BEP 3, and is required in practice. Enough clients and trackers
 * assume one that a torrent with, say, a 1.5 MB piece length is a torrent that some people cannot
 * use, for no benefit at all.
 */
export const pieceLengthFor = (totalBytes: number): number => {
  if (totalBytes <= 0) return MIN_PIECE_LENGTH
  return Math.min(MAX_PIECE_LENGTH, Math.max(MIN_PIECE_LENGTH, nextPowerOfTwo(Math.ceil(totalBytes / TARGET_PIECES))))
}

export const isValidPieceLength = (value: number): boolean =>
  Number.isInteger(value)
  && value >= MIN_PIECE_LENGTH
  && value <= MAX_PIECE_LENGTH
  && (value & (value - 1)) === 0

/**
 * Path segments compare byte by byte, SEGMENT BY SEGMENT, rather than on the joined string.
 *
 * Joining first gets the order wrong wherever a separator sorts against a filename character:
 * `a/b.mkv` against `a.mkv/b`, for instance, orders differently depending on whether the `/` is
 * part of the comparison. The file order in `files` is what fixes every file's offset inside the
 * torrent, so it is part of the content rather than a presentation choice, and a rule that is
 * almost right produces a torrent whose offsets nobody else agrees with.
 */
export const compareSourceFiles = (a: SourceFile, b: SourceFile): number => {
  const shared = Math.min(a.path.length, b.path.length)
  for (let i = 0; i < shared; i++) {
    const d = compareKeys(encoder.encode(a.path[i]!), encoder.encode(b.path[i]!))
    if (d !== 0) return d
  }
  return a.path.length - b.path.length
}

export type TorrentPlan = {
  /** The torrent's `name`: the picked folder, or the picked file. */
  name: string
  format: TorrentFormat
  /**
   * In the order their offsets follow, which is the order they are encoded in.
   *
   * INCLUDES the pad files for a v2-aware format, because that is the order libtorrent indexes by.
   * Anything wanting the person's own files wants `contentFiles`.
   */
  files: SourceFile[]
  /** What the person picked. Pads are not content, so they are not counted here. */
  totalBytes: number
  /** What the pieces cover: `totalBytes` plus every pad. The same number for a v1 torrent. */
  paddedBytes: number
  pieceLength: number
  pieceCount: number
  /** A lone file directly in the picked folder still gets the multi-file shape; see `plan`. */
  single: boolean
}

/** The person's own files, without the padding a hybrid torrent inserts between them. */
export const contentFiles = (plan: TorrentPlan): SourceFile[] => plan.files.filter((file) => !file.pad)

/**
 * Whether the folder the person picked will NOT survive this torrent, through no fault of the bytes.
 *
 * A v2 `file tree` cannot express "one file, inside a folder called this". libtorrent decides between
 * the two shapes in `extract_files2`:
 *
 *     bool const single_file = leaf_node && !has_files && tree.dict_size() == 1;
 *     std::string path = single_file ? std::string() : root_dir;
 *
 * `root_dir` is the torrent's `name`, and `has_files` is whether a v1 `files` list is present. So a
 * top level holding exactly one leaf, with no v1 half to say otherwise, DISCARDS the name and the
 * file lands on its own. A hybrid of the same content keeps the folder purely because its `files`
 * list makes `has_files` true.
 *
 * This is not something Ripple can encode its way out of. The reference matrix pins that our bytes
 * for this shape are identical to the ones native libtorrent writes, so every libtorrent client will
 * read it the same way, and nesting the folder into the tree makes libtorrent join it to the name and
 * emit `Pack/Pack/only.mkv` instead. The honest move is to say so before the torrent is made.
 *
 * A file in a SUBfolder is unaffected: the top level entry is then a directory rather than a leaf, so
 * `leaf_node` is false and the name is kept.
 */
export const dropsFolderName = (plan: TorrentPlan): boolean => {
  if (plan.format !== 'v2' || plan.single) return false
  const content = contentFiles(plan)
  return content.length === 1 && content[0]!.path.length === 1
}

export type PlanRequest = {
  name: string
  files: SourceFile[]
  /** One picked FILE rather than a folder, which is the only case that takes the single-file shape. */
  single?: boolean
  /** Overrides the automatic choice. Rejected unless it is a power of two in range. */
  pieceLength?: number
  /** Defaults to `v1`, so every existing caller keeps the torrent it was making. */
  format?: TorrentFormat
}

/**
 * The zeroes that carry the offset to the next piece boundary, or 0 when it is already on one.
 *
 * Its own function because it is the arithmetic a hybrid torrent lives or dies by: a pad one byte
 * out shifts every file after it, so libtorrent's two file lists no longer describe the same bytes
 * and the torrent is refused at add time with `torrent_inconsistent_files`.
 */
export const padLengthFor = (offsetAfterFile: number, pieceLength: number): number =>
  (pieceLength - (offsetAfterFile % pieceLength)) % pieceLength

/**
 * Where the pads go, which is TWO rules, because the writer and the reader do not use the same one.
 *
 * A pad follows every non-empty file that does not already end on a piece boundary, the last one
 * included. What differs is the single-file case, and it differs by format:
 *
 *  - **hybrid**: no pads at all when the torrent holds ONE file, even a folder holding one unaligned
 *    file. That is what libtorrent's creator writes into the v1 `files` list, and a hybrid's file
 *    list is read straight back out of it, so Ripple has to match it exactly or the torrent is
 *    refused as inconsistent.
 *  - **v2**: a pad even for one file. A v2-only torrent carries no `files` list, so libtorrent
 *    SYNTHESIZES the list from the file tree on parse, and that path pads unconditionally.
 *
 * The distinction is invisible in the metainfo, which is what made it expensive: Ripple's v2 output
 * is byte-identical to libtorrent's either way, because a v2 info dict has no file list to disagree
 * about. It shows up one layer down, where reads are served BY INDEX into libtorrent's parsed list.
 * Getting it wrong left a v2 torrent of a one-file folder dead on arrival with
 * `has 1 handles for 2 files`, an I/O error and no progress, measured in the browser.
 *
 * Both halves were read off libtorrent's own parser rather than its source: `folder-one-file`,
 * `one-byte` and `single-file` all report one file as hybrid and two as v2, while
 * `single-file-exact`, which lands on a boundary and needs no pad, reports one either way.
 */
const withPads = (files: SourceFile[], pieceLength: number, format: TorrentFormat): SourceFile[] => {
  if (files.length <= 1 && format !== 'v2') return files
  const out: SourceFile[] = []
  let offset = 0
  for (const file of files) {
    out.push(file)
    offset += file.size
    const pad = file.size > 0 ? padLengthFor(offset, pieceLength) : 0
    if (pad > 0) {
      // two pads of one size collide on this path, legally: nothing ever opens them by name
      out.push({ path: ['.pad', String(pad)], size: pad, pad: true })
      offset += pad
    }
  }
  return out
}

/**
 * What the torrent will contain, decided before a single byte is read.
 *
 * Everything the progress display and the confirmation need comes from here, so the person sees the
 * file count, the total and the piece count before agreeing to anything, rather than after a hashing
 * pass has already run.
 *
 * SINGLE VERSUS MULTI is about what was PICKED, not about how many files turned up. A folder holding
 * one file is a multi-file torrent whose `files` has one entry, so that unpacking it recreates the
 * folder; collapsing it to the single-file shape would silently drop the directory the person chose.
 * Only picking a file itself gives the single-file shape.
 */
export const plan = ({ name, files, single = false, pieceLength, format = 'v1' }: PlanRequest): TorrentPlan => {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('a torrent needs a name')
  // `/` in a name is how a malicious or careless torrent escapes its own directory on extraction.
  // Nothing in the picker produces one, so this is about never being the client that emits it.
  if (trimmed.includes('/') || trimmed === '.' || trimmed === '..') {
    throw new Error(`${trimmed} is not usable as a torrent name`)
  }
  if (!files.length) throw new Error('a torrent needs at least one file')
  for (const file of files) {
    if (!file.path.length) throw new Error('a file with no path')
    if (file.path.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('/'))) {
      throw new Error(`${file.path.join('/')} is not a usable path inside a torrent`)
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error(`${file.path.join('/')} has no usable size`)
  }
  if (single && files.length !== 1) throw new Error('a single-file torrent holds exactly one file')

  const sorted = single ? files : [...files].sort(compareSourceFiles)
  const totalBytes = sorted.reduce((sum, file) => sum + file.size, 0)
  const chosen = pieceLength ?? pieceLengthFor(totalBytes)
  if (!isValidPieceLength(chosen)) {
    throw new Error(`${chosen} is not a usable piece length: wants a power of two from ${MIN_PIECE_LENGTH} to ${MAX_PIECE_LENGTH}`)
  }

  /*
   * The pads are decided HERE, with the rest of the file list, and not later.
   *
   * They change every offset after the first of them, so they change which bytes each piece covers
   * and therefore every piece hash. A pass that hashed the unpadded stream and an encoder that
   * described the padded one would produce a torrent that is internally consistent, publishes
   * without complaint, and fails every piece any peer ever asks for.
   */
  const laid = hasV2(format) ? withPads(sorted, chosen, format) : sorted
  const paddedBytes = laid.reduce((sum, file) => sum + file.size, 0)

  return {
    name: trimmed,
    format,
    files: laid,
    totalBytes,
    paddedBytes,
    pieceLength: chosen,
    // Zero total is a real case: a folder of empty files. It has no pieces, and `Math.ceil(0 / n)`
    // is already 0, so this needs no special case, only the note that it is not an oversight.
    pieceCount: pieceCountFor(paddedBytes, chosen),
    single,
  }
}

export type MetainfoRequest = {
  plan: TorrentPlan
  /** The concatenated raw 20-byte SHA-1 digests, in piece order. Not hex. Absent for `v2`. */
  pieces?: Uint8Array
  /**
   * One merkle tree per CONTENT file, in plan order. Required for `hybrid` and `v2`, unused for `v1`.
   *
   * Content files, so the list skips the pads: a pad in the `file tree` is not merely pointless, it
   * is rejected outright as `torrent_invalid_pad_file`.
   */
  fileHashes?: FileHashes[]
  /** Announce urls, in the order the user gave them. Empty means a torrent that relies on the DHT. */
  trackers?: string[]
  /** Keeps the torrent to its trackers: no DHT, no peer exchange, no local discovery. */
  private?: boolean
  /**
   * A private tracker's tag, and the ONLY optional field that goes inside the info dict.
   *
   * That placement is the whole point of it rather than a detail: being inside means it changes the
   * infohash, so the same files with a different source are a different torrent and a tracker can
   * keep its swarm to itself. It also means somebody who sets it casually gets a torrent that shares
   * with nobody, so the interface has to say what it does rather than name it.
   */
  source?: string
  /** BEP 19 `url-list`: http sources the whole torrent can be fetched from. Top level, not in info. */
  webSeeds?: string[]
  /** Unix SECONDS. Omitted entirely when not passed, and the caller decides whether to. */
  createdAt?: number
  createdBy?: string
  comment?: string
}

/**
 * How many pieces a torrent of this size gets at this piece length.
 *
 * Exported and shared rather than inlined, because the dialog shows this number before anything is
 * hashed and `plan()` computes the one the encoder uses. Two copies of `ceil(a / b)` look impossible
 * to get wrong until one of them is fed the size before exclusions and the other after, and then the
 * screen and the torrent disagree with nothing to say which is real.
 */
export const pieceCountFor = (totalBytes: number, pieceLength: number): number =>
  pieceLength > 0 ? Math.ceil(Math.max(0, totalBytes) / pieceLength) : 0

export const PIECE_HASH_BYTES = 20

/**
 * The v2 `file tree`: the same files as `files`, arranged as nested dictionaries by path segment.
 *
 * A file's own entry sits under the EMPTY STRING key, which is what lets a directory and a file
 * share a namespace without ambiguity. A zero-length file gets its `length` and no `pieces root`,
 * because it has no blocks and takes part in no piece.
 *
 * Built on null-prototype objects rather than `{}` on purpose. A path segment is whatever the
 * operating system handed over, and assigning `__proto__` on an ordinary object literal sets the
 * prototype instead of adding a key, so a file with that name would vanish from the torrent while
 * every count still agreed.
 */
const fileTree = (plan: TorrentPlan, hashes: FileHashes[]): Bencodable => {
  const root = Object.create(null) as Record<string, Bencodable>
  contentFiles(plan).forEach((file, index) => {
    /*
     * A SINGLE-FILE torrent's tree is keyed by the torrent's NAME, not by the picked file's name.
     *
     * In the single-file shape those are the same thing: the v1 half writes `length` and `name`, and
     * `name` IS the filename. So a person editing the name in the dialog renames the file, which is
     * what the v1 form has always done. Keying the tree by the ORIGINAL filename instead makes the
     * two halves describe files with different names, and libtorrent compares them index by index
     * and refuses the whole torrent with `torrent_inconsistent_files`. Measured against the real
     * engine: identical names add cleanly, a rename returns -2, after the entire file has been
     * hashed and with nothing on screen naming the cause.
     */
    const path = plan.single ? [plan.name] : file.path
    let node = root
    for (const segment of path.slice(0, -1)) {
      if (!(segment in node)) node[segment] = Object.create(null) as Record<string, Bencodable>
      node = node[segment] as Record<string, Bencodable>
    }
    const tree = hashes[index]
    if (!tree) throw new Error(`no merkle tree for ${path.join('/')}`)
    node[path[path.length - 1]!] = {
      '': { length: file.size, 'pieces root': tree.root ?? undefined },
    }
  })
  return root
}

/**
 * The top-level `piece layers`: one entry per file of MORE THAN ONE PIECE, keyed by its own root.
 *
 * Both mistakes here are worth naming because only one of them says anything. An entry no file's
 * root matches is a hard parse failure. A MISSING entry for a multi-piece file parses cleanly, marks
 * the hashes as present, and produces a torrent that looks healthy and can never verify a byte.
 *
 * Always written for a v2-aware torrent even when it is empty, matching what libtorrent emits, and
 * the empty dictionary is a real difference in the file rather than a formatting choice.
 */
const pieceLayers = (hashes: FileHashes[]): Map<string | Uint8Array, Bencodable> => {
  const out = new Map<string, { key: Uint8Array, value: Uint8Array }>()
  for (const tree of hashes) {
    if (!tree.root || !tree.layer.length) continue
    // two identical files share a root and therefore one entry, which is correct: the value is the
    // same bytes either way, and a dictionary cannot hold the key twice
    out.set(hexOf(tree.root), { key: tree.root, value: concat(tree.layer) })
  }
  return new Map([...out.values()].map((entry) => [entry.key, entry.value]))
}

/**
 * The `info` dictionary, encoded. Kept separate from the whole file because the infohash is the
 * SHA-1 of exactly these bytes, so the thing that gets hashed and the thing that gets embedded have
 * to be one value rather than two encodings that ought to agree.
 */
export const encodeInfo = (
  { plan: p, pieces, fileHashes, private: isPrivate, source }:
  Pick<MetainfoRequest, 'plan' | 'pieces' | 'fileHashes' | 'private' | 'source'>,
): Uint8Array => {
  const shared: Record<string, Bencodable | undefined> = {
    name: p.name,
    'piece length': p.pieceLength,
    // 1 rather than true, because bencode has no boolean. Absent rather than 0 when public: a
    // `private: 0` key is legal and changes the info dict, so two clients making "the same" public
    // torrent would disagree on its infohash over a field that means nothing.
    private: isPrivate ? 1 : undefined,
    source: source?.trim() || undefined,
  }

  if (hasV1(p.format)) {
    if (!pieces || pieces.length !== p.pieceCount * PIECE_HASH_BYTES) {
      throw new Error(`expected ${p.pieceCount} piece hashes, got ${(pieces?.length ?? 0) / PIECE_HASH_BYTES}`)
    }
    shared['pieces'] = pieces
    if (p.single) shared['length'] = p.files[0]!.size
    // the pads belong HERE and only here: they describe the v1 byte stream, and the v2 file tree
    // rejects one outright
    else shared['files'] = p.files.map((file) => (file.pad
      ? { attr: 'p', length: file.size, path: file.path }
      : { length: file.size, path: file.path }))
  }

  if (hasV2(p.format)) {
    const content = contentFiles(p)
    if (!fileHashes || fileHashes.length !== content.length) {
      throw new Error(`expected ${content.length} merkle trees, got ${fileHashes?.length ?? 0}`)
    }
    shared['meta version'] = 2
    shared['file tree'] = fileTree(p, fileHashes)
  }

  return bencode(shared)
}

/**
 * The whole `.torrent`.
 *
 * `announce` carries the first tracker as well as `announce-list` holding all of them, which looks
 * redundant and is not: `announce` is the only one BEP 3 defines, and `announce-list` is an
 * extension, so a client that reads only the first still works.
 *
 * ONE TIER PER TRACKER, matching what other clients emit. Worth knowing what that means rather than
 * copying it blindly: under BEP 12 a tier is tried in order and the next tier is only reached if the
 * one before it fails, so extra trackers are redundancy and not extra reach. Putting them all in one
 * tier does not change that either, since a client stops at the first that answers.
 */
export const encodeTorrent = (request: MetainfoRequest): Uint8Array => encodeTorrentWithInfo(request, encodeInfo(request))

/**
 * The whole file, given an info dict that has ALREADY been encoded.
 *
 * The caller passes the very bytes it hashed, so the infohash it publishes and the info dict it ships
 * cannot be two encodings of nearly the same object. That is not hypothetical tidiness: this file
 * previously encoded the info dict twice, once for the hash and once inside the torrent, and a field
 * added to only one of the two calls produces a torrent whose advertised infohash matches nothing in
 * it. `source` is exactly such a field, and it is the one whose whole purpose is to change the hash.
 */
export const encodeTorrentWithInfo = (request: MetainfoRequest, info: Uint8Array): Uint8Array => {
  const { plan: p, fileHashes = [], trackers = [], webSeeds = [], createdAt, createdBy, comment } = request
  const clean = [...new Set(trackers.map((url) => url.trim()).filter(Boolean))]
  const seeds = [...new Set(webSeeds.map((url) => url.trim()).filter(Boolean))]
  return bencode({
    announce: clean[0],
    'announce-list': clean.length ? clean.map((url) => [url]) : undefined,
    comment: comment?.trim() || undefined,
    'created by': createdBy?.trim() || undefined,
    'creation date': createdAt,
    // raw, so these are the same bytes `infoHashOf` is given; see `Raw`
    info: raw(info),
    /*
     * OUTSIDE the info dict, which is the point of it.
     *
     * The tree roots are inside and so are covered by the infohash; the layers below them are
     * verifiable against those roots, so they need no protection of their own and would otherwise
     * make the infohash depend on how much of the tree happened to be shipped.
     */
    'piece layers': hasV2(p.format) ? pieceLayers(fileHashes) : undefined,
    // BEP 19. A list even for one, which every client accepts, unlike the bare-string form.
    'url-list': seeds.length ? seeds : undefined,
  })
}

const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** The v1 infohash: SHA-1 over the encoded `info` value. 40 hex characters. */
export const infoHashOf = async (info: Uint8Array): Promise<string> =>
  hexOf(new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array(info).buffer as ArrayBuffer)))

/**
 * The v2 infohash: SHA-256 over the SAME bytes. 64 hex characters.
 *
 * A hybrid torrent has both, and they are two names for one thing rather than two torrents. Ripple
 * uses the v1 one as its own identity wherever a torrent has one, because every path in the app
 * already keys on that string and because it is the name the v1 swarm answers to. The v2 hash is
 * still published in the magnet, so a v2-only client can find the same swarm.
 */
export const infoHashV2Of = async (info: Uint8Array): Promise<string> =>
  hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(info).buffer as ArrayBuffer)))

/**
 * A magnet for a torrent this device already holds in full.
 *
 * No `tr` beyond what the torrent itself carries and no web seed, because the point of this link is
 * to reach the metadata that is already in the library rather than to describe the swarm.
 */
export const magnetFor = (
  { infoHash, infoHashV2, name, trackers = [] }:
  { infoHash?: string, infoHashV2?: string, name: string, trackers?: string[] },
): string => {
  /*
   * `btih` FIRST for a hybrid, and that order is load bearing rather than cosmetic.
   *
   * A reader that takes the first `xt` it recognises gets the v1 hash, which is the one every client
   * understands and the one Ripple keys everything on. Ripple's own `magnetInfoHash` is such a
   * reader. Putting the v2 hash first would silently change a hybrid torrent's identity depending on
   * which end of the link somebody read.
   */
  const parts: string[] = []
  if (infoHash) parts.push(`xt=urn:btih:${infoHash}`)
  // `1220` is the multihash prefix: sha2-256, 32 bytes long. Part of the urn, never part of the id.
  if (infoHashV2) parts.push(`xt=urn:btmh:1220${infoHashV2}`)
  parts.push(`dn=${encodeURIComponent(name)}`)
  for (const url of trackers) parts.push(`tr=${encodeURIComponent(url)}`)
  return `magnet:?${parts.join('&')}`
}
