import { padLengthFor } from './make-torrent'
import { magnetInfoHash, magnetParam } from './magnet'

/**
 * Everything a share link needs, read out of a `.torrent` or a magnet WITHOUT the engine.
 *
 * The share dialog used to hand whatever it was given to the library's add path and then wait for
 * the torrent to come back. That produced a link, and it also silently added the torrent to
 * somebody's library, which is not what "make me a link" asks for. Nobody wants a download started
 * because they wanted a url.
 *
 * It was never necessary either. A `.torrent` already contains the infohash, the name, the file
 * list and the trackers, which is the whole of what a link is built from. A magnet contains the
 * infohash and usually a name. So both are read here, in the page, and the engine is left alone.
 *
 * The one thing a magnet cannot give is the file list, because that lives in metadata the swarm has
 * to deliver. `files: null` says so, and the dialog offers a whole-torrent link, which is correct
 * and complete on its own.
 */

export type ShareSubject = {
  magnet: string
  name: string
  /** total bytes, or 0 when only a magnet is known */
  size: number
  /**
   * null when the file list is not knowable without the swarm.
   *
   * `index` is the ENGINE's file index, not the position here: pads are dropped from this list and a
   * position after one names a different file. A share link's `files=` is read as engine indices by
   * the download page, so emitting positions handed somebody a link to the wrong files.
   */
  files: { name: string, size: number, index: number }[] | null
  /**
   * How many files the ENGINE sees, pads included, which is what an index is bounded by.
   *
   * Needed as well as `files.length` because `compileFileSelection` DISCARDS any index at or above
   * the count it is given. Handing it the content count would silently drop every engine index that
   * sits past it, narrowing the selection instead of failing.
   */
  fileCount: number
}

const DICT = 0x64
const LIST = 0x6c
const INT = 0x69
const END = 0x65
const COLON = 0x3a
const ZERO = 0x30
const NINE = 0x39

export type Bencode = number | Uint8Array | Bencode[] | Map<string, Bencode>

/** Decodes one value at `i`, returning it with the offset just past it. Throws on malformed input. */
export const decode = (b: Uint8Array, i: number): [Bencode, number] => {
  if (i >= b.length) throw new Error('truncated')
  const kind = b[i]

  if (kind === INT) {
    const end = b.indexOf(END, i + 1)
    if (end < 0) throw new Error('unterminated integer')
    return [Number(new TextDecoder().decode(b.subarray(i + 1, end))), end + 1]
  }

  if (kind === LIST) {
    const out: Bencode[] = []
    let at = i + 1
    while (at < b.length && b[at] !== END) {
      const [value, next] = decode(b, at)
      out.push(value)
      at = next
    }
    if (at >= b.length) throw new Error('unterminated list')
    return [out, at + 1]
  }

  if (kind === DICT) {
    const out = new Map<string, Bencode>()
    let at = i + 1
    while (at < b.length && b[at] !== END) {
      const [key, afterKey] = decode(b, at)
      if (!(key instanceof Uint8Array)) throw new Error('dict key is not a string')
      const [value, next] = decode(b, afterKey)
      out.set(new TextDecoder().decode(key), value)
      at = next
    }
    if (at >= b.length) throw new Error('unterminated dict')
    return [out, at + 1]
  }

  let at = i
  let length = 0
  let digits = 0
  while (at < b.length && b[at]! >= ZERO && b[at]! <= NINE) {
    length = length * 10 + (b[at]! - ZERO)
    at += 1
    digits += 1
    if (digits > 12) throw new Error('absurd string length')
  }
  if (digits === 0 || b[at] !== COLON) throw new Error('not a bencode value')
  const start = at + 1
  const end = start + length
  if (end > b.length) throw new Error('string runs past the end')
  return [b.subarray(start, end), end]
}

const text = (value: Bencode | undefined): string | undefined =>
  value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * The v2 `file tree`, flattened back into the same list the v1 `files` key gives.
 *
 * A file's own entry sits under the EMPTY STRING key, so a node holding one is a file and anything
 * else is a directory. Pads never appear here: a pad inside a file tree is a hard parse failure in
 * libtorrent, so a tree that has one is not a torrent worth describing.
 */
/**
 * A v2-only file tree, numbered the way LIBTORRENT will number it, not the way it is written.
 *
 * The tree itself carries no pads, which is why numbering it by position looks right and is not. A
 * v2-only torrent has no `files` list, so libtorrent SYNTHESIZES one from the tree on parse and that
 * path pads unconditionally, including for a single file. Reads are then served by index into that
 * synthesized list, so the engine index of the nth content file is n plus however many pads precede
 * it. `make-torrent.ts` carries the measurement and the two rules; this is the reader's half of the
 * same fact, and it uses the same `padLengthFor` so the two cannot drift.
 *
 * A tree with no piece length to reason from is left numbered by position, which is what it was
 * before and is right for the aligned case.
 */
const fromFileTree = (
  tree: Bencode,
  name: string,
  pieceLength: number,
): { files: { name: string, size: number, index: number }[], fileCount: number } => {
  const out: { name: string, size: number, index: number }[] = []
  /*
   * The torrent's NAME is not always part of the path, and this is the one shape where it is not.
   *
   * libtorrent's `extract_files2` decides it in one line, quoted in full where `dropsFolderName`
   * explains the consequence to somebody about to create one:
   *
   *     bool const single_file = leaf_node && !has_files && tree.dict_size() == 1;
   *     std::string path = single_file ? std::string() : root_dir;
   *
   * `root_dir` is the name. `has_files` is whether a v1 `files` list is present, and it is false by
   * construction here: this function is reached only for a torrent that has neither `files` nor
   * `length`. So a top level holding exactly ONE leaf discards the name and the file lands on its
   * own, while the same content with a second file, or nested one folder deeper, keeps it.
   *
   * This used to prefix the name unconditionally, which is right for every shape but that one. It
   * read as cosmetic for as long as the only consumer was a dialog listing names, and stopped being
   * cosmetic when `copy-source.ts` began WRITING to these paths: bytes at `Movie/Movie` are bytes
   * the engine's check does not find, so a torrent verifies at zero and downloads what its own
   * author just made. Measured exactly that way before it was fixed.
   */
  const entries = tree instanceof Map ? [...tree.values()] : []
  const only = entries.length === 1 ? entries[0] : null
  const singleFile = only instanceof Map && only.get('') instanceof Map
  const root = singleFile ? [] : [name]
  // the engine's own cursor: content files and the pads libtorrent inserts between them
  let index = 0
  let offset = 0
  const walk = (node: Bencode, prefix: string[]) => {
    if (!(node instanceof Map)) return
    const own = node.get('')
    if (own instanceof Map) {
      const length = own.get('length')
      if (typeof length !== 'number') return
      out.push({ name: [...root, ...prefix].join('/'), size: length, index })
      index++
      if (pieceLength > 0) {
        offset += length
        const pad = length > 0 ? padLengthFor(offset, pieceLength) : 0
        if (pad > 0) { index++; offset += pad }
      }
      return
    }
    for (const [key, child] of node) walk(child, [...prefix, key])
  }
  walk(tree, [])
  return { files: out, fileCount: index }
}

/**
 * A BEP 47 pad file: zeroes a v2-aware torrent inserts to push the next file onto a piece boundary.
 *
 * Skipped everywhere a person sees a file list or a total, because they are not anybody's data.
 * `attr` is a string of flag letters rather than a single value, so this tests for the letter.
 */
export const isPad = (entry: Map<string, Bencode>): boolean => (text(entry.get('attr')) ?? '').includes('p')

/**
 * The infohash is the SHA-1 of the bencoded `info` value EXACTLY as it appears in the file, so its
 * byte range is found rather than the value re-encoded. Bencode is canonical and any normalisation
 * on the way through changes the number, which would then match nothing the engine ever computed.
 */
export const infoRange = (b: Uint8Array): [number, number] | null => {
  if (b[0] !== DICT) return null
  let at = 1
  while (at < b.length && b[at] !== END) {
    const [key, afterKey] = decode(b, at)
    const [, afterValue] = decode(b, afterKey)
    if (key instanceof Uint8Array && new TextDecoder().decode(key) === 'info') return [afterKey, afterValue]
    at = afterValue
  }
  return null
}

const trackers = (root: Map<string, Bencode>): string[] => {
  const out: string[] = []
  const single = text(root.get('announce'))
  if (single) out.push(single)
  const list = root.get('announce-list')
  if (Array.isArray(list)) {
    for (const tier of list) {
      if (!Array.isArray(tier)) continue
      for (const url of tier) { const u = text(url); if (u) out.push(u) }
    }
  }
  return [...new Set(out)]
}

/** Null for anything that is not a torrent; the caller shows its own message. */
export const readTorrentFile = async (bytes: Uint8Array): Promise<ShareSubject | null> => {
  try {
    const found = infoRange(bytes)
    if (!found) return null
    const [start, end] = found
    // sliced into its own buffer: subtle.digest wants a BufferSource, and a view over a
    // SharedArrayBuffer is not one, which is reachable here because ripple is cross-origin isolated
    const range = new Uint8Array(bytes.slice(start, end))
    const infoHash = hex(await crypto.subtle.digest('SHA-1', range.buffer))

    const [root] = decode(bytes, 0)
    if (!(root instanceof Map)) return null
    const info = root.get('info')
    if (!(info instanceof Map)) return null

    /*
     * v1, v2 or both, decided by what the info dict actually carries rather than by `meta version`.
     *
     * A hybrid has all of it and is one torrent with two names, so both go in the link and the v1
     * one goes FIRST: every client understands it, and a reader taking the first `xt` it recognises
     * then agrees with Ripple about which torrent this is.
     */
    const hasV1 = info.has('pieces')
    const hasV2 = info.get('meta version') === 2 && info.has('file tree')
    const infoHashV2 = hasV2 ? hex(await crypto.subtle.digest('SHA-256', range.buffer)) : null

    const name = text(info.get('name')) ?? (hasV1 ? infoHash : infoHashV2 ?? infoHash)
    const fileList = info.get('files')
    // only the v2 tree needs it, to place the pads libtorrent will synthesize
    const pieceLength = typeof info.get('piece length') === 'number' ? info.get('piece length') as number : 0

    let files: { name: string, size: number, index: number }[]
    // the engine's own count, which the dropped pads are still part of
    let fileCount = 0
    if (Array.isArray(fileList)) {
      fileCount = fileList.length
      // a multi-file torrent: each entry carries its path as a list of components under the name
      // `index` is the position in THIS list, pads included, because that is what the engine numbers
      files = fileList.flatMap((entry, index) => {
        if (!(entry instanceof Map)) return []
        // a pad is not one of the person's files: counting one inflates the size and shows a
        // `.pad/64536` row nobody put there
        if (isPad(entry)) return []
        const path = entry.get('path')
        const length = entry.get('length')
        if (!Array.isArray(path) || typeof length !== 'number') return []
        const parts = path.map((p) => text(p)).filter((p): p is string => !!p)
        return [{ name: [name, ...parts].join('/'), size: length, index }]
      })
    } else if (typeof info.get('length') === 'number') {
      files = [{ name, size: info.get('length') as number, index: 0 }]
      fileCount = 1
    } else if (hasV2) {
      // a v2-only torrent has neither key, and its whole file list lives in the tree
      const tree = fromFileTree(info.get('file tree')!, name, pieceLength)
      files = tree.files
      fileCount = tree.fileCount
    } else {
      files = []
    }

    const size = files.reduce((total, file) => total + file.size, 0)
    const params = new URLSearchParams()
    params.set('dn', name)
    for (const tracker of trackers(root)) params.append('tr', tracker)
    const urns = [
      ...(hasV1 ? [`xt=urn:btih:${infoHash}`] : []),
      // `1220` is the multihash prefix, sha2-256 of 32 bytes. Part of the urn, not part of the id.
      ...(infoHashV2 ? [`xt=urn:btmh:1220${infoHashV2}`] : []),
    ]
    const magnet = `magnet:?${(urns.length ? urns : [`xt=urn:btih:${infoHash}`]).join('&')}&${params.toString()}`

    return { magnet, name, size, files: files.length ? files : null, fileCount }
  } catch {
    return null
  }
}

/**
 * The same shape from a magnet, which is all a link needs and is complete without the swarm.
 *
 * `files: null` because the file list lives in metadata the swarm delivers. That is not a
 * degraded answer: a whole-torrent link is exactly what somebody pasting a magnet asked for.
 */
export const readMagnet = (raw: string): ShareSubject | null => {
  const trimmed = raw.trim()
  const infoHash = magnetInfoHash(trimmed)
  if (!infoHash) return null
  /*
   * Normalized rather than kept verbatim, because a display name is routinely pasted with its own
   * characters in it: `&dn=進撃の巨人` is what a lot of sites put on the clipboard. The link this
   * subject ends up in is base64, and base64 of anything above U+00FF throws. Percent-encoding the
   * query changes nothing about which torrent this names, and leaves it pure ASCII.
   */
  let magnet = trimmed
  try { magnet = new URL(trimmed).href } catch { /* not a URL, so leave it as typed */ }
  return { magnet, name: magnetParam(magnet, 'dn') ?? infoHash, size: 0, files: null, fileCount: 0 }
}
