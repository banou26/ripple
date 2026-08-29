// The file list a share link can carry, so a recipient sees what they were sent before the swarm
// answers.
//
// A magnet names a torrent and nothing else, which torrent-file.ts says plainly: the file list lives
// in metadata only the swarm can deliver. So today a download link opens on "Reading the torrent
// from the network", a disabled button and no list, for as long as metadata takes. This closes that
// gap by putting the list in the URL, where the sender already had it.
//
// It is a PREVIEW and nothing more. It is written by whoever built the link, so it can disagree with
// the torrent, and the download itself is still resolved against real metadata once that lands. See
// the note on trust in download.tsx, which is where that distinction has to hold.
//
// Why not the whole `.torrent`, which is the obvious version of this idea: piece hashes are 94% of a
// torrent and are 20 bytes of SHA1 per piece, so deflate makes them BIGGER (measured: 21,005 bytes
// out of 21,000). A 12-episode season is a 28,512-character URL and a 40 GB remux is 68,676. The
// file list is the part that is both small and useful: the same season is 416 characters.
//
// No preset dictionary here, deliberately, unlike magnet-codec. The gain on release names would be
// small and a preset dictionary can never be edited afterwards without silently changing what old
// links decode to. A preview is not worth that permanent obligation, so this carries a plain version
// byte instead, and a version it does not know is simply refused.

import { deflateSync, inflateSync } from 'fflate'

export type PreviewFile = { path: string, size: number }

const VERSION = 1

/**
 * How much URL the preview is allowed to spend before it is dropped instead.
 *
 * The link has to keep working as a link. Discord refuses a message over 2,000 characters outright,
 * and that is the tightest real ceiling anything here has to clear, so the preview gets a slice of
 * it and gives up rather than pushing a link past it. A 48-file season costs 416 and a 100-file pack
 * 478, so this only bites on the pathological ones, which are exactly the cases where a preview
 * matters least.
 */
const MAX_VALUE = 1200

/** Bounds on the way back in, because the value is embedder-written. See MAX_INFLATED below. */
const MAX_FILES = 4096
/*
 * Deflate turns 990 bytes into a megabyte given the chance, which is the trap magnet-codec had to be
 * fixed for after the fact. Applied here from the start: the parameter is attacker-influencable and
 * inflating it happens during a render.
 */
const MAX_INFLATED = 256 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/*
 * Sizes routinely exceed 2^31 (a 40 GB file is 4.3e10) and every bitwise operator in JavaScript
 * truncates to 32 bits, so these use arithmetic rather than shifts. `1 << 35` is 8, not 34359738368,
 * and it fails silently, which is the kind of bug that only shows up on somebody's remux.
 */
const writeVarint = (n: number, out: number[]) => {
  let value = Math.floor(n)
  while (value >= 0x80) { out.push((value % 0x80) + 0x80); value = Math.floor(value / 0x80) }
  out.push(value)
}

const readVarint = (bytes: Uint8Array, at: number): [number, number] | null => {
  let value = 0, scale = 1, offset = at
  for (;;) {
    if (offset >= bytes.length || offset - at > 9) return null
    const byte = bytes[offset++]!
    value += (byte & 0x7f) * scale
    if (!(byte & 0x80)) return [value, offset]
    scale *= 0x80
  }
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  // chunked, because spreading a large array into String.fromCharCode overflows the argument limit
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (text: string): Uint8Array => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * The `f=` value for a file list, or null when there should not be one.
 *
 * Null covers three different "no": nothing to describe, a path this layout cannot represent, and a
 * list too long to be worth the URL. All three mean the same thing to a caller, which is to leave
 * the parameter off and let the page do what it does today.
 *
 * Paths are grouped together ahead of the sizes rather than interleaved with them, which is not
 * cosmetic: releases share long prefixes, and putting a number between every pair of paths breaks up
 * the runs the compressor matches on. Measured on a 48-file season, grouping is 416 characters
 * against 539, and on a 100-file pack 478 against 851.
 */
export const encodeFileList = (files: readonly PreviewFile[]): string | null => {
  if (!files.length || files.length > MAX_FILES) return null
  // '\n' separates the paths, so a path containing one could not be read back. Refuse rather than
  // emit a preview that would split into the wrong names.
  if (files.some((file) => file.path.includes('\n'))) return null
  if (files.some((file) => !Number.isFinite(file.size) || file.size < 0)) return null

  const pathBlock = encoder.encode(files.map((file) => file.path).join('\n'))
  const head: number[] = []
  writeVarint(files.length, head)
  writeVarint(pathBlock.length, head)
  const sizes: number[] = []
  for (const file of files) writeVarint(file.size, sizes)

  const payload = new Uint8Array(head.length + pathBlock.length + sizes.length)
  payload.set(head, 0)
  payload.set(pathBlock, head.length)
  payload.set(sizes, head.length + pathBlock.length)

  const body = deflateSync(payload, { level: 9 })
  const out = new Uint8Array(1 + body.length)
  out[0] = VERSION
  out.set(body, 1)

  const value = toBase64Url(out)
  return value.length > MAX_VALUE ? null : value
}

/**
 * The file list a `f=` value describes, or null for anything unreadable.
 *
 * Null rather than a throw, and null rather than a partial list: this runs during a render on text
 * somebody else wrote, and half a file list shown as if it were whole is worse than none, because
 * the page would name the wrong files with no sign that anything was missing.
 */
export const decodeFileList = (value: string): PreviewFile[] | null => {
  try {
    const bytes = fromBase64Url(value)
    if (bytes[0] !== VERSION) return null

    // fflate fills `out` and hands it back rather than throwing, so one byte of headroom is the only
    // way to tell "exactly this long" from "still going". Same shape as magnet-codec's cap.
    const inflated = inflateSync(bytes.subarray(1), { out: new Uint8Array(MAX_INFLATED + 1) })
    if (inflated.length > MAX_INFLATED) return null

    const countRead = readVarint(inflated, 0)
    if (!countRead) return null
    const [count, afterCount] = countRead
    if (count === 0 || count > MAX_FILES) return null

    const lengthRead = readVarint(inflated, afterCount)
    if (!lengthRead) return null
    const [pathBytes, afterLength] = lengthRead
    if (afterLength + pathBytes > inflated.length) return null

    const paths = decoder.decode(inflated.subarray(afterLength, afterLength + pathBytes)).split('\n')
    // a count that disagrees with what the block actually holds means this is not what it claims
    if (paths.length !== count) return null

    const files: PreviewFile[] = []
    let offset = afterLength + pathBytes
    for (let i = 0; i < count; i++) {
      const read = readVarint(inflated, offset)
      if (!read) return null
      files.push({ path: paths[i]!, size: read[0] })
      offset = read[1]
    }
    // trailing bytes mean the value is not the shape it says it is, so it is not trusted
    if (offset !== inflated.length) return null
    return files
  } catch {
    return null
  }
}
