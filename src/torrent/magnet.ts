/**
 * The torrent a magnet names, as ONE identity string.
 *
 * A magnet can carry two `xt` values: `btih` for the v1 SHA-1 infohash, and `btmh` for the v2
 * SHA-256 one. A hybrid torrent carries both, and they are two names for one torrent rather than
 * two torrents. Ripple keys save paths, library entries, resume blobs and stored source handles on
 * whatever comes back from here, so this has to answer the same string every time or the same
 * torrent gets two identities and neither can find the other's data.
 *
 * V1 WINS WHEREVER THERE IS ONE, regardless of which `xt` appears first. Every client understands
 * it, `savePathFor` already produces 40-character directories, and it is the half of a hybrid the
 * older swarm answers to. Only a v2-only torrent answers with 64 characters.
 *
 * NULL FOR A MAGNET THAT NAMES TWO TORRENTS. `xt` is read as libtorrent reads it (`magnet_uri.cpp`):
 * the name in any case and with a `.<digits>` suffix, the value percent-decoded, its `urn:` prefix in
 * lower case only. libtorrent keeps the LAST v1 and the last v2 it reads, so two different v1 hashes,
 * or two v2, were listed here under one torrent while the engine downloaded the other. One torrent
 * written twice, in hex and base32 or in two cases, is still one, and answers as it is written first.
 */
export const magnetInfoHash = (magnet: string): string | null => {
  const v1: string[] = []
  const v2: string[] = []
  // libtorrent's name runs to the next `=`, so a parameter with none swallows the one after it
  let swallowed = false
  for (const part of magnet.slice(magnet.indexOf('?') + 1).split('&')) {
    const eq = part.indexOf('=')
    if (swallowed || eq < 0) { swallowed = eq < 0; continue }
    if (!/^xt(\.\d*)?$/i.test(part.slice(0, eq))) continue
    let value = part.slice(eq + 1)
    try { value = decodeURIComponent(value) } catch { /* left as written */ }
    // base32 is legal here as well as hex, which is why this is not a hex-only pattern
    const hash = value.match(/^urn:btih:([0-9a-zA-Z]+)/)?.[1]
    if (hash) { v1.push(hash.toLowerCase()); continue }
    const multihash = value.match(/^urn:btmh:([0-9a-fA-F]+)/)?.[1]?.toLowerCase()
    /*
     * `1220` IS NOT PART OF THE ID. It is the multihash prefix: 0x12 for sha2-256, 0x20 for the 32
     * bytes that follow. Keeping it produced a 68-character id, and that had a cost far past being
     * untidy: `opfs-sweep.ts` recognises a save directory by its name being 40 or 64 hex characters,
     * a 68-character one matches neither, and the sweep removed the torrent's whole directory about a
     * minute after the page loaded even though the library still listed it.
     */
    if (multihash) v2.push(multihash.startsWith('1220') && multihash.length === 68 ? multihash.slice(4) : multihash)
  }
  if (new Set(v1.map(hexInfoHash)).size > 1 || new Set(v2).size > 1) return null
  return v1[0] ?? v2[0] ?? null
}

/**
 * Whether the engine can add this magnet: it starts `magnet:?`, names one torrent, and writes that torrent's hash as
 * libtorrent reads one, 40 hex or 32 base32 characters for v1 and 64 hex for v2. A page waiting on a magnet that
 * fails this waits on a torrent the engine never lists.
 */
export const readableMagnet = (magnet: string): boolean => {
  const id = magnetInfoHash(magnet)
  return magnet.startsWith('magnet:?') && id !== null && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(hexInfoHash(id))
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** A v1 infohash as 40 hex characters, from either spelling a magnet may carry: hex, or base32. */
export const hexInfoHash = (infoHash: string): string => {
  const id = infoHash.toLowerCase()
  if (!/^[a-z2-7]{32}$/.test(id)) return id
  let bits = ''
  for (const char of id) bits += BASE32.indexOf(char).toString(2).padStart(5, '0')
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

/** Whether two infohashes name one torrent, each written in hex or base32. */
export const sameInfoHash = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && hexInfoHash(a) === hexInfoHash(b)

/**
 * Every torrent a pasted, typed or dropped text names, each once, as a magnet: words starting `magnet:?`, and a bare info
 * hash (40 hex or 32 base32 characters for v1, 64 hex for v2) as the magnet naming it, as qBittorrent reads one. A
 * magnet also ends where the next starts, since a single-line field joins pasted lines with nothing between them. Any
 * other word is left out.
 */
export const readMagnets = (text: string): string[] => {
  const byTorrent = new Map<string, string>()
  for (const word of text.split(/\s+|(?=magnet:\?)/i)) {
    const magnet = /^magnet:\?/i.test(word) ? word
      : /^([0-9a-f]{40}|[a-z2-7]{32})$/i.test(word) ? `magnet:?xt=urn:btih:${word}`
      : /^[0-9a-f]{64}$/i.test(word) ? `magnet:?xt=urn:btmh:1220${word}`
      : null
    if (!magnet) continue
    const id = hexInfoHash(magnetInfoHash(magnet) ?? magnet)
    if (!byTorrent.has(id)) byTorrent.set(id, magnet)
  }
  return [...byTorrent.values()]
}

/**
 * EVERY value of a repeated magnet key, decoded and in order.
 *
 * `tr` and `ws` are lists by design, so the single-value reader below answers with the first one and
 * quietly loses the rest. A .torrent rebuilt from a magnet that kept one tracker out of five is a
 * worse torrent than the magnet was.
 */
export const magnetParams = (magnet: string, key: string): string[] => {
  const out: string[] = []
  for (const m of magnet.matchAll(new RegExp('[?&]' + key + '=([^&]+)', 'g'))) {
    const raw = m[1]!
    try { out.push(decodeURIComponent(raw.replace(/\+/g, ' '))) } catch { out.push(raw) }
  }
  return [...new Set(out)]
}

/** One query key out of a magnet link, decoded. `dn` is the display name a tracker suggested. */
export const magnetParam = (magnet: string, key: string): string | undefined => {
  const m = magnet.match(new RegExp('[?&]' + key + '=([^&]+)'))
  if (!m) return undefined
  try { return decodeURIComponent(m[1]!.replace(/\+/g, ' ')) } catch { return m[1] }
}
