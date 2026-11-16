import { deflateSync, inflateSync } from 'fflate'

import { hexInfoHash } from '../torrent/magnet'
import { DICTIONARY, fromBase64Url, hexDecode, hexEncode, toBase64Url } from './magnet-codec'

/*
 * A group of torrents as one link, everything after the `#`, so no server ever receives it.
 *
 * FROZEN: every link ever copied reads the same forever. A change to the layout or to the dictionary takes the next
 * version byte, and the reader keeps reading every older one (raw deflate does not check its dictionary, so a changed
 * one reads old links as valid, wrong text). `tests/router/group-link.test.ts` holds links that must keep decoding.
 *
 * Version 1, byte for byte:
 *   0x01
 *   the count of torrents, varint, 1 to MAX_LINK_TORRENTS
 *   hashBytes, varint: 20 per v1 hash plus 32 per v2 hash
 *   the hashes, raw, torrent by torrent: its v1 hash then its v2 hash, where present
 *   the rest: raw DEFLATE of the body, with magnet-codec's DICTIONARY
 * The body, at most MAX_BODY bytes:
 *   count bytes, each torrent's kind: 1 its v1 hash, 2 its v2 hash, 3 both; together naming hashBytes
 *   the group's name, UTF-8, then LF; not empty once trimmed
 *   per torrent, its magnet's other parameters (trackers, web seeds...) as written, joined by &, then LF: only 0x21 to
 *   0x7E, and none that libtorrent reads as `xt` or `dn`, so the link names exactly the torrents its hashes name
 * Varints are unsigned LEB128, at most 4 bytes, canonical. No hash appears twice. Nothing follows the last LF. Bytes
 * after the end of the deflate stream are ignored. There are no torrent names and no sizes, so a receiver sees hashes
 * until each torrent's peers answer.
 */

/** Where a group link points, whichever origin made it: the origin whose `/add` is refused inside a frame. */
export const GROUP_LINK_PREFIX = 'https://torrent.fkn.app/add#'

/** The most torrents a link holds, when built and when read. It may be raised later, never lowered. */
export const MAX_LINK_TORRENTS = 1000

const VERSION = 1
const MAX_BODY = 4 * 1024 * 1024
const V1 = 1, V2 = 2

/** A torrent handed to the builder: its shareable magnet, and whether its `.torrent` says private. */
export type LinkTorrent = { magnet: string, private?: boolean }

export type BuiltGroupLink = {
  /**
   * Null whenever the link would not read back: no torrent carried, more than MAX_LINK_TORRENTS, an empty name, or a
   * body past 4 MiB.
   */
  link: string | null
  /** The torrents the link carries, each once, or would carry past the cap. */
  count: number
  /** Private torrents, which never go in a link. */
  privateLeftOut: number
}

/** A link read back: the group's name, and per torrent its info hash as the library keys it and the magnet to add. */
export type LinkedGroup = { name: string, torrents: { infoHash: string, magnet: string }[] }

const encoder = new TextEncoder()
// ignoreBOM keeps a leading BOM as a character, so a body that starts with one is refused rather than read as one without
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** A parameter's name as libtorrent compares it (`magnet_uri.cpp`): in any case, and `xt.1` or `xt.` read as `xt`. */
const paramName = (raw: string): string => {
  const dot = raw.indexOf('.')
  return (dot >= 0 && /^\d*$/.test(raw.slice(dot + 1)) ? raw.slice(0, dot) : raw).toLowerCase()
}

const namesTorrent = (part: string): boolean => {
  const eq = part.indexOf('=')
  const name = paramName(eq < 0 ? part : part.slice(0, eq))
  return name === 'xt' || name === 'dn'
}

type Carried = { v1?: string, v2?: string, line: string }

/** A magnet as a link carries it, or null when it names no torrent this format holds, or two of one kind. */
const carried = (magnet: string): Carried | null => {
  let href: string
  try { href = new URL(magnet).href } catch { return null }
  if (!href.startsWith('magnet:?')) return null
  let v1: string | undefined, v2: string | undefined
  const line: string[] = []
  // libtorrent's name runs to the next `=`, so a part with none hides itself and the part after it, as in magnet.ts
  let swallowed = false
  for (const part of href.slice(8).split('&')) {
    const eq = part.indexOf('=')
    if (swallowed || eq < 0) { swallowed = eq < 0; continue }
    const name = paramName(part.slice(0, eq))
    if (name === 'dn') continue
    if (name !== 'xt') { line.push(part); continue }
    let value = part.slice(eq + 1)
    if (value.includes('%')) {
      try { value = decodeURIComponent(value) } catch { return null }
    }
    const one = value.match(/^urn:btih:([0-9a-fA-F]{40}|[a-zA-Z2-7]{32})$/)?.[1]
    const two = value.match(/^urn:btmh:1220([0-9a-fA-F]{64})$/)?.[1]?.toLowerCase()
    if (one) {
      if (v1 && v1 !== hexInfoHash(one)) return null
      v1 = hexInfoHash(one)
    } else if (two) {
      if (v2 && v2 !== two) return null
      v2 = two
    } else if (/^urn:bt[im]h:/.test(value)) {
      // libtorrent refuses the whole magnet; any other kind (urn:sha1...) it ignores
      return null
    }
  }
  return v1 || v2 ? { v1, v2, line: line.join('&') } : null
}

const varint = (out: number[], n: number) => {
  for (; n > 0x7f; n >>>= 7) out.push((n & 0x7f) | 0x80)
  out.push(n)
}

const readVarint = (bytes: Uint8Array, at: { i: number }): number => {
  let n = 0
  for (let shift = 0; shift < 28; shift += 7) {
    const byte = bytes[at.i++]
    if (byte === undefined || (shift && !byte)) throw new Error('not a canonical varint')
    n |= (byte & 0x7f) << shift
    if (byte < 0x80) return n
  }
  throw new Error('a varint past 4 bytes')
}

/**
 * The link for a group, built from each torrent's shareable magnet. Private torrents are left out and counted, a
 * torrent named twice goes in once, and one whose magnet cannot be carried (no hash this format holds, or two of one
 * kind) is left out. Torrents are written sorted by their parameters, so the same group gives the same link.
 */
export const buildGroupLink = (name: string, torrents: LinkTorrent[]): BuiltGroupLink => {
  let privateLeftOut = 0
  const seen = new Set<string>()
  const kept: Carried[] = []
  for (const torrent of torrents) {
    if (torrent.private) { privateLeftOut++; continue }
    const one = carried(torrent.magnet)
    if (!one || (one.v1 && seen.has(one.v1)) || (one.v2 && seen.has(one.v2))) continue
    for (const hash of [one.v1, one.v2]) if (hash) seen.add(hash)
    kept.push(one)
  }
  const count = kept.length
  if (!count || count > MAX_LINK_TORRENTS) return { link: null, count, privateLeftOut }

  const key = (t: Carried) => t.line + '\n' + (t.v1 ?? t.v2)
  kept.sort((a, b) => (key(a) < key(b) ? -1 : 1))
  const hashes = kept.flatMap((t) => [t.v1, t.v2].filter((h) => h !== undefined)).map(hexDecode)
  const head = [VERSION]
  varint(head, count)
  varint(head, hashes.reduce((total, h) => total + h.length, 0))
  const kinds = kept.map((t) => String.fromCharCode((t.v1 ? V1 : 0) | (t.v2 ? V2 : 0))).join('')
  const body = encoder.encode(kinds + name.replace(/[\r\n]+/g, ' ') + '\n' + kept.map((t) => t.line + '\n').join(''))
  const record = new Uint8Array([...head, ...hashes.flatMap((h) => [...h]), ...deflateSync(body, { level: 9, dictionary: DICTIONARY })])
  const payload = toBase64Url(record)
  // a link is offered only when it reads back, so no reader ever meets one this builder wrote and it refuses
  return { link: readGroupLink(payload) ? GROUP_LINK_PREFIX + payload : null, count, privateLeftOut }
}

/**
 * The group a link's fragment (the text after `#`) names, or null for anything the format refuses, a link cut short
 * included: never a part of a group.
 */
export const readGroupLink = (fragment: string): LinkedGroup | null => {
  try {
    if (!/^[\w-]+$/.test(fragment)) return null
    const bytes = fromBase64Url(fragment)
    if (bytes[0] !== VERSION) return null
    const at = { i: 1 }
    const count = readVarint(bytes, at)
    const hashBytes = readVarint(bytes, at)
    if (count < 1 || count > MAX_LINK_TORRENTS) return null
    const hashes = bytes.subarray(at.i, at.i + hashBytes)
    // fflate does not stop at a full `out`: it inflates to the end and drops what does not fit (a stored block throws),
    // so a body that fills MAX_BODY + 1 was longer, and a crafted link costs the time of its whole body
    const body = inflateSync(bytes.subarray(at.i + hashBytes), { dictionary: DICTIONARY, out: new Uint8Array(MAX_BODY + 1) })
    if (body.length > MAX_BODY) return null
    const text = decoder.decode(body)

    let named = 0
    const kinds: number[] = []
    for (let i = 0; i < count; i++) {
      const kind = text.charCodeAt(i)
      if (!(kind >= 1 && kind <= 3)) return null
      kinds.push(kind)
      named += (kind & V1 ? 20 : 0) + (kind & V2 ? 32 : 0)
    }
    if (named !== hashBytes) return null
    const [name, ...lines] = text.slice(count).split('\n')
    if (!name?.trim() || lines.pop() !== '' || lines.length !== count) return null
    if (lines.some((line) => !/^[\x21-\x7e]*$/.test(line) || line.split('&').some(namesTorrent))) return null

    const seen = new Set<string>()
    const torrents: LinkedGroup['torrents'] = []
    let h = 0
    for (const [i, kind] of kinds.entries()) {
      const v1 = kind & V1 ? hexEncode(hashes.subarray(h, (h += 20))) : ''
      const v2 = kind & V2 ? hexEncode(hashes.subarray(h, (h += 32))) : ''
      for (const hash of [v1, v2]) {
        if (!hash) continue
        if (seen.has(hash)) return null
        seen.add(hash)
      }
      const parts = [v1 && `xt=urn:btih:${v1}`, v2 && `xt=urn:btmh:1220${v2}`, lines[i]].filter(Boolean)
      torrents.push({ infoHash: v1 || v2, magnet: `magnet:?${parts.join('&')}` })
    }
    return { name, torrents }
  } catch {
    return null
  }
}
