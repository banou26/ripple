import type { PickedFile } from './walk-source'
import type { TorrentPlan } from './make-torrent'

import { encodeInfo, encodeTorrentWithInfo, infoHashOf, isValidPieceLength, magnetFor, plan } from './make-torrent'
import { readTorrentFile } from './torrent-file'

/**
 * Turning a pick into a published torrent: the decisions, with the IO passed in.
 *
 * The picking, the walking and the hashing each live in their own module. This is the sequence that
 * joins them, plus the two things that are genuinely decisions rather than mechanics: what the
 * torrent announces to, and what it says about the person who made it.
 */

/**
 * What a created torrent announces to unless the person changes it.
 *
 * The same three trackers Ripple's own demo magnet already uses, so this introduces no new party to
 * the app. They are here rather than left empty because a torrent with no tracker is discoverable
 * only through the DHT, from one browser tab on a relayed port, and the first thing anybody would do
 * with a share link that finds no peers is conclude the feature is broken.
 *
 * The dialog shows them, in a field, and clearing it is one gesture. Announcing tells a tracker this
 * infohash exists at this address, which is a real thing to be told and so it is said plainly on
 * screen rather than buried here.
 */
export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
]

/**
 * What goes in the metainfo beyond the files themselves.
 *
 * `created by` and `creation date` are left out, and not for the reason it first looks like: they are
 * TOP-LEVEL keys, siblings of `info`, so they sit outside the bytes the infohash is computed over and
 * cannot split a swarm. They are omitted because a `.torrent` gets passed around and each is a string
 * about the person and the moment rather than about the files. A date says when somebody's folder was
 * on their disk, and it helps nobody download.
 *
 * `comment` is offered, unlike those two, because it is the one of the three that somebody writes ON
 * PURPOSE and about the content. Empty by default and omitted entirely when empty, so a torrent says
 * nothing unless its maker chose to.
 */
export type CreateOptions = {
  /** Editable, defaults to the picked folder or file name. */
  name: string
  trackers: string[]
  /** Http sources the whole torrent can also be fetched from. BEP 19 `url-list`. */
  webSeeds?: string[]
  /** Free text carried in the file. Left out entirely when empty. */
  comment?: string
  /**
   * A private tracker's tag. INSIDE the info dict, so it changes the infohash: the same files with a
   * different source are a different torrent, which is the point of it and also the trap.
   */
  source?: string
  /** Overrides the automatic choice. A power of two from 16 KiB to 16 MiB. */
  pieceLength?: number
  /**
   * Keeps the torrent to its trackers: no DHT, no peer exchange, no local discovery.
   *
   * Refused without a tracker, which is not a style rule. Private turns off the only other way to
   * find peers, so private plus no trackers is a torrent that is by construction unreachable, and it
   * would look exactly like one that is merely unlucky.
   */
  private: boolean
}

export const optionsError = (
  { name, trackers, webSeeds = [], private: isPrivate, pieceLength }: CreateOptions,
): string | null => {
  const clean = trackers.map((url) => url.trim()).filter(Boolean)
  if (!name.trim()) return 'Give the torrent a name'
  if (name.includes('/')) return 'A torrent name cannot contain a slash'
  if (isPrivate && !clean.length) return 'A private torrent needs at least one tracker, or nobody can find it'
  for (const url of clean) {
    // A bare hostname is the mistake people make here, and libtorrent drops such a tracker without
    // saying so, which reads as a tracker that never answers.
    if (!/^(https?|udp|ws|wss):\/\/[^\s/]+/.test(url)) return `${url} is not a tracker address`
  }
  // A web seed is fetched over http by a client, so unlike a tracker it is those two schemes only
  for (const url of webSeeds.map((u) => u.trim()).filter(Boolean)) {
    if (!/^https?:\/\/[^\s/]+/.test(url)) return `${url} is not a web seed address: it has to be http or https`
  }
  if (pieceLength !== undefined && !isValidPieceLength(pieceLength)) {
    return 'That piece size is not one a torrent can use'
  }
  return null
}

/**
 * A web seed for a MULTI-FILE torrent needs a trailing slash, and one for a single file must not
 * have one.
 *
 * BEP 19 makes the url mean different things in the two shapes: for a multi-file torrent it names a
 * directory that the torrent's own name and paths are appended to, and for a single file it names
 * the file itself. Getting it wrong does not fail loudly; the client builds a url nobody serves and
 * the web seed silently contributes nothing, which is indistinguishable from a seed that is merely
 * down.
 */
export const normalizeWebSeeds = (urls: string[], single: boolean): string[] =>
  urls
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => (single ? url.replace(/\/+$/, '') : url.endsWith('/') ? url : url + '/'))

export type Built = {
  infoHash: string
  magnet: string
  /** The whole `.torrent`, kept so it can be offered as a download and stored for later loads. */
  bytes: Uint8Array
  plan: TorrentPlan
  /** In the torrent's own file order, which is the order reads are indexed by. */
  handles: FileSystemFileHandle[]
  /** For the library entry, in the shape the rest of the app already uses. */
  files: { name: string, size: number }[]
}

/**
 * Assemble and CHECK the torrent, given pieces that have already been hashed.
 *
 * The check is the last step and it is not a formality: the finished bytes go back through
 * `readTorrentFile`, the decoder the share dialog uses on strangers' files, and the infohash it
 * computes from those bytes by finding the `info` range has to match the one computed here from the
 * encoder's output. Two independent computations over one artifact, so an encoding mistake shows up
 * before anything is published rather than as a torrent that connects to nothing.
 */
export const buildTorrent = async (
  { picked, pieces, options, single }:
  { picked: PickedFile[], pieces: Uint8Array, options: CreateOptions, single: boolean },
): Promise<Built> => {
  const built = plan({
    name: options.name,
    files: picked.map(({ path, size }) => ({ path, size })),
    single,
    pieceLength: options.pieceLength,
  })
  const trackers = options.trackers.map((url) => url.trim()).filter(Boolean)
  const request = {
    plan: built,
    pieces,
    trackers,
    webSeeds: normalizeWebSeeds(options.webSeeds ?? [], single),
    private: options.private,
    source: options.source,
    comment: options.comment,
  }
  /*
   * ONE info encoding, hashed and embedded.
   *
   * `source` lives inside the info dict, so a second encoding that did not receive it would produce
   * a torrent whose advertised infohash matches nothing in the file. That is not a hypothetical: the
   * two calls that used to be here were exactly the shape that makes it happen.
   */
  const info = encodeInfo(request)
  const infoHash = await infoHashOf(info)
  const bytes = encodeTorrentWithInfo(request, info)

  const read = await readTorrentFile(bytes)
  if (!read) throw new Error('the torrent that was just built could not be read back')
  if (!read.magnet.includes(`xt=urn:btih:${infoHash}`)) {
    throw new Error(`the built torrent reads back as a different torrent: ${read.magnet.slice(0, 60)} against ${infoHash}`)
  }
  if (read.name !== built.name) throw new Error(`the built torrent reads back named ${read.name}`)
  if (read.size !== built.totalBytes) {
    throw new Error(`the built torrent reads back as ${read.size} bytes rather than ${built.totalBytes}`)
  }

  /*
   * Handles reordered to match the torrent, NOT the walk.
   *
   * `plan()` sorts, because the file order fixes every file's offset and so belongs with the
   * metainfo rules. The handles were collected in whatever order the platform iterated. Reads are
   * served by `fileIndex`, which is the position in the TORRENT, so a handle list left in walk order
   * would serve one file's bytes for another's: every piece would fail, and only for a folder whose
   * iteration order happened to differ from its sort order.
   */
  const byPath = new Map(picked.map((file) => [file.path.join('/'), file]))
  const handles = built.files.map((file) => {
    const match = byPath.get(file.path.join('/'))
    if (!match) throw new Error(`no handle for ${file.path.join('/')}`)
    return match.handle
  })

  return {
    infoHash,
    magnet: magnetFor({ infoHash, name: built.name, trackers }),
    bytes,
    plan: built,
    handles,
    files: built.files.map((file) => ({ name: [built.name, ...file.path].join('/'), size: file.size })),
  }
}
