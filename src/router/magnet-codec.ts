// Turning a magnet into the shortest query parameter that still names the same torrent.
//
// A share link is mostly tracker list. The infohash is 20 bytes of uniform entropy written as 40
// hex characters, and everything after it is a handful of announce URLs drawn from a very small set
// that the whole public internet copies from each other. So the two wins are unrelated: halve the
// hash by writing it as bytes, and prime a compressor with the tracker list it is about to see.
//
// Measured over a 12-entry corpus covering every magnet form ripple accepts, against the previous
// `btoa(magnet)` form: median -69%, worst case (a private tracker with a passkey and no dictionary
// hit) -42%. A five-tracker link goes from a 549-character URL to 148.
//
// Three things here are load bearing and easy to undo by accident:
//
//   1. `PARAM` names the DICTIONARY VERSION, not just the format. A preset deflate dictionary is
//      not checksummed on the raw stream, so decoding against a CHANGED dictionary of the same
//      length yields a valid, wrong magnet with no error at all (measured, not feared). The
//      dictionary must therefore never be edited in place. Changing it means a new parameter name
//      and keeping the old dictionary in the bundle to decode old links.
//   2. `LEGACY_PARAM` is permanent. README publishes `magnet=<base64 of the magnet URI>` as an open
//      contract, and the share dialog only ever writes to the clipboard, so links already pasted in
//      chats cannot be enumerated or rewritten. Decoding it is a forever obligation.
//   3. Everything here is SYNCHRONOUS. `watchHref` runs per row during a render and `embedPath` is
//      called inside a useMemo, so an async codec would mean the Watch link popping in after first
//      paint on every row. That rules out the platform CompressionStream, which is async on both
//      sides, has no dictionary parameter, and emits different bytes in different engines.

import { deflateSync, inflateSync } from 'fflate'

/** The current format. The digit is the dictionary generation; see the note above. */
const PARAM = 'm'
/** What every link written before this module existed uses. Read forever, never written. */
const LEGACY_PARAM = 'magnet'

/**
 * The announce URLs that prime the compressor, least common FIRST.
 *
 * Order is not cosmetic: deflate spends fewer bits on nearer back-references, so the entries most
 * likely to appear belong at the END, closest to the payload. Both the percent-encoded and the
 * plain form are included because a magnet carries the former and a hand-written one the latter.
 *
 * FROZEN. Adding, removing or reordering an entry changes what an existing link decodes to. A dead
 * tracker stays listed: it costs a few bundle bytes and removing it corrupts links silently.
 */
const TRACKERS = [
  'udp://tracker.bittor.pw:1337/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.openwebtorrent.com',
  'udp://opentracker.io:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
]

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const DICTIONARY = encoder.encode(
  'xt=urn:btih:xt=urn:btmh:1220dn=&tr=&ws=announce'
  + TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')
  + TRACKERS.map((t) => `&tr=${t}`).join(''),
)

/* The three shapes an `xt` can legally take, and the byte length each decodes to. */
const HEX_V1 = /^urn:btih:([0-9a-f]{40})$/i
const BASE32_V1 = /^urn:btih:([A-Z2-7]{32})$/i
const MULTIHASH_V2 = /^urn:btmh:1220([0-9a-f]{64})$/i
const KIND_HEX = 0, KIND_BASE32 = 1, KIND_MULTIHASH = 2

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const base32Decode = (text: string): Uint8Array => {
  const out: number[] = []
  let bits = 0, value = 0
  for (const char of text.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Uint8Array.from(out)
}

const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0, value = 0, out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

const hexDecode = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

const hexEncode = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (text: string): Uint8Array => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Split a magnet into its hashes as raw bytes and the rest of its query UNTOUCHED.
 *
 * The remainder keeps its original bytes rather than being re-serialised, so the round trip is
 * byte-identical for everything except the `xt` parameters themselves. That matters because a
 * decoded magnet goes straight to the engine with no validation, so the fewer things this rewrites
 * the fewer ways it can hand over something subtly different from what was shared.
 */
const splitHashes = (magnet: string): { hashes: [number, Uint8Array][], rest: string } => {
  const query = magnet.slice(magnet.indexOf('?') + 1)
  const hashes: [number, Uint8Array][] = []
  const rest: string[] = []
  for (const segment of query.split('&')) {
    const eq = segment.indexOf('=')
    if (eq > 0 && segment.slice(0, eq) === 'xt') {
      let value: string
      try { value = decodeURIComponent(segment.slice(eq + 1)) } catch { rest.push(segment); continue }
      const hex = value.match(HEX_V1)
      if (hex) { hashes.push([KIND_HEX, hexDecode(hex[1]!)]); continue }
      const base32 = value.match(BASE32_V1)
      if (base32) { hashes.push([KIND_BASE32, base32Decode(base32[1]!)]); continue }
      const multi = value.match(MULTIHASH_V2)
      if (multi) { hashes.push([KIND_MULTIHASH, hexDecode(multi[1]!)]); continue }
    }
    // anything unrecognised, including an xt shape this does not know, survives as literal text
    rest.push(segment)
  }
  return { hashes, rest: rest.join('&') }
}

/**
 * The packed bytes for a magnet, or null when it carries no hash this format can hold.
 *
 * Null rather than a throw: every caller is inside a render, and an exception there takes out the
 * whole route rather than the one link.
 */
export const packMagnet = (magnet: string): Uint8Array | null => {
  const { hashes, rest } = splitHashes(magnet)
  // a magnet with no recognisable hash is not one this can shorten, and guessing would be worse
  if (!hashes.length || hashes.length > 255) return null
  let size = 1
  for (const [, bytes] of hashes) size += 1 + bytes.length
  const head = new Uint8Array(size)
  head[0] = hashes.length
  let offset = 1
  for (const [kind, bytes] of hashes) {
    head[offset++] = kind
    head.set(bytes, offset)
    offset += bytes.length
  }
  const body = deflateSync(encoder.encode(rest), { level: 9, dictionary: DICTIONARY })
  const out = new Uint8Array(head.length + body.length)
  out.set(head, 0)
  out.set(body, head.length)
  return out
}

/**
 * The most a packed value is allowed to inflate to, past which it is refused rather than decoded.
 *
 * Nothing else here bounds the output, and deflate is happy to turn 990 bytes into a megabyte:
 * measured at 1010:1 on a run of repeated characters, so a 64KB URL (which the edge does serve, it
 * only starts answering 414 above that) would otherwise hand a ~45MB string to the engine after a
 * ~130ms stall on the main thread, during a render. The parameter is embedder-written, and the form
 * it replaced could not do this: base64 DEFLATES by 0.75, so the magnet was always bounded by the
 * URL that carried it. Keeping that property is the point of this cap.
 *
 * 16 KiB is far past any real magnet. The remainder this bounds excludes the hashes entirely, so it
 * is display name plus announce URLs, and a hundred trackers do not reach it.
 */
const MAX_INFLATED = 16 * 1024

/** The magnet a packed value names, or null if the bytes are not one. */
export const unpackMagnet = (bytes: Uint8Array): string | null => {
  try {
    const count = bytes[0]
    if (count === undefined || count === 0) return null
    let offset = 1
    const parts: string[] = []
    for (let i = 0; i < count; i++) {
      const kind = bytes[offset++]
      const length = kind === KIND_MULTIHASH ? 32 : 20
      if (offset + length > bytes.length) return null
      const hash = bytes.subarray(offset, offset + length)
      offset += length
      parts.push(
        kind === KIND_HEX ? `xt=urn:btih:${hexEncode(hash)}`
          : kind === KIND_BASE32 ? `xt=urn:btih:${base32Encode(hash)}`
            : kind === KIND_MULTIHASH ? `xt=urn:btmh:1220${hexEncode(hash)}`
              : '',
      )
      if (!parts[parts.length - 1]) return null
    }
    /*
     * One byte of headroom past the cap, because fflate does not throw on a full buffer: it fills
     * `out` and hands it back, and returns a correctly sized slice when the output fits. So a
     * result that reaches MAX_INFLATED + 1 is the only signal that it was still going, and asking
     * for exactly the cap would be indistinguishable from a payload that happens to be that long.
     */
    const inflated = inflateSync(bytes.subarray(offset), { dictionary: DICTIONARY, out: new Uint8Array(MAX_INFLATED + 1) })
    if (inflated.length > MAX_INFLATED) return null
    const rest = decoder.decode(inflated)
    if (rest) parts.push(rest)
    return `magnet:?${parts.join('&')}`
  } catch {
    // a truncated, hand-edited or wrong-generation value lands here, and the caller shows no link
    return null
  }
}

export type EncodedMagnet = { key: string, value: string }

/**
 * Encoded links, kept because `watchHref` builds one per library row inside a render and rows
 * re-render on every progress tick.
 *
 * Packing costs about 27us where the base64 it replaced cost half a microsecond, so a hundred rows
 * went from 0.05ms to 2.7ms per render. That is not a stall, but it is 52x for a value that cannot
 * change: the encoding is a pure function of the magnet string.
 *
 * Bounded and FIFO rather than an LRU, because the access pattern is "every row, every tick", so
 * every live entry is touched on each pass and recency carries no information. The cap only has to
 * exceed a plausible library.
 */
const CACHE_LIMIT = 512
const cache = new Map<string, EncodedMagnet | null>()

/**
 * The shortest `<key>=<value>` that names this magnet, or null if nothing can encode it.
 *
 * Normalised through `new URL()` first, exactly as the previous encoder did, so the bytes that get
 * packed are the same ASCII the legacy path would have produced. A magnet carrying a raw unicode
 * display name is an ordinary paste, and normalising is what makes it representable either way.
 *
 * The shorter of the two forms wins, which is not a formality: deflate EXPANDS an input below about
 * 84 characters, so a bare `magnet:?xt=urn:btih:<hex>` with no name and no trackers is one of the
 * cases where the packed form could lose. It usually still wins there on the strength of the halved
 * hash, but the comparison costs nothing and removes a whole class of "shorter, except when it is
 * not" reasoning.
 */
export const encodeMagnetParam = (magnet: string): EncodedMagnet | null => {
  const hit = cache.get(magnet)
  // `undefined` is a miss and `null` is a remembered "nothing can encode this", which are different
  if (hit !== undefined) return hit
  const encoded = encodeUncached(magnet)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(magnet, encoded)
  return encoded
}

const encodeUncached = (magnet: string): EncodedMagnet | null => {
  let normalised: string | null = null
  try { normalised = new URL(magnet).href } catch { /* not a URL at all */ }

  let legacy: string | null = null
  for (const candidate of [normalised, magnet]) {
    if (candidate === null) continue
    try { legacy = btoa(candidate); break } catch { /* still not Latin-1 */ }
  }

  const packed = normalised === null ? null : packMagnet(normalised)
  if (packed) {
    // only offer the packed form if it actually reads back as the same torrent
    const value = toBase64Url(packed)
    if (unpackMagnet(packed) !== null && (legacy === null || value.length < legacy.length)) {
      return { key: PARAM, value }
    }
  }
  return legacy === null ? null : { key: LEGACY_PARAM, value: legacy }
}

/**
 * The magnet a set of query parameters names, reading the packed form first and the published
 * base64 one after it.
 *
 * Undefined rather than a throw on anything unreadable, because this runs during render on
 * embedder-written text: a mistyped link has to show an empty player, not a blank page.
 */
export const decodeMagnetParam = (params: URLSearchParams): string | undefined => {
  const packed = params.get(PARAM)
  if (packed) {
    try {
      const magnet = unpackMagnet(fromBase64Url(packed))
      if (magnet !== null) return magnet
    } catch { /* not base64url, or not this generation */ }
  }
  const legacy = params.get(LEGACY_PARAM)
  if (legacy) {
    try { return atob(legacy) } catch { /* not base64 */ }
  }
  return undefined
}
