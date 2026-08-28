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
  /** null when the file list is not knowable without the swarm */
  files: { name: string, size: number }[] | null
}

const DICT = 0x64
const LIST = 0x6c
const INT = 0x69
const END = 0x65
const COLON = 0x3a
const ZERO = 0x30
const NINE = 0x39

type Bencode = number | Uint8Array | Bencode[] | Map<string, Bencode>

/** Decodes one value at `i`, returning it with the offset just past it. Throws on malformed input. */
const decode = (b: Uint8Array, i: number): [Bencode, number] => {
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
 * The infohash is the SHA-1 of the bencoded `info` value EXACTLY as it appears in the file, so its
 * byte range is found rather than the value re-encoded. Bencode is canonical and any normalisation
 * on the way through changes the number, which would then match nothing the engine ever computed.
 */
const infoRange = (b: Uint8Array): [number, number] | null => {
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
    const range = infoRange(bytes)
    if (!range) return null
    const [start, end] = range
    // sliced into its own buffer: subtle.digest wants a BufferSource, and a view over a
    // SharedArrayBuffer is not one, which is reachable here because ripple is cross-origin isolated
    const digest = await crypto.subtle.digest('SHA-1', new Uint8Array(bytes.slice(start, end)).buffer as ArrayBuffer)
    const infoHash = hex(digest)

    const [root] = decode(bytes, 0)
    if (!(root instanceof Map)) return null
    const info = root.get('info')
    if (!(info instanceof Map)) return null

    const name = text(info.get('name')) ?? infoHash
    const fileList = info.get('files')

    let files: { name: string, size: number }[]
    if (Array.isArray(fileList)) {
      // a multi-file torrent: each entry carries its path as a list of components under the name
      files = fileList.flatMap((entry) => {
        if (!(entry instanceof Map)) return []
        const path = entry.get('path')
        const length = entry.get('length')
        if (!Array.isArray(path) || typeof length !== 'number') return []
        const parts = path.map((p) => text(p)).filter((p): p is string => !!p)
        return [{ name: [name, ...parts].join('/'), size: length }]
      })
    } else {
      const length = info.get('length')
      files = typeof length === 'number' ? [{ name, size: length }] : []
    }

    const size = files.reduce((total, file) => total + file.size, 0)
    const params = new URLSearchParams()
    params.set('dn', name)
    for (const tracker of trackers(root)) params.append('tr', tracker)
    const magnet = `magnet:?xt=urn:btih:${infoHash}&${params.toString()}`

    return { magnet, name, size, files: files.length ? files : null }
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
  const magnet = raw.trim()
  const infoHash = magnetInfoHash(magnet)
  if (!infoHash) return null
  return { magnet, name: magnetParam(magnet, 'dn') ?? infoHash, size: 0, files: null }
}
